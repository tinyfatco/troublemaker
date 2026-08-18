import { createHash, randomUUID } from "node:crypto";
import { contextCapability, stablePrivateKey } from "./security.mjs";

export const CLOUDFLARE_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";
const CLOUDFLARE_ANALYTICS_URL = "https://api.cloudflare.com/client/v4/graphql";
const MAXIMUM_USAGE_PARSE_BYTES = 2 * 1024 * 1024;
const PROVIDER_USAGE_QUERY = `
	query HostdWorkersAiUsage(
		$accountTag: string!,
		$start: Time!,
		$end: Time!,
		$models: [string!]
	) {
		viewer {
			accounts(filter: { accountTag: $accountTag }) {
				aiInferenceAdaptiveGroups(
					limit: 1000,
					filter: {
						datetime_geq: $start,
						datetime_lt: $end,
						modelId_in: $models
					},
					orderBy: [datetimeFifteenMinutes_ASC]
				) {
					count
					dimensions {
						datetimeFifteenMinutes
						modelId
						requestSource
						errorCode
					}
					sum {
						totalInputTokens
						totalOutputTokens
						totalNeurons
					}
				}
			}
		}
	}
`;

export class WorkersAiError extends Error {
	constructor(status, code, message = code, { retryAfterSeconds } = {}) {
		super(message);
		this.name = "WorkersAiError";
		this.status = status;
		this.code = code;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

function nonNegativeInteger(value) {
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function nonNegativeNumber(value) {
	return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizedUsage(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const inputTokens = nonNegativeInteger(raw.prompt_tokens ?? raw.input_tokens);
	const outputTokens = nonNegativeInteger(raw.completion_tokens ?? raw.output_tokens);
	const cachedInputTokens = Math.min(
		inputTokens,
		nonNegativeInteger(
			raw.prompt_tokens_details?.cached_tokens
			?? raw.input_tokens_details?.cached_tokens
			?? raw.prompt_cache_hit_tokens,
		),
	);
	const reportedTotal = nonNegativeInteger(raw.total_tokens);
	return {
		inputTokens,
		cachedInputTokens,
		outputTokens,
		totalTokens: Math.max(reportedTotal, inputTokens + outputTokens),
	};
}

function usageFromPayload(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	return normalizedUsage(payload.usage)
		?? normalizedUsage(payload.result?.usage)
		?? normalizedUsage(payload.choices?.[0]?.usage);
}

class WorkersAiUsageCollector {
	constructor(contentType) {
		this.streaming = contentType.toLowerCase().includes("text/event-stream");
		this.decoder = new TextDecoder();
		this.buffer = "";
		this.usage = undefined;
		this.overflowed = false;
	}

	observe(chunk) {
		const text = this.decoder.decode(chunk, { stream: true });
		if (this.streaming) {
			this.#observeSse(text);
			return;
		}
		if (this.overflowed) return;
		this.buffer += text;
		if (this.buffer.length > MAXIMUM_USAGE_PARSE_BYTES) {
			this.buffer = "";
			this.overflowed = true;
		}
	}

	finish() {
		const tail = this.decoder.decode();
		if (this.streaming) {
			this.#observeSse(`${tail}\n`);
		} else if (!this.overflowed) {
			this.buffer += tail;
			try {
				this.#accept(JSON.parse(this.buffer));
			} catch {
				// A provider response without parseable usage still counts as a request.
			}
		}
		return this.usage ?? {
			inputTokens: 0,
			cachedInputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		};
	}

	#observeSse(text) {
		this.buffer += text;
		let newline;
		while ((newline = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") continue;
			try {
				this.#accept(JSON.parse(data));
			} catch {
				// Content chunks are deliberately ignored; only structured usage is retained.
			}
		}
		if (this.buffer.length > MAXIMUM_USAGE_PARSE_BYTES) this.buffer = "";
	}

	#accept(payload) {
		const usage = usageFromPayload(payload);
		if (usage) this.usage = usage;
	}
}

function usageWindowStart(timestamp, windowSeconds) {
	const windowMilliseconds = windowSeconds * 1000;
	return new Date(Math.floor(timestamp / windowMilliseconds) * windowMilliseconds).toISOString();
}

export function resolveContextRuntimeModel(config, store, routingKey, target, contextId) {
	if (!config.workersAi || !routingKey || !target) return undefined;
	const routes = store.listRoutesForContext(contextId, target.id);
	if (routes.length === 0 || routes.some((route) => route.source !== "phone")) return undefined;
	const principalHashes = new Set(routes.map((route) => route.principalHash));
	if (principalHashes.size !== 1) return undefined;
	const [principalHash] = principalHashes;
	const principal = config.routing.knownPhonePrincipals.find((candidate) => (
		candidate.model
		&& stablePrivateKey(routingKey, "phone-principal", candidate.phone) === principalHash
	));
	return principal?.model;
}

export function runtimeModelVersionSuffix(model) {
	if (!model) return "";
	const digest = createHash("sha256")
		.update(`${model.provider}\0${model.id}`)
		.digest("hex")
		.slice(0, 12);
	return `:model-${digest}`;
}

export function runtimeModelEnvironment(config, target, contextId, model) {
	if (!model) return {};
	if (model.provider !== CLOUDFLARE_WORKERS_AI_PROVIDER || !config.workersAi) {
		throw new Error(`unsupported context runtime model ${model.provider}/${model.id}`);
	}
	return {
		MOM_MODEL_PROVIDER: model.provider,
		MOM_MODEL_ID: model.id,
		CLOUDFLARE_API_KEY: contextCapability(target.outboundToken, "workers-ai", contextId),
		CLOUDFLARE_WORKERS_AI_BASE_URL:
			`http://${target.hostGateway}:${config.server.port}/v1/workers-ai/${encodeURIComponent(contextId)}`,
	};
}

export class HostWorkersAi {
	constructor({
		config,
		store,
		routingKey,
		fetchImpl = globalThis.fetch,
		nowImpl = Date.now,
		analyticsUrl = CLOUDFLARE_ANALYTICS_URL,
	}) {
		this.config = config;
		this.store = store;
		this.routingKey = routingKey;
		this.fetch = fetchImpl;
		this.now = nowImpl;
		this.analyticsUrl = analyticsUrl;
		this.analyticsTimer = undefined;
	}

	async start() {
		if (!this.config.workersAi.analyticsToken || this.analyticsTimer) return;
		await this.pollProviderUsageSafely();
		this.analyticsTimer = setInterval(
			() => void this.pollProviderUsageSafely(),
			this.config.workersAi.analyticsPollSeconds * 1000,
		);
		this.analyticsTimer.unref();
	}

	async stop() {
		if (this.analyticsTimer) clearInterval(this.analyticsTimer);
		this.analyticsTimer = undefined;
	}

	async pollProviderUsageSafely() {
		try {
			const rows = await this.pollProviderUsage();
			const timestamp = new Date(this.now()).toISOString();
			this.store.setMeta("workers-ai:last_provider_poll_at", timestamp);
			this.store.setMeta("workers-ai:last_provider_poll_error", "");
			return rows;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.store.setMeta("workers-ai:last_provider_poll_error", message.slice(0, 200));
			console.error("troublemaker-hostd: Workers AI provider usage poll failed:", message);
			return [];
		}
	}

	async pollProviderUsage() {
		const workersAi = this.config.workersAi;
		if (!workersAi.analyticsToken) return [];
		const currentTime = this.now();
		const start = usageWindowStart(
			currentTime - workersAi.analyticsLookbackSeconds * 1000,
			workersAi.limits.windowSeconds,
		);
		const end = new Date(currentTime).toISOString();
		const response = await this.fetch(this.analyticsUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${workersAi.analyticsToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				query: PROVIDER_USAGE_QUERY,
				variables: {
					accountTag: workersAi.accountId,
					start,
					end,
					models: workersAi.allowedModels,
				},
			}),
		});
		if (!response.ok) throw new Error(`Cloudflare analytics returned HTTP ${response.status}`);
		const payload = await response.json();
		if (payload.errors?.length) throw new Error("Cloudflare analytics query returned errors");
		const accounts = payload.data?.viewer?.accounts;
		if (!Array.isArray(accounts) || accounts.length !== 1) {
			throw new Error("Cloudflare analytics account scope was unavailable");
		}
		const groups = accounts[0].aiInferenceAdaptiveGroups;
		if (!Array.isArray(groups)) throw new Error("Cloudflare analytics usage rows were unavailable");
		const aggregated = new Map();
		for (const group of groups) {
			const dimensions = group?.dimensions;
			const sum = group?.sum;
			if (
				!dimensions
				|| typeof dimensions.datetimeFifteenMinutes !== "string"
				|| !workersAi.allowedModels.includes(dimensions.modelId)
			) continue;
			const dimensionTime = Date.parse(dimensions.datetimeFifteenMinutes);
			if (!Number.isFinite(dimensionTime)) continue;
			const row = {
				windowStartedAt: usageWindowStart(dimensionTime, workersAi.limits.windowSeconds),
				model: dimensions.modelId,
				requestSource: typeof dimensions.requestSource === "string"
					? dimensions.requestSource
					: "unknown",
				errorCode: nonNegativeInteger(dimensions.errorCode),
				requestCount: nonNegativeInteger(group.count),
				inputTokens: nonNegativeNumber(sum?.totalInputTokens),
				outputTokens: nonNegativeNumber(sum?.totalOutputTokens),
				neurons: nonNegativeNumber(sum?.totalNeurons),
			};
			const key = JSON.stringify([
				row.windowStartedAt,
				row.model,
				row.requestSource,
				row.errorCode,
			]);
			const current = aggregated.get(key);
			if (current) {
				current.requestCount += row.requestCount;
				current.inputTokens += row.inputTokens;
				current.outputTokens += row.outputTokens;
				current.neurons += row.neurons;
			} else {
				aggregated.set(key, row);
			}
		}
		const rows = [...aggregated.values()];
		this.store.upsertWorkersAiProviderUsage(rows, new Date(currentTime).toISOString());
		return rows;
	}

	async complete(target, contextId, body, signal) {
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			throw new WorkersAiError(400, "workers_ai_body_invalid");
		}
		const selected = resolveContextRuntimeModel(
			this.config,
			this.store,
			this.routingKey,
			target,
			contextId,
		);
		if (!selected) throw new WorkersAiError(403, "workers_ai_context_denied");
		const model = typeof body.model === "string" ? body.model.trim() : "";
		if (!model || model !== selected.id || !this.config.workersAi.allowedModels.includes(model)) {
			throw new WorkersAiError(403, "workers_ai_model_denied");
		}

		const requestId = randomUUID();
		const startedMilliseconds = this.now();
		const startedAt = new Date(startedMilliseconds).toISOString();
		const reservation = this.store.reserveWorkersAiRequest({
			id: requestId,
			targetId: target.id,
			contextId,
			model,
			windowStartedAt: usageWindowStart(
				startedMilliseconds,
				this.config.workersAi.limits.windowSeconds,
			),
			observedAt: startedAt,
			expiresAt: new Date(
				startedMilliseconds + this.config.workersAi.requestTimeoutMs + 5000,
			).toISOString(),
			limits: this.config.workersAi.limits,
		});
		if (!reservation.allowed) {
			throw new WorkersAiError(429, reservation.code, reservation.code, {
				retryAfterSeconds: reservation.retryAfterSeconds,
			});
		}

		const { model: _model, ...input } = body;
		const timeoutSignal = AbortSignal.timeout(this.config.workersAi.requestTimeoutMs);
		const upstreamSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		const headers = {
			authorization: `Bearer ${this.config.workersAi.apiToken}`,
			"content-type": "application/json",
			"cf-aig-collect-log-payload": "false",
			"cf-aig-max-attempts": "1",
			"cf-aig-metadata": JSON.stringify({ service: "hostd", request_id: requestId }),
		};
		if (this.config.workersAi.gatewayId) {
			headers["cf-aig-gateway-id"] = this.config.workersAi.gatewayId;
		}
		const endpoint = `${this.config.workersAi.apiBaseUrl}/accounts/`
			+ `${this.config.workersAi.accountId}/ai/run/${model}`;
		try {
			const upstream = await this.fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(input),
				signal: upstreamSignal,
			});
			return this.trackResponse(requestId, upstream);
		} catch (error) {
			this.store.finishWorkersAiRequest(requestId, {
				status: signal?.aborted ? "aborted" : "failed",
				completedAt: new Date(this.now()).toISOString(),
				error: upstreamSignal.aborted ? "request_aborted" : "upstream_unavailable",
			});
			if (upstreamSignal.aborted) {
				throw new WorkersAiError(504, "workers_ai_timeout");
			}
			throw new WorkersAiError(
				502,
				"workers_ai_unavailable",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	trackResponse(requestId, upstream) {
		const collector = new WorkersAiUsageCollector(
			upstream.headers.get("content-type") || "application/json",
		);
		let settled = false;
		let cancelled = false;
		const settle = (status, error) => {
			if (settled) return;
			settled = true;
			const usage = collector.finish();
			this.store.finishWorkersAiRequest(requestId, {
				status,
				upstreamStatus: upstream.status,
				...usage,
				completedAt: new Date(this.now()).toISOString(),
				error,
			});
		};
		if (!upstream.body) {
			settle(upstream.ok ? "completed" : "failed", upstream.ok ? undefined : `http_${upstream.status}`);
			return upstream;
		}
		const reader = upstream.body.getReader();
		const trackedBody = new ReadableStream({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						settle(
							cancelled ? "aborted" : upstream.ok ? "completed" : "failed",
							cancelled
								? "client_disconnected"
								: upstream.ok ? undefined : `http_${upstream.status}`,
						);
						controller.close();
						return;
					}
					collector.observe(value);
					controller.enqueue(value);
				} catch (error) {
					settle(cancelled ? "aborted" : "failed", cancelled ? "client_disconnected" : "stream_error");
					controller.error(error);
				}
			},
			async cancel(reason) {
				cancelled = true;
				try {
					await reader.cancel(reason);
				} finally {
					settle("aborted", "client_disconnected");
				}
			},
		});
		return new Response(trackedBody, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers,
		});
	}
}
