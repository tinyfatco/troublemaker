import { randomUUID } from "node:crypto";
import {
	HOSTD_OPENAI_MODEL,
	HOSTD_OPENAI_PROVIDER,
	HOSTD_OPENAI_THINKING,
	resolveContextRuntimeModel,
} from "./runtime-model.mjs";
import { contextCapability } from "./security.mjs";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODEL_CONTEXT_TOKENS = 1_050_000;
const LONG_CONTEXT_THRESHOLD = 272_000;
const MAXIMUM_USAGE_PARSE_BYTES = 2 * 1024 * 1024;
const MICROS_PER_DOLLAR = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000;
const STANDARD_RATES = Object.freeze({
	input: 200_000,
	cachedInput: 20_000,
	cacheWrite: 250_000,
	output: 1_200_000,
});
const LONG_CONTEXT_RATES = Object.freeze({
	input: 400_000,
	cachedInput: 40_000,
	cacheWrite: 500_000,
	output: 1_800_000,
});
const ALLOWED_BODY_FIELDS = new Set([
	"model",
	"input",
	"stream",
	"store",
	"prompt_cache_key",
	"prompt_cache_retention",
	"prompt_cache_options",
	"max_output_tokens",
	"temperature",
	"service_tier",
	"tools",
	"tool_choice",
	"reasoning",
	"include",
	"text",
	"parallel_tool_calls",
]);

