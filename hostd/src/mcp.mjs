import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { relationshipOperatorContextId } from "./relationship-context.mjs";
import { contextCapability, openPrivateValue, sealPrivateValue } from "./security.mjs";

export const MCP_RELATIONSHIP_PROFILE = "relationship-operator-v1";
const MCP_PROTOCOL_VERSION = "2025-06-18";

export class HostMcpError extends Error {
	constructor(code, status = 400) {
		super(code);
		this.name = "HostMcpError";
		this.code = code;
		this.status = status;
	}
}

function secret(prefix) {
	return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function digest(value) {
	return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeEqual(left, right) {
	const actual = Buffer.from(String(left || ""), "utf8");
	const expected = Buffer.from(String(right || ""), "utf8");
	return actual.length === expected.length && actual.length > 0 && timingSafeEqual(actual, expected);
}

function boundedText(value, label, maximum = 120) {
	if (typeof value !== "string") throw new HostMcpError(`${label}_required`);
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
		throw new HostMcpError(`${label}_invalid`);
	}
	return normalized;
}

function boundedInstruction(value) {
	if (typeof value !== "string") throw new HostMcpError("instruction_required");
	const normalized = value.replace(/\r\n?/g, "\n").trim();
	if (
		!normalized
		|| normalized.length > 8_000
		|| /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
	) throw new HostMcpError("instruction_invalid");
	return normalized;
}

function idempotencyKey(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
		throw new HostMcpError("idempotency_key_invalid");
	}
	return value;
}

export function normalizeMcpServerUrl(value) {
	const raw = boundedText(value, "server_url", 2048);
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new HostMcpError("server_url_invalid");
	}
	if (
		url.protocol !== "https:"
		|| url.username
		|| url.password
		|| url.search
		|| url.hash
		|| !url.hostname
	) {
		throw new HostMcpError("server_url_invalid");
	}
	return url.toString();
}

function normalizeHeaderName(value) {
	const name = boundedText(value, "header_name", 80).toLowerCase();
	if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
		throw new HostMcpError("header_name_invalid");
	}
	const forbidden = new Set([
		"authorization",
		"connection",
		"content-length",
		"content-type",
		"cookie",
		"host",
		"proxy-authorization",
		"transfer-encoding",
	]);
	if (
		forbidden.has(name)
		|| name.startsWith("cf-")
		|| name.startsWith("sec-")
		|| name.startsWith("x-forwarded-")
		|| name.startsWith("x-tinyfat-")
	) {
		throw new HostMcpError("header_name_forbidden");
	}
	return name;
}

function aliasFor(displayName, id) {
	const base = displayName.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 35) || "connected-mcp";
	return `${base}-${id.replaceAll("-", "").slice(0, 8)}`;
}

function bearerToken(header) {
	const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
	return match?.[1] || "";
}

function publicRelationship(relationship) {
	return {
		id: relationship.id,
		source: relationship.source,
		label: relationship.recipientHint
			? `Verified ${relationship.source} relationship ${relationship.recipientHint}`
			: `Verified ${relationship.source} relationship`,
		recipient_hint: relationship.recipientHint || undefined,
		profile: relationship.profile,
	};
}

function publicInboundGrant(grant, relationship, publicBaseUrl) {
	return {
		id: grant.id,
		direction: "inbound",
		name: grant.displayName,
		status: grant.status,
		profile: grant.profile,
		relationship: relationship ? publicRelationship(relationship) : undefined,
		server_url: `${publicBaseUrl}/resources/${encodeURIComponent(grant.id)}`,
		created_at: grant.createdAt,
		last_used_at: grant.lastUsedAt,
	};
}

function publicOutboundConnection(connection, relationship) {
	return {
		id: connection.id,
		direction: "outbound",
		alias: connection.alias,
		name: connection.displayName,
		server_url: connection.upstreamUrl,
		auth_type: connection.authType,
		header_name: connection.headerName,
		status: connection.status,
		relationship: relationship ? publicRelationship(relationship) : undefined,
		created_at: connection.createdAt,
		last_used_at: connection.lastUsedAt,
	};
}

