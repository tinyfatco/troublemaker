import { createServer } from "node:http";
import { GmailToolError, HostGmailTools } from "./gmail-tools.mjs";
import { HostMcpError } from "./mcp.mjs";
import { OpenAiError } from "./openai.mjs";
import { bodyDigest, PhoneDeliveryUncertainError } from "./phone.mjs";
import { bearerMatches, contextCapability } from "./security.mjs";
import { HostSites, HostSitesError } from "./sites.mjs";
import { WorkersAiError } from "./workers-ai.mjs";

async function readJson(request, maximumBytes = 2 * 1024 * 1024) {
	const chunks = [];
	let length = 0;
	for await (const chunk of request) {
		length += chunk.length;
		if (length > maximumBytes) throw new Error("request body exceeds limit");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, body, additionalHeaders = {}) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		...additionalHeaders,
	});
	response.end(JSON.stringify(body));
}

async function writeChunk(response, chunk) {
	if (response.write(chunk)) return;
	await new Promise((resolvePromise, reject) => {
		const cleanup = () => {
			response.off("drain", onDrain);
			response.off("close", onClose);
			response.off("error", onError);
		};
		const onDrain = () => {
			cleanup();
			resolvePromise();
		};
		const onClose = () => {
			cleanup();
			reject(new Error("provider client disconnected"));
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		response.once("drain", onDrain);
		response.once("close", onClose);
		response.once("error", onError);
	});
}

function authenticateContext(request, config, contextId, purpose) {
	const targetId = contextId.split(":", 1)[0];
	const target = config.targetsById.get(targetId);
	if (!target || target.driver !== "oci") return null;
	const baseSecret = purpose === "inbound" ? target.inboundToken : target.outboundToken;
	const expected = contextCapability(baseSecret, purpose, contextId);
	return bearerMatches(request.headers.authorization, expected) ? target : null;
}

function activeMcpRelationshipScope(store, mcp, contextId) {
	const active = store.activeMcpInstructionForContext(contextId);
	if (!active) return null;
	const relationship = store.getMcpRelationship(active.relationshipId);
	const grant = store.getMcpInboundGrant(active.grantId);
	if (
		!grant
		|| grant.status !== "active"
		|| grant.relationshipId !== active.relationshipId
		|| grant.contextId !== contextId
		|| !relationship
		|| !mcp
		|| relationship.status !== "active"
		|| relationship.contextId !== contextId
		|| relationship.generation !== active.relationshipGeneration
	) return { invalid: true };
	try {
		mcp.assertRelationship(relationship);
	} catch {
		return { invalid: true };
	}
	return { ...relationship, eventId: active.eventId };
}

function denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response) {
	if (!activeMcpRelationshipScope(store, mcp, contextId)) return false;
	json(response, 403, { error: "relationship_instruction_scope_denied" });
	return true;
}