export class OpenAiError extends Error {
	constructor(status, code, message = code, { retryAfterSeconds } = {}) {
		super(message);
		this.name = "OpenAiError";
		this.status = status;
		this.code = code;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

function nonNegativeInteger(value) {
	return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function pricedTokens(tokens, rateMicrodollarsPerMillion) {
	return Math.ceil(tokens * rateMicrodollarsPerMillion / TOKENS_PER_MILLION);
}

export function worstCaseOpenAiReservationMicrodollars(maximumOutputTokens) {
	return pricedTokens(MODEL_CONTEXT_TOKENS, LONG_CONTEXT_RATES.cacheWrite)
		+ pricedTokens(maximumOutputTokens, LONG_CONTEXT_RATES.output);
}

export function openAiUsageMicrodollars(usage) {
	const inputTokens = nonNegativeInteger(usage.inputTokens);
	const cachedInputTokens = Math.min(inputTokens, nonNegativeInteger(usage.cachedInputTokens));
	const cacheWriteTokens = Math.min(
		inputTokens - cachedInputTokens,
		nonNegativeInteger(usage.cacheWriteTokens),
	);
	const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheWriteTokens);
	const outputTokens = nonNegativeInteger(usage.outputTokens);
	const rates = inputTokens > LONG_CONTEXT_THRESHOLD ? LONG_CONTEXT_RATES : STANDARD_RATES;
	return pricedTokens(uncachedInputTokens, rates.input)
		+ pricedTokens(cachedInputTokens, rates.cachedInput)
		+ pricedTokens(cacheWriteTokens, rates.cacheWrite)
		+ pricedTokens(outputTokens, rates.output);
}

function normalizedUsage(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const inputTokens = nonNegativeInteger(raw.input_tokens);
	const outputTokens = nonNegativeInteger(raw.output_tokens);
	const details = raw.input_tokens_details;
	const cachedInputTokens = Math.min(
		inputTokens,
		nonNegativeInteger(details?.cached_tokens),
	);
	const cacheWriteTokens = Math.min(
		inputTokens - cachedInputTokens,
		nonNegativeInteger(details?.cache_write_tokens ?? details?.cache_creation_tokens),
	);
	return {
		inputTokens,
		cachedInputTokens,
		cacheWriteTokens,
		outputTokens,
		totalTokens: Math.max(nonNegativeInteger(raw.total_tokens), inputTokens + outputTokens),
	};
}

class OpenAiUsageCollector {
	constructor() {
		this.decoder = new TextDecoder();
		this.buffer = "";
		this.usage = undefined;
		this.terminal = false;
		this.model = undefined;
		this.overflowed = false;
	}

	observe(chunk) {
		if (this.overflowed) return;
		this.buffer += this.decoder.decode(chunk, { stream: true });
		this.#consumeLines();
		if (this.buffer.length > MAXIMUM_USAGE_PARSE_BYTES) {
			this.buffer = "";
			this.overflowed = true;
		}
	}

	finish() {
		if (!this.overflowed) {
			this.buffer += this.decoder.decode();
			this.buffer += "\n";
			this.#consumeLines();
		}
		return {
			usage: this.usage,
			terminal: this.terminal,
			model: this.model,
		};
	}

	#consumeLines() {
		let newline;
		while ((newline = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newline).replace(/\r$/, "");
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (!data || data === "[DONE]") continue;
			try {
				const payload = JSON.parse(data);
				if (!["response.completed", "response.incomplete", "response.failed"].includes(payload?.type)) {
					continue;
				}
				this.terminal = true;
				this.model = typeof payload.response?.model === "string"
					? payload.response.model
					: undefined;
				this.usage = normalizedUsage(payload.response?.usage);
			} catch {
				// Only the terminal structured usage event is retained.
			}
		}
	}
}

function monthStart(timestamp) {
	const date = new Date(timestamp);
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

function validateTools(tools) {
	if (tools === undefined) return;
	if (!Array.isArray(tools)) throw new OpenAiError(400, "openai_tools_invalid");
	for (const tool of tools) {
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
			throw new OpenAiError(400, "openai_tools_invalid");
		}
		if (!["function", "custom"].includes(tool.type)) {
			throw new OpenAiError(403, "openai_hosted_tool_denied");
		}
	}
}

function validateToolChoice(toolChoice) {
	if (toolChoice === undefined) return;
	if (typeof toolChoice === "string") {
		if (["auto", "none", "required"].includes(toolChoice)) return;
		throw new OpenAiError(403, "openai_tool_choice_denied");
	}
	if (
		!toolChoice
		|| typeof toolChoice !== "object"
		|| Array.isArray(toolChoice)
		|| !["function", "custom"].includes(toolChoice.type)
	) {
		throw new OpenAiError(403, "openai_tool_choice_denied");
	}
}

function validateAndPinBody(body, maximumOutputTokens) {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new OpenAiError(400, "openai_body_invalid");
	}
	for (const key of Object.keys(body)) {
		if (!ALLOWED_BODY_FIELDS.has(key)) {
			throw new OpenAiError(400, "openai_field_denied");
		}
	}
	if (body.model !== HOSTD_OPENAI_MODEL) {
		throw new OpenAiError(403, "openai_model_denied");
	}
	if (body.stream !== true) throw new OpenAiError(400, "openai_stream_required");
	if (body.store !== false) throw new OpenAiError(400, "openai_store_must_be_false");
	if (
		!body.reasoning
		|| typeof body.reasoning !== "object"
		|| Array.isArray(body.reasoning)
		|| body.reasoning.effort !== HOSTD_OPENAI_THINKING
	) {
		throw new OpenAiError(403, "openai_max_thinking_required");
	}
	if (body.service_tier !== undefined && body.service_tier !== "default") {
		throw new OpenAiError(403, "openai_service_tier_denied");
	}
	if (body.include !== undefined && (
		!Array.isArray(body.include)
		|| body.include.some((value) => value !== "reasoning.encrypted_content")
	)) {
		throw new OpenAiError(403, "openai_include_denied");
	}
	validateTools(body.tools);
	validateToolChoice(body.tool_choice);
	const requestedMaximum = body.max_output_tokens === undefined
		? maximumOutputTokens
		: body.max_output_tokens;
	if (
		!Number.isInteger(requestedMaximum)
		|| requestedMaximum < 16
		|| requestedMaximum > maximumOutputTokens
	) {
		throw new OpenAiError(400, "openai_output_bound_invalid");
	}
	return {
		...body,
		model: HOSTD_OPENAI_MODEL,
		reasoning: { ...body.reasoning, effort: HOSTD_OPENAI_THINKING },
		max_output_tokens: requestedMaximum,
		stream: true,
		store: false,
		service_tier: "default",
	};
}

export class HostOpenAi {
	constructor({ config, store, fetchImpl = globalThis.fetch, nowImpl = Date.now }) {
		this.config = config;
		this.store = store;
		this.fetch = fetchImpl;
		this.now = nowImpl;
	}