function jsonRpcResult(id, result) {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

function jsonRpcError(id, code, message) {
	return new Response(JSON.stringify({
		jsonrpc: "2.0",
		id: id ?? null,
		error: { code, message },
	}), {
		status: 200,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

function handoffToken(value) {
	return /^tfat_one_[A-Za-z0-9_-]{43}$/.test(value || "");
}

function handoffSessionToken(value) {
	return /^tfat_session_[A-Za-z0-9_-]{43}$/.test(value || "");
}

export class HostMcp {
	constructor({ config, store, routingKey, runtime, onContextChanged, onEventQueued } = {}) {
		this.config = config;
		this.store = store;
		this.routingKey = routingKey;
		this.runtime = runtime;
		this.onContextChanged = onContextChanged;
		this.onEventQueued = onEventQueued;
	}

	setEventPump(pump) {
		this.onEventQueued = pump;
	}

	relationshipContextId(route) {
		return relationshipOperatorContextId(this.routingKey, {
			targetId: route.targetId,
			source: route.source,
			providerThreadId: route.providerThreadId,
			principalHash: route.principalHash,
			projectSlug: route.projectSlug,
		});
	}

	resolveRelationship(target, contextId) {
		const context = this.store.getContext(contextId);
		if (!context || context.targetId !== target.id) throw new HostMcpError("context_not_found", 404);
		const routes = this.store.listRoutesForContext(contextId, target.id);
		if (routes.length === 0) throw new HostMcpError("relationship_not_found", 409);
		if (routes.length !== 1) throw new HostMcpError("relationship_ambiguous", 409);
		const route = routes[0];
		if (
			!this.store.hasRouteParticipant(route.source, route.providerThreadId, route.principalHash)
			|| this.store.countRouteParticipants(route.source, route.providerThreadId) !== 1
		) {
			throw new HostMcpError("relationship_unverified", 409);
		}
		if (this.relationshipContextId(route) !== contextId) {
			throw new HostMcpError("relationship_context_migration_required", 409);
		}
		let recipientHint;
		if (route.source === "phone") {
			const conversation = this.store.getPhoneConversationByProviderThread(route.providerThreadId);
			if (
				!conversation
				|| conversation.status !== "active"
				|| conversation.principalHash !== route.principalHash
				|| conversation.targetId !== route.targetId
				|| conversation.contextId !== route.contextId
			) throw new HostMcpError("relationship_unverified", 409);
			recipientHint = `ending ${conversation.contactLastFour}`;
		}
		try {
			return this.store.bindMcpRelationship({
				source: route.source,
				providerThreadId: route.providerThreadId,
				principalHash: route.principalHash,
				projectSlug: route.projectSlug,
				targetId: route.targetId,
				contextId: route.contextId,
				profile: MCP_RELATIONSHIP_PROFILE,
				recipientHint,
			});
		} catch {
			throw new HostMcpError("relationship_unavailable", 409);
		}
	}

	async rehomeRelationshipContext(target, contextId) {
		if (!this.runtime?.rehomeStoppedContext) {
			throw new HostMcpError("relationship_context_migration_unavailable", 503);
		}
		if (this.store.getMeta("scheduler:draining") !== "true") {
			throw new HostMcpError("relationship_context_drain_required", 409);
		}
		const context = this.store.getContext(contextId);
		if (
			!context
			|| context.targetId !== target.id
			|| context.status !== "stopped"
			|| this.store.hasContextMaintenanceActivity(contextId)
		) throw new HostMcpError("relationship_context_not_stopped", 409);
		const routes = this.store.listRoutesForContext(contextId, target.id);
		if (routes.length !== 1) throw new HostMcpError("relationship_ambiguous", 409);
		const route = routes[0];
		if (
			!this.store.hasRouteParticipant(route.source, route.providerThreadId, route.principalHash)
			|| this.store.countRouteParticipants(route.source, route.providerThreadId) !== 1
		) throw new HostMcpError("relationship_unverified", 409);
		if (route.source === "phone") {
			const conversation = this.store.getPhoneConversationByProviderThread(route.providerThreadId);
			if (
				!conversation
				|| conversation.status !== "active"
				|| conversation.principalHash !== route.principalHash
				|| conversation.targetId !== route.targetId
				|| conversation.contextId !== route.contextId
			) throw new HostMcpError("relationship_unverified", 409);
		}
		const destinationContextId = this.relationshipContextId(route);
		if (
			destinationContextId !== contextId
			&& this.config.scheduledWakes?.contextIds?.includes(contextId)
		) throw new HostMcpError("relationship_context_schedule_config_migration_required", 409);
		const relationship = this.store.getMcpRelationshipByRoute(
			route.source,
			route.providerThreadId,
			MCP_RELATIONSHIP_PROFILE,
		);
		if (
			relationship
			&& (
				relationship.status !== "active"
				|| relationship.contextId !== contextId
				|| relationship.targetId !== target.id
				|| relationship.principalHash !== route.principalHash
			)
		) throw new HostMcpError("relationship_unavailable", 409);
		if (destinationContextId === contextId) {
			if (relationship) this.assertRelationship(relationship);
			return {
				migrated: false,
				from_context_id: contextId,
				to_context_id: contextId,
				relationship_id: relationship?.id,
			};
		}
		let migrated;
		try {
			migrated = await this.runtime.rehomeStoppedContext(
				target,
				contextId,
				destinationContextId,
				{ relationshipId: relationship?.id },
			);
		} catch {
			throw new HostMcpError("relationship_context_migration_failed", 409);
		}
		const migratedRelationship = relationship
			? this.assertRelationship(this.store.getMcpRelationship(relationship.id))
			: null;
		return {
			migrated: true,
			from_context_id: contextId,
			to_context_id: destinationContextId,
			relationship_id: migratedRelationship?.id,
			audit_id: migrated.auditId,
			workspace_moved: migrated.workspaceMoved,
			retained_stopped_runtime: migrated.retainedStoppedRuntime,
		};
	}

	assertRelationship(relationship) {
		if (!relationship || relationship.status !== "active") {
			throw new HostMcpError("relationship_unavailable", 403);
		}
		const route = this.store.getRoute(relationship.source, relationship.providerThreadId);
		const context = this.store.getContext(relationship.contextId);
		const contextRoutes = this.store.listRoutesForContext(
			relationship.contextId,
			relationship.targetId,
		);
		if (
			!route
			|| !context
			|| contextRoutes.length !== 1
			|| contextRoutes[0].source !== relationship.source
			|| contextRoutes[0].providerThreadId !== relationship.providerThreadId
			|| this.relationshipContextId(contextRoutes[0]) !== relationship.contextId
			|| route.principalHash !== relationship.principalHash
			|| route.projectSlug !== relationship.projectSlug
			|| route.targetId !== relationship.targetId
			|| route.contextId !== relationship.contextId
			|| context.targetId !== relationship.targetId
			|| this.store.countRouteParticipants(
				relationship.source,
				relationship.providerThreadId,
			) !== 1
			|| !this.store.hasRouteParticipant(
				relationship.source,
				relationship.providerThreadId,
				relationship.principalHash,
			)
		) throw new HostMcpError("relationship_unavailable", 403);
		if (relationship.source === "phone") {
			const conversation = this.store.getPhoneConversationByProviderThread(relationship.providerThreadId);
			if (
				!conversation
				|| conversation.status !== "active"
				|| conversation.principalHash !== relationship.principalHash
				|| conversation.targetId !== relationship.targetId
				|| conversation.contextId !== relationship.contextId
				|| `ending ${conversation.contactLastFour}` !== relationship.recipientHint
			) throw new HostMcpError("relationship_unavailable", 403);
		}
		return relationship;
	}

	createHandoff(target, contextId, input = {}) {
		if (!this.config.mcp) throw new HostMcpError("mcp_unavailable", 503);
		const direction = input.direction;
		if (!["inbound", "outbound"].includes(direction)) {
			throw new HostMcpError("direction_invalid");
		}
		const relationship = this.resolveRelationship(target, contextId);
		const displayName = boundedText(input.name || "MCP connection", "name", 120);
		const upstreamUrl = input.server_url ? normalizeMcpServerUrl(input.server_url) : undefined;
		if (direction === "inbound" && upstreamUrl) throw new HostMcpError("server_url_not_allowed");
		const rawToken = secret("tfat_one_");
		const expiresAt = new Date(Date.now() + this.config.mcp.handoffTtlSeconds * 1000).toISOString();
		const handoff = this.store.createMcpHandoff({
			tokenHash: digest(rawToken),
			targetId: target.id,
			contextId,
			relationshipId: relationship.id,
			direction,
			displayName,
			upstreamUrl,
			allowedAuth: direction === "inbound" ? [] : ["none", "bearer", "header"],
			expiresAt,
		});
		return {
			id: handoff.id,
			url: `${this.config.mcp.handoffBaseUrl}#v=${encodeURIComponent(rawToken)}`,
			expires_at: expiresAt,
			direction,
			name: displayName,
			relationship: publicRelationship(relationship),
		};
	}

	handoffPayload(handoff, { sessionToken } = {}) {
		const relationship = this.assertRelationship(this.store.getMcpRelationship(handoff.relationshipId));
		return {
			direction: handoff.direction,
			name: handoff.displayName,
			server_url: handoff.upstreamUrl,
			allowed_auth: handoff.allowedAuth,
			expires_at: handoff.expiresAt,
			operator_name: "Relationship Operator",
			relationship: publicRelationship(relationship),
			...(sessionToken ? { session_token: sessionToken } : {}),
		};
	}

	openHandoff(rawToken) {
		if (handoffToken(rawToken)) {
			const sessionToken = `tfat_session_${contextCapability(
				this.routingKey,
				"mcp-handoff-session",
				rawToken,
			)}`;
			let handoff;
			try {
				handoff = this.store.exchangeMcpHandoffToken(digest(rawToken), digest(sessionToken));
			} catch {
				throw new HostMcpError("handoff_unavailable", 404);
			}
			return this.handoffPayload(handoff, { sessionToken });
		}
		if (handoffSessionToken(rawToken)) {
			const handoff = this.store.getMcpHandoffBySessionTokenHash(digest(rawToken));
			if (!handoff || handoff.status !== "pending") {
				throw new HostMcpError("handoff_unavailable", 404);
			}
			return this.handoffPayload(handoff);
		}
		throw new HostMcpError("handoff_unavailable", 404);
	}

	async completeHandoff(rawToken, input = {}) {
		if (!handoffSessionToken(rawToken)) throw new HostMcpError("handoff_unavailable", 404);
		const sessionTokenHash = digest(rawToken);
		const handoff = this.store.getMcpHandoffBySessionTokenHash(sessionTokenHash);
		if (!handoff || handoff.status !== "pending") {
			throw new HostMcpError("handoff_unavailable", 404);
		}
		this.assertRelationship(this.store.getMcpRelationship(handoff.relationshipId));
		if (input.direction && input.direction !== handoff.direction) {
			throw new HostMcpError("direction_not_allowed", 403);
		}

		let response;
		try {
			if (handoff.direction === "inbound") {
				const id = `mcp_${randomBytes(18).toString("base64url")}`;
				const apiKey = secret("tfat_mcp_");
				const displayName = boundedText(input.name || handoff.displayName, "name", 120);
				this.store.completeMcpHandoff(sessionTokenHash, {
					inboundGrant: {
						id,
						displayName,
						tokenHash: digest(apiKey),
						profile: MCP_RELATIONSHIP_PROFILE,
					},
				});
				response = {
					direction: "inbound",
					name: displayName,
					server_url: `${this.config.mcp.publicBaseUrl}/resources/${encodeURIComponent(id)}`,
					api_key: apiKey,
					tool: "instruct_operator",
				};
			} else {
				const id = randomUUID();
				const displayName = boundedText(input.name || handoff.displayName, "name", 120);
				const upstreamUrl = normalizeMcpServerUrl(input.server_url || handoff.upstreamUrl);
				const authType = input.auth_type || "bearer";
				if (!handoff.allowedAuth.includes(authType)) throw new HostMcpError("auth_type_not_allowed", 403);
				const headerName = authType === "header" ? normalizeHeaderName(input.header_name) : undefined;
				const credential = authType === "none"
					? undefined
					: boundedText(input.secret, "secret", 8192);
				if (authType === "none" && input.secret) throw new HostMcpError("secret_not_allowed");
				const alias = aliasFor(displayName, id);
				this.store.completeMcpHandoff(sessionTokenHash, {
					outboundConnection: {
						id,
						alias,
						displayName,
						upstreamUrl,
						authType,
						headerName,
						credentialCiphertext: credential === undefined
							? undefined
							: sealPrivateValue(this.routingKey, `mcp-upstream:${id}`, credential),
					},
				});
				response = { direction: "outbound", name: displayName, alias, server_url: upstreamUrl };
			}
		} catch (error) {
			if (error instanceof HostMcpError) throw error;
			throw new HostMcpError("handoff_unavailable", 404);
		}
		try {
			await this.onContextChanged?.(handoff.contextId);
		} catch (error) {
			console.error(
				`troublemaker-hostd: MCP runtime refresh failed for ${handoff.contextId}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
		const relationship = this.store.getMcpRelationship(handoff.relationshipId);
		return { ...response, relationship: publicRelationship(relationship) };
	}

	authenticateInbound(resourceId, authorization) {
		const supplied = bearerToken(authorization);
		if (!/^tfat_mcp_[A-Za-z0-9_-]{43}$/.test(supplied)) {
			throw new HostMcpError("unauthorized", 401);
		}
		const grant = this.store.getMcpInboundGrant(resourceId);
		if (
			!grant
			|| grant.status !== "active"
			|| grant.profile !== MCP_RELATIONSHIP_PROFILE
			|| !grant.relationshipId
			|| !safeEqual(digest(supplied), grant.tokenHash)
		) throw new HostMcpError("unauthorized", 401);
		const target = this.config.targetsById.get(grant.targetId);
		const context = this.store.getContext(grant.contextId);
		const relationship = this.store.getMcpRelationship(grant.relationshipId);
		if (
			!target
			|| !context
			|| context.targetId !== target.id
			|| !relationship
			|| relationship.contextId !== grant.contextId
			|| relationship.targetId !== grant.targetId
		) throw new HostMcpError("unauthorized", 401);
		try {
			this.assertRelationship(relationship);
		} catch {
			throw new HostMcpError("unauthorized", 401);
		}
		this.store.touchMcpInboundGrant(grant.id);
		return { grant, target, relationship };
	}

	enqueueInstruction(grant, relationship, input) {
		if (
			!input
			|| typeof input !== "object"
			|| Array.isArray(input)
			|| Object.keys(input).some((key) => !["instruction", "idempotency_key"].includes(key))
		) throw new HostMcpError("arguments_invalid");
		const instruction = boundedInstruction(input?.instruction);
		const key = idempotencyKey(input?.idempotency_key);
		const instructionSha256 = digest(instruction);
		const existing = this.store.getMcpInstructionReceipt(grant.id, key);
		if (existing && existing.instructionSha256 !== instructionSha256) {
			throw new HostMcpError("idempotency_conflict", 409);
		}
		const eventId = existing?.eventId || randomUUID();
		let receipt;
		try {
			receipt = existing
				? { ...existing, duplicate: true }
				: this.store.enqueueMcpInstruction({
				grantId: grant.id,
				idempotencyKey: key,
				instructionSha256,
				relationshipId: relationship.id,
				relationshipGeneration: relationship.generation,
				targetId: relationship.targetId,
				contextId: relationship.contextId,
				principalHash: relationship.principalHash,
				eventId,
				providerMessageId: digest(`${grant.id}\0${key}`),
				payload: {
					instruction,
					mcp: {
						grantId: grant.id,
						relationshipId: relationship.id,
						relationshipGeneration: relationship.generation,
						connectionName: grant.displayName,
					},
					},
				});
		} catch (error) {
			if (error instanceof Error && error.message === "mcp_instruction_idempotency_conflict") {
				throw new HostMcpError("idempotency_conflict", 409);
			}
			throw error;
		}
		if (!receipt.duplicate) this.onEventQueued?.();
		return receipt;
	}

	authorizeInstructionEvent(event, input) {
		const grantId = input?.mcp?.grantId;
		const relationshipId = input?.mcp?.relationshipId;
		const relationshipGeneration = input?.mcp?.relationshipGeneration;
		const grant = typeof grantId === "string" ? this.store.getMcpInboundGrant(grantId) : null;
		const relationship = typeof relationshipId === "string"
			? this.store.getMcpRelationship(relationshipId)
			: null;
		const receipt = this.store.getMcpInstructionReceiptByEvent(event.id);
		if (
			!grant
			|| grant.status !== "active"
			|| grant.profile !== MCP_RELATIONSHIP_PROFILE
			|| grant.relationshipId !== relationshipId
			|| grant.contextId !== event.contextId
			|| grant.targetId !== event.targetId
			|| !relationship
			|| relationship.generation !== relationshipGeneration
			|| relationship.contextId !== event.contextId
			|| relationship.targetId !== event.targetId
			|| relationship.principalHash !== event.principalHash
			|| !receipt
			|| receipt.grantId !== grant.id
			|| receipt.relationshipId !== relationship.id
			|| receipt.relationshipGeneration !== relationship.generation
			|| receipt.instructionSha256 !== digest(boundedInstruction(input?.instruction))
		) throw new HostMcpError("instruction_revoked", 403);
		this.assertRelationship(relationship);
		return { grant, relationship, receipt };
	}

	async proxyInbound({ resourceId, authorization, body, requestHeaders }) {
		const { grant, relationship } = this.authenticateInbound(resourceId, authorization);
		const mediaType = String(requestHeaders?.["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
		if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
			throw new HostMcpError("json_required", 415);
		}
		let request;
		try {
			request = JSON.parse(Buffer.from(body).toString("utf8"));
		} catch {
			return jsonRpcError(null, -32700, "Parse error");
		}
		if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0") {
			return jsonRpcError(request?.id, -32600, "Invalid Request");
		}
		if (request.method === "notifications/initialized") {
			return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
		}
		if (request.id === undefined || request.id === null) {
			return jsonRpcError(null, -32600, "Request id required");
		}
		if (request.method === "initialize") {
			return jsonRpcResult(request.id, {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "tinyfat-relationship-operator", version: "1.0.0" },
				instructions: "This server can submit an instruction only to its one bound relationship Operator. It cannot select a recipient, send a message directly, read files, or run commands.",
			});
		}
		if (request.method === "ping") return jsonRpcResult(request.id, {});
		if (request.method === "tools/list") {
			return jsonRpcResult(request.id, {
				tools: [{
					name: "instruct_operator",
					description: "Submit one durable instruction to this connection's exact relationship Operator. The Operator decides whether and how to act; this tool cannot choose a recipient or send a user-facing message directly.",
					inputSchema: {
						type: "object",
						additionalProperties: false,
						required: ["instruction", "idempotency_key"],
						properties: {
							instruction: { type: "string", minLength: 1, maxLength: 8000 },
							idempotency_key: {
								type: "string",
								pattern: "^[A-Za-z0-9._:-]{8,128}$",
								description: "Stable opaque key reused only when retrying this exact instruction.",
							},
						},
					},
				}],
			});
		}
		if (request.method === "tools/call") {
			if (request.params?.name !== "instruct_operator") {
				return jsonRpcError(request.id, -32602, "Unknown tool");
			}
			try {
				const receipt = this.enqueueInstruction(grant, relationship, request.params?.arguments);
				const structuredContent = {
					receipt_id: receipt.eventId,
					status: receipt.status,
					duplicate: receipt.duplicate,
					relationship: publicRelationship(relationship),
					provider_receipts: this.store.listProviderReceiptsForEvent(receipt.eventId).map((provider) => ({
						provider_message_id: provider.providerMessageId || undefined,
						provider_status: provider.providerStatus || undefined,
						host_status: provider.hostStatus,
						completed_at: provider.completedAt || undefined,
					})),
				};
				return jsonRpcResult(request.id, {
					content: [{
						type: "text",
						text: `Instruction ${receipt.duplicate ? "already" : "durably"} accepted for the bound Relationship Operator (receipt ${receipt.eventId}, status ${receipt.status}).`,
					}],
					structuredContent,
				});
			} catch (error) {
				if (error instanceof HostMcpError) {
					return jsonRpcError(request.id, -32602, error.code);
				}
				throw error;
			}
		}
		return jsonRpcError(request.id, -32601, "Method not found");
	}

	isContextActive() {
		return false;
	}

	activeInboundRelationship(contextId) {
		const active = this.store.listMcpInboundGrants(contextId, { activeOnly: true })
			.filter((grant) => grant.profile === MCP_RELATIONSHIP_PROFILE && grant.relationshipId);
		if (active.length === 0) return null;
		const ids = new Set(active.map((grant) => grant.relationshipId));
		if (ids.size !== 1) throw new HostMcpError("relationship_ambiguous", 409);
		return this.assertRelationship(this.store.getMcpRelationship(active[0].relationshipId));
	}

	operatorRuntimeToken(target, relationship) {
		return contextCapability(
			target.inboundToken,
			`mcp-operator:${relationship.id}:${relationship.generation}`,
			relationship.contextId,
		);
	}

	list(contextId) {
		return {
			inbound: this.store.listMcpInboundGrants(contextId).map((grant) => (
				publicInboundGrant(
					grant,
					grant.relationshipId ? this.store.getMcpRelationship(grant.relationshipId) : null,
					this.config.mcp.publicBaseUrl,
				)
			)),
			outbound: this.store.listMcpOutboundConnections(contextId).map((connection) => (
				publicOutboundConnection(
					connection,
					connection.relationshipId ? this.store.getMcpRelationship(connection.relationshipId) : null,
				)
			)),
			handoffs: this.store.listMcpHandoffs(contextId).map((handoff) => ({
				id: handoff.id,
				direction: handoff.direction,
				name: handoff.displayName,
				status: handoff.status,
				relationship: handoff.relationshipId
					? publicRelationship(this.store.getMcpRelationship(handoff.relationshipId))
					: undefined,
				expires_at: handoff.expiresAt,
				created_at: handoff.createdAt,
			})),
		};
	}

	async revoke(contextId, { direction, id }) {
		if (!["handoff", "inbound", "outbound"].includes(direction)) {
			throw new HostMcpError("direction_invalid");
		}
		const revoked = direction === "handoff"
			? this.store.revokeMcpHandoff(contextId, id)
			: direction === "inbound"
				? this.store.revokeMcpInboundGrant(contextId, id)
				: this.store.revokeMcpOutboundConnection(contextId, id);
		if (!revoked) throw new HostMcpError("connection_not_found", 404);
		if (direction !== "handoff") {
			try {
				await this.onContextChanged?.(contextId);
			} catch (error) {
				console.error(
					`troublemaker-hostd: MCP runtime refresh failed for ${contextId}:`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		return { ok: true, id, direction };
	}

	activeOutboundConnections(contextId) {
		return this.store.listMcpOutboundConnections(contextId, { activeOnly: true })
			.filter((connection) => connection.relationshipId)
			.map((connection) => {
				this.assertOutboundConnection(connection);
				return connection;
			});
	}

	assertOutboundConnection(connection) {
		if (!connection || connection.status !== "active" || !connection.relationshipId) {
			throw new HostMcpError("connection_not_found", 404);
		}
		const relationship = this.assertRelationship(this.store.getMcpRelationship(connection.relationshipId));
		if (
			relationship.contextId !== connection.contextId
			|| relationship.targetId !== connection.targetId
		) throw new HostMcpError("connection_not_found", 404);
		return relationship;
	}

	openOutboundCredential(connection) {
		this.assertOutboundConnection(connection);
		if (!connection.credentialCiphertext) return undefined;
		return openPrivateValue(
			this.routingKey,
			`mcp-upstream:${connection.id}`,
			connection.credentialCiphertext,
		);
	}
}