export function createHostServer({
	config,
	store,
	gmail,
	daemon,
	scheduler,
	mattermostGateway,
	rocketChatGateway,
	zulipGateway,
	phoneGateway,
	sitesGateway,
	workersAiGateway,
	openAiGateway,
	mcp,
	mcpOutbound,
	routingKey,
}) {
	const gmailTools = routingKey && gmail && config.gmail
		? new HostGmailTools({ config, store, gmail, routingKey })
		: null;
	const sites = sitesGateway || (config.sites ? new HostSites({ config, store, routingKey }) : null);
	return createServer(async (request, response) => {
		const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
		try {
			if (request.method === "GET" && url.pathname === "/health") {
				response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
				response.end("ok");
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/status") {
				if (!bearerMatches(request.headers.authorization, config.server.operatorToken)) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				json(response, 200, {
					ok: true,
					polling: daemon.polling,
					draining: store.getMeta("scheduler:draining") === "true",
					...store.status(
						config.scheduler?.maxConcurrent ?? 6,
						config.workersAi,
						config.openAi,
					),
					contextDetails: store.listContexts(),
				});
				return;
			}
			if (request.method === "POST" && ["/v1/drain", "/v1/resume"].includes(url.pathname)) {
				if (!config.server.operatorToken || !bearerMatches(request.headers.authorization, config.server.operatorToken)) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				const draining = url.pathname === "/v1/drain";
				store.setMeta("scheduler:draining", String(draining));
				if (!draining) scheduler?.pump();
				json(response, 200, { ok: true, draining });
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/mcp/control") {
				if (!mcp || !config.mcp) {
					json(response, 503, { error: "mcp_unavailable" });
					return;
				}
				if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					json(response, 415, { error: "json_required" });
					return;
				}
				const body = await readJson(request, 32 * 1024);
				const contextId = typeof body.context_id === "string" ? body.context_id : "";
				const target = authenticateContext(request, config, contextId, "mcp-control");
				if (!target) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				if (denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response)) return;
				if (body.action === "request") {
					json(response, 200, mcp.createHandoff(target, contextId, body));
					return;
				}
				if (body.action === "list") {
					json(response, 200, mcp.list(contextId));
					return;
				}
				if (body.action === "revoke") {
					json(response, 200, await mcp.revoke(contextId, body));
					return;
				}
				json(response, 400, { error: "action_invalid" });
				return;
			}
			const mcpOutboundMatch = url.pathname.match(/^\/v1\/mcp\/outbound\/([^/]+)\/([^/]+)$/);
			if (mcpOutboundMatch) {
				if (!mcpOutbound || !config.mcp) {
					json(response, 503, { error: "mcp_unavailable" });
					return;
				}
				const contextId = decodeURIComponent(mcpOutboundMatch[1]);
				const target = authenticateContext(request, config, contextId, "mcp-outbound");
				if (!target) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				if (denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response)) return;
				await mcpOutbound.proxy(
					request,
					response,
					contextId,
					decodeURIComponent(mcpOutboundMatch[2]),
				);
				return;
			}
			const workersAiMatch = url.pathname.match(
				/^\/v1\/workers-ai\/([^/]+)\/chat\/completions$/,
			);
			if (request.method === "POST" && workersAiMatch) {
				if (!workersAiGateway || !config.workersAi) {
					json(response, 503, { error: "workers_ai_unavailable" });
					return;
				}
				if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					json(response, 415, { error: "json_required" });
					return;
				}
				const contextId = decodeURIComponent(workersAiMatch[1]);
				const target = authenticateContext(request, config, contextId, "workers-ai");
				if (!target) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				const body = await readJson(request, config.workersAi.maximumRequestBytes);
				const controller = new AbortController();
				const abort = () => controller.abort();
				const abortIfIncomplete = () => {
					if (!response.writableEnded) controller.abort();
				};
				request.once("aborted", abort);
				response.once("close", abortIfIncomplete);
				try {
					const upstream = await workersAiGateway.complete(
						target,
						contextId,
						body,
						controller.signal,
					);
					response.writeHead(upstream.status, {
						"content-type": upstream.headers.get("content-type") || "application/json",
						"cache-control": "no-store",
					});
					if (upstream.body) {
						for await (const chunk of upstream.body) {
							await writeChunk(response, chunk);
						}
					}
					response.end();
				} finally {
					request.off("aborted", abort);
					response.off("close", abortIfIncomplete);
				}
				return;
			}
			const openAiMatch = url.pathname.match(/^\/v1\/openai\/([^/]+)\/responses$/);
			if (request.method === "POST" && openAiMatch) {
				if (!openAiGateway || !config.openAi) {
					json(response, 503, { error: "openai_unavailable" });
					return;
				}
				if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					json(response, 415, { error: "json_required" });
					return;
				}
				const contextId = decodeURIComponent(openAiMatch[1]);
				const target = authenticateContext(request, config, contextId, "openai");
				if (!target) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				const body = await readJson(request, config.openAi.maximumRequestBytes);
				const controller = new AbortController();
				const abort = () => controller.abort();
				const abortIfIncomplete = () => {
					if (!response.writableEnded) controller.abort();
				};
				request.once("aborted", abort);
				response.once("close", abortIfIncomplete);
				try {
					const upstream = await openAiGateway.complete(
						target,
						contextId,
						body,
						controller.signal,
					);
					response.writeHead(upstream.status, {
						"content-type": upstream.headers.get("content-type") || "application/json",
						"cache-control": "no-store",
					});
					if (upstream.body) {
						for await (const chunk of upstream.body) await writeChunk(response, chunk);
					}
					response.end();
				} finally {
					request.off("aborted", abort);
					response.off("close", abortIfIncomplete);
				}
				return;
			}
			const receiptMatch = url.pathname.match(/^\/v1\/events\/([^/]+)\/receipt$/);
			if (request.method === "POST" && receiptMatch) {
				const event = store.getEvent(decodeURIComponent(receiptMatch[1]));
				if (!event) {
					json(response, 404, { error: "event_not_found" });
					return;
				}
				const target = config.targetsById.get(event.targetId);
				const expected = target
					? contextCapability(target.inboundToken, "receipt", event.contextId)
					: "";
				if (!target || !bearerMatches(request.headers.authorization, expected)) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				const body = await readJson(request, 64 * 1024);
				const leaseToken = typeof body.lease_token === "string" ? body.lease_token : "";
				const status = typeof body.status === "string" ? body.status : "";
				if (!leaseToken || event.leaseToken !== leaseToken) {
					json(response, 409, { error: "stale_event_lease" });
					return;
				}
				const updated = scheduler.receipt(
					event.id,
					leaseToken,
					status,
					typeof body.error === "string" ? body.error : undefined,
				);
				json(response, 200, { ok: true, status: updated.status });
				return;
			}
			const mattermostMatch = url.pathname.match(/^\/v1\/mattermost\/([^/]+)\/api\/v4(\/.*)$/);
			if (mattermostMatch && mattermostGateway) {
				const contextId = decodeURIComponent(mattermostMatch[1]);
				const targetId = contextId.split(":", 1)[0];
				const target = config.targetsById.get(targetId);
				if (!target) {
					json(response, 404, { error: "context_not_found" });
					return;
				}
				if (denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response)) return;
				await mattermostGateway.proxy(
					request,
					response,
					contextId,
					mattermostMatch[2],
					contextCapability(target.outboundToken, "mattermost", contextId),
				);
				return;
			}
			const rocketChatMatch = url.pathname.match(/^\/v1\/rocketchat\/([^/]+)\/api\/v1(\/.*)$/);
			if (rocketChatMatch && rocketChatGateway) {
				const contextId = decodeURIComponent(rocketChatMatch[1]);
				const targetId = contextId.split(":", 1)[0];
				const target = config.targetsById.get(targetId);
				if (!target) {
					json(response, 404, { error: "context_not_found" });
					return;
				}
				if (denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response)) return;
				await rocketChatGateway.proxy(
					request,
					response,
					contextId,
					`${rocketChatMatch[2]}${url.search}`,
					contextCapability(target.outboundToken, "rocketchat", contextId),
				);
				return;
			}
			const zulipMatch = url.pathname.match(/^\/v1\/zulip\/([^/]+)\/api\/v1(\/.*)$/);
			if (zulipMatch && zulipGateway) {
				const contextId = decodeURIComponent(zulipMatch[1]);
				const targetId = contextId.split(":", 1)[0];
				const target = config.targetsById.get(targetId);
				if (!target) {
					json(response, 404, { error: "context_not_found" });
					return;
				}
				if (denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response)) return;
				await zulipGateway.proxy(
					request,
					response,
					contextId,
					`${zulipMatch[2]}${url.search}`,
					contextCapability(target.outboundToken, "zulip", contextId),
				);
				return;
			}
			if (request.method === "POST" && [
				"/v1/gmail/search",
				"/v1/gmail/read",
				"/v1/gmail/draft",
				"/v1/gmail/send",
			].includes(url.pathname)) {
				if (!gmailTools) {
					json(response, 503, { error: "gmail_tools_unavailable" });
					return;
				}
				if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					json(response, 415, { error: "json_required" });
					return;
				}
				const body = await readJson(request);
				const contextId = typeof body.context_id === "string" ? body.context_id : "";
				const target = authenticateContext(request, config, contextId, "outbound");
				if (!target) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				if (denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response)) return;
				const handlers = {
					"/v1/gmail/search": () => gmailTools.search(target, contextId, body),
					"/v1/gmail/read": () => gmailTools.read(target, contextId, body),
					"/v1/gmail/draft": () => gmailTools.draft(target, contextId, body),
					"/v1/gmail/send": () => gmailTools.send(target, contextId, body),
				};
				json(response, 200, await handlers[url.pathname]());
				return;
			}
			if (request.method === "POST" && ["/v1/sites/create", "/v1/sites/deploy"].includes(url.pathname)) {
				if (!sites) {
					json(response, 503, { error: "sites_unavailable" });
					return;
				}
				if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					json(response, 415, { error: "json_required" });
					return;
				}
				const body = await readJson(request, 32 * 1024);
				const contextId = typeof body.context_id === "string" ? body.context_id : "";
				const target = authenticateContext(request, config, contextId, "site-deploy");
				if (!target) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				if (denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response)) return;
				json(response, 200, url.pathname === "/v1/sites/create"
					? await sites.create(target, contextId, body)
					: await sites.deploy(target, contextId, body));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/outbound/gmail") {
				if (!gmail || !config.gmail) {
					json(response, 503, { error: "gmail_unavailable" });
					return;
				}
				if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					json(response, 415, { error: "json_required" });
					return;
				}
				const body = await readJson(request);
				const contextId = typeof body.context_id === "string" ? body.context_id : "";
				const target = authenticateContext(request, config, contextId, "outbound");
				if (!target) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				if (denyNonPhoneDuringMcpInstruction(store, mcp, contextId, response)) return;
				if (target.gmailToolsOnly) {
					json(response, 409, { error: "gmail_draft_required" });
					return;
				}
				const threadId = typeof body.provider_thread_id === "string" ? body.provider_thread_id : "";
				const route = store.getRoute("gmail", threadId);
				if (!route || route.contextId !== contextId || route.targetId !== target.id) {
					json(response, 403, { error: "conversation_scope_denied" });
					return;
				}
				const message = typeof body.agent_body === "string" ? body.agent_body.trim() : "";
				if (!message) {
					json(response, 400, { error: "agent_body_required" });
					return;
				}
				const subject = typeof body.subject === "string" ? body.subject.trim() : "";
				if (!subject) {
					json(response, 400, { error: "subject_required" });
					return;
				}
				const idempotencyKey = typeof body.idempotency_key === "string" && body.idempotency_key
					? body.idempotency_key
					: `${contextId}:${threadId}:${body.delivery_id || "unknown"}`;
				let outbox = store.startOutbox({
					idempotencyKey,
					targetId: target.id,
					contextId,
					providerThreadId: threadId,
				});
				if (outbox.status === "completed" && outbox.providerMessageId) {
					json(response, 200, { ok: true, messageId: outbox.providerMessageId, duplicate: true });
					return;
				}
				if (!outbox.claimed) {
					json(response, 409, { error: "send_already_in_progress" });
					return;
				}
				try {
					const receipt = await gmail.sendThreadReply(threadId, subject, message);
					outbox = store.completeOutbox(idempotencyKey, receipt.messageId);
					if (config.mattermost || config.rocketChat || config.zulip) {
						store.recordCompletedLedgerEventWithControlNotification({
							id: `gmail_outbound:${receipt.messageId}`,
							source: "gmail_outbound",
							providerMessageId: receipt.messageId,
							providerThreadId: threadId,
							principalHash: route.principalHash,
							targetId: route.targetId,
							contextId,
							payload: {
								direction: "outbound",
								sender: config.gmail.account,
								recipient: store.getContextScope(contextId, target.id)?.emailAddress || "",
								metadata: { subject },
								route: { projectSlug: route.projectSlug },
								message: {
									id: receipt.messageId,
									threadId,
									body: message,
								},
							},
						});
						daemon.controlNotifier?.wake();
					}
					json(response, 200, { ok: true, messageId: outbox.providerMessageId });
				} catch (error) {
					store.failOutbox(idempotencyKey, error instanceof Error ? error.message : String(error));
					throw error;
				}
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/outbound/phone") {
				if (!phoneGateway) {
					json(response, 503, { error: "phone_unavailable" });
					return;
				}
				if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
					json(response, 415, { error: "json_required" });
					return;
				}
				const body = await readJson(request, 64 * 1024);
				const contextId = typeof body.context_id === "string" ? body.context_id : "";
				const target = authenticateContext(request, config, contextId, "outbound");
				if (!target) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				const threadTarget = typeof body.thread_target === "string" ? body.thread_target : "";
				const conversation = store.getPhoneConversation(threadTarget);
				if (
					!conversation
					|| conversation.contextId !== contextId
					|| conversation.targetId !== target.id
				) {
					json(response, 403, { error: "conversation_scope_denied" });
					return;
				}
				const originEventId = typeof body.origin_event_id === "string"
					? body.origin_event_id.trim()
					: "";
				const mcpRelationship = activeMcpRelationshipScope(store, mcp, contextId);
				if (
					(originEventId && !mcpRelationship)
					|| (mcpRelationship && (
						mcpRelationship.invalid
						|| mcpRelationship.source !== "phone"
						|| mcpRelationship.eventId !== originEventId
						|| mcpRelationship.providerThreadId !== conversation.providerThreadId
						|| mcpRelationship.principalHash !== conversation.principalHash
						|| mcpRelationship.targetId !== conversation.targetId
						|| mcpRelationship.contextId !== conversation.contextId
						|| conversation.status !== "active"
					))
				) {
					json(response, 403, { error: "relationship_instruction_scope_denied" });
					return;
				}
				const message = typeof body.agent_body === "string" ? body.agent_body.trim() : "";
				if (!message || message.length > 1600) {
					json(response, 400, { error: "agent_body_invalid" });
					return;
				}
				const idempotencyKey = typeof body.idempotency_key === "string"
					? body.idempotency_key.trim()
					: "";
				if (!idempotencyKey || idempotencyKey.length > 256) {
					json(response, 400, { error: "idempotency_key_required" });
					return;
				}
				const sha256 = bodyDigest(message);
				if (mcpRelationship) {
					const existingDelivery = store.getOutboxForOriginEvent(originEventId);
					if (existingDelivery && existingDelivery.idempotencyKey !== idempotencyKey) {
						json(response, 409, { error: "relationship_instruction_delivery_already_exists" });
						return;
					}
				}
				let outbox = store.startOutbox({
					idempotencyKey,
					targetId: target.id,
					contextId,
					providerThreadId: conversation.providerThreadId,
					originEventId: originEventId || undefined,
					bodySha256: sha256,
				});
				if (outbox.status === "completed" && outbox.providerMessageId) {
					json(response, 200, {
						ok: true,
						messageId: outbox.providerMessageId,
						status: "queued",
						duplicate: true,
					});
					return;
				}
				if (outbox.status === "uncertain") {
					json(response, 409, { error: "delivery_result_uncertain" });
					return;
				}
				if (!outbox.claimed) {
					json(response, 409, { error: "send_already_in_progress" });
					return;
				}
				try {
					const receipt = await phoneGateway.sendDirect(conversation, message);
					const ledgerEvent = {
						id: `phone_outbound:${receipt.providerMessageId}`,
						source: "phone_outbound",
						providerMessageId: receipt.providerMessageId,
						providerThreadId: conversation.providerThreadId,
						principalHash: conversation.principalHash,
						targetId: conversation.targetId,
						contextId,
						payload: {
							direction: "outbound",
							sender: "Business SMS",
							recipient: `Phone ending ${conversation.contactLastFour}`,
							message: {
								id: receipt.providerMessageId,
								body: message,
							},
							phone: {
								threadTarget: conversation.threadTarget,
								displayName: `SMS •••• ${conversation.contactLastFour}`,
							},
							route: { projectSlug: "intake" },
						},
					};
					try {
						outbox = store.completePhoneOutboxWithLedger(
							idempotencyKey,
							receipt.providerMessageId,
							receipt.status,
							ledgerEvent,
						);
					} catch (error) {
						store.markOutboxUncertain(
							idempotencyKey,
							error instanceof Error ? error.message : String(error),
						);
						json(response, 409, { error: "delivery_result_uncertain" });
						return;
					}
					daemon.controlNotifier?.wake();
					json(response, 200, {
						ok: true,
						messageId: outbox.providerMessageId,
						status: receipt.status,
					});
				} catch (error) {
					if (error instanceof PhoneDeliveryUncertainError) {
						store.markOutboxUncertain(
							idempotencyKey,
							error.message,
						);
						json(response, 409, { error: "delivery_result_uncertain" });
						return;
					}
					store.failOutbox(
						idempotencyKey,
						error instanceof Error ? error.message : String(error),
					);
					throw error;
				}
				return;
			}
			json(response, 404, { error: "not_found" });
		} catch (error) {
			if (response.headersSent) {
				response.destroy(error instanceof Error ? error : undefined);
				return;
			}
			if (error instanceof WorkersAiError) {
				json(
					response,
					error.status,
					{ error: error.code },
					error.retryAfterSeconds
						? { "retry-after": String(error.retryAfterSeconds) }
						: {},
				);
				return;
			}
			if (error instanceof OpenAiError) {
				json(
					response,
					error.status,
					{ error: error.code },
					error.retryAfterSeconds
						? { "retry-after": String(error.retryAfterSeconds) }
						: {},
				);
				return;
			}
			if (error instanceof HostSitesError) {
				json(response, error.status, { error: error.code });
				return;
			}
			if (error instanceof HostMcpError) {
				json(response, error.status, { error: error.code });
				return;
			}
			if (error instanceof GmailToolError) {
				json(response, error.status, { error: error.code });
				return;
			}
			console.error(`troublemaker-hostd: request failed (${url.pathname}):`, error);
			json(response, 500, { error: "internal_error" });
		}
	});
}