	async complete(target, contextId, body, signal) {
		const context = this.store.getContext(contextId);
		if (!context || context.targetId !== target.id) {
			throw new OpenAiError(403, "openai_context_denied");
		}
		const selected = resolveContextRuntimeModel(
			this.config,
			this.store,
			undefined,
			target,
			contextId,
		);
		if (
			selected?.provider !== HOSTD_OPENAI_PROVIDER
			|| selected.id !== HOSTD_OPENAI_MODEL
			|| selected.thinking !== HOSTD_OPENAI_THINKING
		) {
			throw new OpenAiError(403, "openai_context_denied");
		}
		const input = validateAndPinBody(body, this.config.openAi.maximumOutputTokens);
		if (typeof input.prompt_cache_key === "string" && input.prompt_cache_key) {
			input.prompt_cache_key = contextCapability(
				target.outboundToken,
				"openai-prompt-cache",
				`${contextId}\0${input.prompt_cache_key}`,
			);
		}
		const requestId = randomUUID();
		const startedMilliseconds = this.now();
		const startedAt = new Date(startedMilliseconds).toISOString();
		const reservedMicrodollars = worstCaseOpenAiReservationMicrodollars(
			this.config.openAi.maximumOutputTokens,
		);
		const reservation = this.store.reserveOpenAiRequest({
			id: requestId,
			targetId: target.id,
			contextId,
			model: HOSTD_OPENAI_MODEL,
			monthStartedAt: monthStart(startedMilliseconds),
			observedAt: startedAt,
			expiresAt: new Date(
				startedMilliseconds + this.config.openAi.requestTimeoutMs + 5000,
			).toISOString(),
			reservedMicrodollars,
			monthlySpendCapCents: this.config.openAi.monthlySpendCapCents,
			maximumConcurrentPerContext: this.config.openAi.maximumConcurrentPerContext,
			maximumConcurrentGlobal: this.config.openAi.maximumConcurrentGlobal,
		});
		if (!reservation.allowed) {
			throw new OpenAiError(429, reservation.code, reservation.code, {
				retryAfterSeconds: reservation.retryAfterSeconds,
			});
		}

		const timeoutSignal = AbortSignal.timeout(this.config.openAi.requestTimeoutMs);
		const upstreamSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const upstream = await this.fetch(OPENAI_RESPONSES_URL, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.config.openAi.apiKey}`,
					"content-type": "application/json",
					"x-client-request-id": requestId,
				},
				body: JSON.stringify(input),
				signal: upstreamSignal,
			});
			return this.trackResponse(requestId, reservedMicrodollars, upstream);
		} catch (error) {
			this.store.finishOpenAiRequest(requestId, {
				status: "uncertain",
				chargedMicrodollars: reservedMicrodollars,
				completedAt: new Date(this.now()).toISOString(),
				error: upstreamSignal.aborted ? "request_aborted" : "upstream_result_uncertain",
			});
			throw new OpenAiError(
				409,
				"openai_result_uncertain",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	trackResponse(requestId, reservedMicrodollars, upstream) {
		const contentType = upstream.headers.get("content-type") || "";
		const collector = new OpenAiUsageCollector();
		let settled = false;
		let cancelled = false;
		const settle = (error) => {
			if (settled) return;
			settled = true;
			const collected = collector.finish();
			const exactResponse = upstream.ok
				&& contentType.toLowerCase().includes("text/event-stream")
				&& collected.terminal
				&& collected.usage
				&& collected.model === HOSTD_OPENAI_MODEL
				&& !cancelled;
			this.store.finishOpenAiRequest(requestId, {
				status: exactResponse ? "settled" : "uncertain",
				chargedMicrodollars: exactResponse
					? openAiUsageMicrodollars(collected.usage)
					: reservedMicrodollars,
				upstreamStatus: upstream.status,
				...(collected.usage ?? {}),
				completedAt: new Date(this.now()).toISOString(),
				error: exactResponse ? undefined : error || "usage_or_model_unverified",
			});
		};
		if (!upstream.body) {
			settle(`http_${upstream.status}_without_body`);
			return upstream;
		}
		const reader = upstream.body.getReader();
		const trackedBody = new ReadableStream({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						settle(upstream.ok ? undefined : `http_${upstream.status}`);
						controller.close();
						return;
					}
					collector.observe(value);
					controller.enqueue(value);
				} catch (error) {
					settle(cancelled ? "client_disconnected" : "stream_result_uncertain");
					controller.error(error);
				}
			},
			async cancel(reason) {
				cancelled = true;
				try {
					await reader.cancel(reason);
				} finally {
					settle("client_disconnected");
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

export const OPENAI_COST_ACCOUNTING = Object.freeze({
	microdollarsPerDollar: MICROS_PER_DOLLAR,
	modelContextTokens: MODEL_CONTEXT_TOKENS,
	longContextThreshold: LONG_CONTEXT_THRESHOLD,
	standardRates: STANDARD_RATES,
	longContextRates: LONG_CONTEXT_RATES,
});
