import { open, mkdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { contextCapability, stablePrivateKey } from "./security.mjs";
import { renewScopedAppScope, ScopedAppAuthorizationError } from "./scoped-app-authorization.mjs";
import { ScopedAppEvidenceError } from "./scoped-app-evidence.mjs";
import { scopedAppScopeKeys, ScopedAppStoreError } from "./scoped-app-store.mjs";

const TERMINAL_TURN_STATES = new Set(["completed", "cancelled", "failed"]);
const HEARTBEAT_INTERVAL_MS = 8_000;
const MAXIMUM_ASSISTANT_TEXT = 65_536;

export class ScopedAppGatewayError extends Error {
	constructor(code, status = 503) {
		super(code);
		this.name = "ScopedAppGatewayError";
		this.code = code;
		this.status = status;
	}
}

function wait(milliseconds, signal) {
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(resolvePromise, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("aborted"));
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

async function replacePrivateFile(path, content) {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	let file;
	try {
		file = await open(temporary, "wx", 0o600);
		await file.chmod(0o600);
		await file.writeFile(content, "utf8");
		await file.sync();
		await file.close();
		file = undefined;
		await rename(temporary, path);
	} catch (error) {
		await file?.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function* sseData(response) {
	if (!response.ok || !response.body) throw new ScopedAppGatewayError("runtime_unavailable", 503);
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of response.body) {
		buffered += decoder.decode(chunk, { stream: true });
		while (true) {
			const boundary = buffered.indexOf("\n\n");
			if (boundary < 0) break;
			const block = buffered.slice(0, boundary);
			buffered = buffered.slice(boundary + 2);
			const data = block.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data) yield data;
		}
	}
	buffered += decoder.decode();
}

function assistantTextFromSnapshot(event) {
	if (event?.type !== "assistant_snapshot" || event.entry?.role !== "assistant") return undefined;
	const text = Array.isArray(event.entry.content)
		? event.entry.content
			.filter((content) => content?.type === "text" && typeof content.text === "string")
			.map((content) => content.text)
			.join("\n")
		: "";
	return text || undefined;
}

export class ScopedAppGateway {
	constructor({ config, store, runtime, routingKey, target, evidence, fetchImpl = fetch }) {
		this.config = config;
		this.store = store;
		this.runtime = runtime;
		this.routingKey = routingKey;
		this.target = target;
		this.evidence = evidence;
		this.fetchImpl = fetchImpl;
		this.activeTurns = new Map();
		this.renewalLocks = new Map();
		this.webchat = undefined;
	}

	setWebchat(webchat) {
		this.webchat = webchat;
	}

	scopeKeys(scope) {
		return scopedAppScopeKeys(this.routingKey, this.target.id, scope);
	}

	async renewScope(scope) {
		const renewed = await renewScopedAppScope(this.config, scope, { fetchImpl: this.fetchImpl });
		const keys = this.scopeKeys(renewed);
		this.store.acceptMembership(keys.accountKey, keys.membershipKey, renewed.membershipVersion);
		return { scope: renewed, keys };
	}

	async dispatch(envelope, purpose, rawBody) {
		if (envelope.operation === "scope.revoke") {
			if (purpose !== "revoke") throw new ScopedAppGatewayError("forbidden", 403);
			return await this.revoke(envelope);
		}
		if (purpose !== "dispatch") throw new ScopedAppGatewayError("forbidden", 403);
		const { scope, keys } = await this.renewScope(envelope.scope);
		const claimed = this.store.claimRequest({
			requestId: envelope.requestId,
			operation: envelope.operation,
			scopeKey: keys.contextId,
			body: rawBody,
		});
		if (!claimed.claimed) {
			if (claimed.status === "completed") return claimed.response;
			throw new ScopedAppGatewayError("conflict", 409);
		}
		try {
			const response = await this.execute({ ...envelope, scope }, keys);
			return this.store.completeRequest(envelope.requestId, response);
		} catch (error) {
			this.store.failRequest(envelope.requestId);
			throw error;
		}
	}

	async execute(envelope, keys) {
		switch (envelope.operation) {
			case "capabilities":
				return {
					runtime: "hostd",
					protocol: "vectors.v1",
					durableChat: true,
					contextCas: true,
					revocation: true,
					cua: this.target.computer?.enabled === true && this.evidence?.available === true,
				};
			case "context.read":
				return this.store.readContext(keys.accountKey);
			case "context.write":
				if (
					this.store.activeTurnsForAccount(keys.accountKey).length > 0
					|| this.webchat?.hasActiveAccount(keys.accountKey)
				) {
					throw new ScopedAppGatewayError("conflict", 409);
				}
				return this.store.writeContext(
					keys.accountKey,
					envelope.payload.markdown,
					envelope.payload.expectedRevision,
				);
			case "chat.events":
				return this.store.listEvents(keys.contextId, envelope.payload.after);
			case "chat.cancel":
				await this.cancelTurn(keys.contextId, envelope.payload.turnId, "user_cancelled");
				return { turnId: envelope.payload.turnId, status: "cancelled" };
			case "chat.send":
				return this.queueTurn(envelope.scope, keys, envelope.payload);
			case "evidence.capture":
				return await this.captureEvidence(envelope, keys);
			case "evidence.read":
				return this.store.readEvidence(
					envelope.payload.artifactId,
					keys.contextId,
					keys.accountKey,
					keys.userKey,
				);
			case "artifact.read":
				return this.store.readArtifact(
					envelope.payload.artifactId,
					keys.contextId,
					keys.accountKey,
					keys.userKey,
				);
			default:
				throw new ScopedAppGatewayError("invalid", 400);
		}
	}

	async renewEvidenceScope(scope, expectedKeys) {
		const renewed = await this.renewScope(scope);
		if (
			renewed.keys.contextId !== expectedKeys.contextId
			|| renewed.keys.accountKey !== expectedKeys.accountKey
			|| renewed.keys.userKey !== expectedKeys.userKey
			|| renewed.keys.membershipKey !== expectedKeys.membershipKey
		) throw new ScopedAppAuthorizationError("renewal_scope_mismatch", 403);
		return renewed.scope;
	}

	async captureEvidence(envelope, keys) {
		if (!this.evidence?.available) throw new ScopedAppGatewayError("unavailable", 503);
		if (
			this.store.activeTurnsForContext(keys.contextId).length > 0
			|| this.activeTurns.has(keys.contextId)
			|| this.webchat?.hasActiveTurn(keys.contextId)
		) {
			throw new ScopedAppGatewayError("conflict", 409);
		}
		let currentScope = envelope.scope;
		const source = await this.evidence.verifySource(envelope.payload);
		currentScope = await this.renewEvidenceScope(currentScope, keys);
		const evidenceTurn = this.store.startEvidenceTurn({
			contextId: keys.contextId,
			turnId: envelope.payload.turnId,
			accountKey: keys.accountKey,
			userKey: keys.userKey,
			membershipKey: keys.membershipKey,
			membershipVersion: currentScope.membershipVersion,
			request: JSON.stringify(envelope.payload),
			scope: currentScope,
		});
		if (evidenceTurn.duplicate && evidenceTurn.status === "completed") {
			return { status: "queued", turnId: envelope.payload.turnId };
		}
		const artifactId = stablePrivateKey(
			this.routingKey,
			"scoped-app-evidence",
			envelope.requestId,
		).slice(0, 40);
		const controller = new AbortController();
		this.activeTurns.set(keys.contextId, {
			turnId: envelope.payload.turnId,
			scope: currentScope,
			keys,
			controller,
		});
		void this.runEvidenceCapture(
			keys.contextId,
			envelope.payload.turnId,
			envelope.payload,
			source,
			artifactId,
		).catch(() => undefined);
		return { status: "queued", turnId: envelope.payload.turnId };
	}

	async runEvidenceCapture(contextId, turnId, payload, source, artifactId) {
		const active = this.activeTurns.get(contextId);
		if (!active || active.turnId !== turnId) return;
		const heartbeat = this.heartbeat(contextId, active.controller.signal).catch((error) => {
			if (!active.controller.signal.aborted) active.controller.abort(error);
		});
		try {
			let currentScope = await this.renewActiveTurn(contextId);
			const captured = await this.evidence.capture(contextId, {
				artifactId,
				accountId: currentScope.accountId,
				userId: currentScope.userId,
				turnId,
				grantId: payload.grantId,
				field: payload.field,
				exactQuote: payload.exactQuote,
				sourceUrl: source.sourceUrl,
				sourceSha256: source.sourceSha256,
			});
			if (active.controller.signal.aborted) throw active.controller.signal.reason;
			currentScope = await this.renewActiveTurn(contextId);
			const current = this.store.getTurn(contextId, turnId);
			if (!current || current.status !== "running") throw new ScopedAppAuthorizationError();
			this.store.putEvidence({
				artifactId,
				contextId,
				accountKey: active.keys.accountKey,
				userKey: active.keys.userKey,
				turnId,
				receipt: captured.receipt,
				artifact: captured.artifact,
			});
			this.store.appendEvent(contextId, turnId, "evidence", undefined, { artifactId });
			this.store.setTurnStatus(contextId, turnId, "completed", { clearScope: true });
		} catch (error) {
			console.error(
				"troublemaker-hostd: scoped evidence capture failed:",
				error instanceof Error ? error.message : String(error),
			);
			const current = this.store.getTurn(contextId, turnId);
			if (current && !TERMINAL_TURN_STATES.has(current.status)) {
				this.store.setTurnStatus(contextId, turnId, "failed", {
					error: error instanceof ScopedAppAuthorizationError ? "authorization_revoked" : "evidence_failed",
					clearScope: true,
				});
			}
		} finally {
			active.controller.abort(new Error("evidence finished"));
			await heartbeat.catch(() => undefined);
			if (this.activeTurns.get(contextId) === active) this.activeTurns.delete(contextId);
		}
	}

	async revoke(envelope) {
		if (!["owner", "admin"].includes(envelope.scope.role)) {
			throw new ScopedAppGatewayError("forbidden", 403);
		}
		const { scope, keys: initiator } = await this.renewScope(envelope.scope);
		const targetKeys = this.scopeKeys({
			...scope,
			membershipId: envelope.payload.membershipId,
			membershipVersion: envelope.payload.membershipVersion,
		});
		this.store.revokeMembership(
			initiator.accountKey,
			targetKeys.membershipKey,
			envelope.payload.membershipVersion,
		);
		for (const turn of this.store.activeTurnsForMembership(
			initiator.accountKey,
			targetKeys.membershipKey,
			envelope.payload.membershipVersion,
		)) {
			await this.cancelTurn(turn.contextId, turn.turnId, "membership_revoked", { revocation: true });
		}
		await this.webchat?.revokeMembership(
			initiator.accountKey,
			targetKeys.membershipKey,
			envelope.payload.membershipVersion,
		);
		return { revoked: true };
	}

	queueTurn(scope, keys, payload) {
		if (this.webchat?.hasActiveTurn(keys.contextId)) {
			throw new ScopedAppGatewayError("conflict", 409);
		}
		const turn = this.store.startTurn({
			contextId: keys.contextId,
			turnId: payload.turnId,
			accountKey: keys.accountKey,
			userKey: keys.userKey,
			membershipKey: keys.membershipKey,
			membershipVersion: scope.membershipVersion,
			text: payload.text,
			scope,
		});
		if (!turn.duplicate) {
			const controller = new AbortController();
			this.activeTurns.set(keys.contextId, {
				turnId: payload.turnId,
				scope,
				keys,
				controller,
			});
			void this.runTurn(keys.contextId, payload.turnId, payload.text).catch(() => undefined);
		}
		return {
			turnId: payload.turnId,
			status: turn.status,
			events: [],
		};
	}

	async renewActiveTurn(contextId) {
		const active = this.activeTurns.get(contextId);
		if (!active) throw new ScopedAppAuthorizationError();
		const existing = this.renewalLocks.get(contextId);
		if (existing) return await existing;
		const renewal = (async () => {
			const { scope, keys } = await this.renewScope(active.scope);
			if (
				keys.contextId !== contextId
				|| keys.accountKey !== active.keys.accountKey
				|| keys.userKey !== active.keys.userKey
				|| keys.membershipKey !== active.keys.membershipKey
			) throw new ScopedAppAuthorizationError("renewal_scope_mismatch", 403);
			active.scope = scope;
			this.store.updateTurnScope(contextId, active.turnId, scope);
			return scope;
		})();
		this.renewalLocks.set(contextId, renewal);
		try {
			return await renewal;
		} finally {
			if (this.renewalLocks.get(contextId) === renewal) this.renewalLocks.delete(contextId);
		}
	}

	async authorizeRuntime(contextId) {
		if (this.webchat?.hasActiveTurn(contextId)) {
			return await this.webchat.authorizeRuntime(contextId);
		}
		const scope = await this.renewActiveTurn(contextId);
		return { ok: true, expiresAt: scope.expiresAt };
	}

	async heartbeat(contextId, signal) {
		while (!signal.aborted) {
			await wait(HEARTBEAT_INTERVAL_MS, signal);
			if (signal.aborted) return;
			await this.renewActiveTurn(contextId);
		}
	}

	async materializeOrganizationContext(accountKey) {
		const root = resolve(this.config.organizationsDirectory);
		const directory = resolve(root, accountKey);
		if (!`${directory}/`.startsWith(`${root}/`)) throw new ScopedAppGatewayError("unavailable", 503);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const document = this.store.readContext(accountKey);
		const path = join(directory, "CONTEXT.md");
		await replacePrivateFile(path, document.markdown);
		return { path, revision: document.revision, sha256: document.sha256, organizationKey: accountKey };
	}

	async runTurn(contextId, turnId, text) {
		const active = this.activeTurns.get(contextId);
		if (!active || active.turnId !== turnId) return;
		this.store.setTurnStatus(contextId, turnId, "running");
		let runtime;
		const heartbeat = this.heartbeat(contextId, active.controller.signal).catch((error) => {
			if (!active.controller.signal.aborted) active.controller.abort(error);
		});
		try {
			await this.renewActiveTurn(contextId);
			const organization = await this.materializeOrganizationContext(active.keys.accountKey);
			runtime = await this.runtime.ensureScopedOciContext(this.target, contextId, organization);
			const response = await this.fetchImpl(
				`http://127.0.0.1:${runtime.port}/api/v2/agents/current/messages`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${contextCapability(this.target.inboundToken, "web-app", contextId)}`,
						"content-type": "application/json",
						accept: "text/event-stream",
					},
					body: JSON.stringify({
						message: text,
						channelId: `scoped-app:${active.keys.accountKey}`,
						source: "web",
						sourceEventType: "scoped_app",
					}),
					signal: active.controller.signal,
				},
			);
			let assistantText = "";
			for await (const data of sseData(response)) {
				if (data === "[DONE]") continue;
				let event;
				try {
					event = JSON.parse(data);
				} catch {
					throw new ScopedAppGatewayError("runtime_unavailable", 503);
				}
				const snapshot = assistantTextFromSnapshot(event);
				if (snapshot !== undefined) assistantText = snapshot;
				else if (event?.type === "text_delta" && typeof event.delta === "string") assistantText += event.delta;
				else if (event?.type === "text_patch" && typeof event.text === "string") assistantText = event.text;
				else if (event?.type === "error") throw new ScopedAppGatewayError("runtime_unavailable", 503);
			}
			if (assistantText.length > MAXIMUM_ASSISTANT_TEXT) {
				throw new ScopedAppGatewayError("runtime_response_too_large", 503);
			}
			if (assistantText) {
				this.store.appendEvent(contextId, turnId, "message", assistantText, { role: "assistant" });
			}
			this.store.setTurnStatus(contextId, turnId, "completed", { clearScope: true });
		} catch (error) {
			const current = this.store.getTurn(contextId, turnId);
			if (current && !TERMINAL_TURN_STATES.has(current.status)) {
				const revoked = error instanceof ScopedAppAuthorizationError;
				if (revoked) {
					this.store.appendEvent(contextId, turnId, "revocation", undefined, { status: "cancelled" });
				}
				this.store.setTurnStatus(contextId, turnId, revoked ? "cancelled" : "failed", {
					error: revoked ? "authorization_revoked" : "runtime_failed",
					clearScope: true,
				});
			}
		} finally {
			active.controller.abort(new Error("turn finished"));
			await heartbeat.catch(() => undefined);
			await this.runtime.stopScopedOciContext?.(this.target, contextId).catch(() => undefined);
			if (this.activeTurns.get(contextId) === active) this.activeTurns.delete(contextId);
		}
	}

	async recoverInterrupted() {
		const interrupted = this.store.recoverInterruptedTurns();
		for (const turn of interrupted) {
			await this.runtime.stopScopedOciContext?.(this.target, turn.contextId).catch(() => undefined);
		}
		return interrupted;
	}

	async shutdown() {
		const active = [...this.activeTurns.entries()];
		for (const [contextId, turn] of active) {
			await this.cancelTurn(contextId, turn.turnId, "host_shutdown");
		}
	}

	async cancelTurn(contextId, turnId, reason, { revocation = false } = {}) {
		const current = this.store.getTurn(contextId, turnId);
		if (!current) return;
		if (TERMINAL_TURN_STATES.has(current.status)) return;
		const active = this.activeTurns.get(contextId);
		if (active?.turnId === turnId) active.controller.abort(new Error(reason));
		if (revocation) {
			this.store.appendEvent(contextId, turnId, "revocation", undefined, { status: "cancelled" });
		}
		this.store.setTurnStatus(contextId, turnId, "cancelled", {
			error: reason,
			clearScope: true,
		});
		await this.runtime.stopScopedOciContext?.(this.target, contextId).catch(() => undefined);
	}
}

export function scopedAppGatewayError(error) {
	if (error instanceof ScopedAppGatewayError) return error;
	if (error instanceof ScopedAppAuthorizationError) {
		return new ScopedAppGatewayError(error.status === 503 ? "unavailable" : "forbidden", error.status);
	}
	if (error instanceof ScopedAppEvidenceError) {
		return new ScopedAppGatewayError(error.status === 400 ? "invalid" : "unavailable", error.status);
	}
	if (error instanceof ScopedAppStoreError) {
		if (error.status === 429) return new ScopedAppGatewayError("rate_limited", 429);
		if (error.status === 403) return new ScopedAppGatewayError("forbidden", 403);
		if (error.status === 404) return new ScopedAppGatewayError("invalid", 400);
		return new ScopedAppGatewayError("conflict", 409);
	}
	return new ScopedAppGatewayError("unavailable", 503);
}
