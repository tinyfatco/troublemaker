import { createServer } from "node:http";
import { GmailToolError, HostGmailTools } from "./gmail-tools.mjs";
import { bodyDigest, PhoneDeliveryUncertainError } from "./phone.mjs";
import { bearerMatches, contextCapability } from "./security.mjs";
import { HostSites, HostSitesError } from "./sites.mjs";

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

function json(response, status, body) {
	response.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	response.end(JSON.stringify(body));
}

function authenticateContext(request, config, contextId, purpose) {
	const targetId = contextId.split(":", 1)[0];
	const target = config.targetsById.get(targetId);
	if (!target || target.driver !== "oci") return null;
	const baseSecret = purpose === "inbound" ? target.inboundToken : target.outboundToken;
	const expected = contextCapability(baseSecret, purpose, contextId);
	return bearerMatches(request.headers.authorization, expected) ? target : null;
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
	routingKey,
}) {
	const gmailTools = routingKey && gmail && config.gmail
		? new HostGmailTools({ config, store, gmail, routingKey })
		: null;
	const sites = sitesGateway || (config.sites ? new HostSites({ config, store }) : null);
	return createServer(async (request, response) => {
		const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
		try {
			if (request.method === "GET" && url.pathname === "/health") {
				response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
				response.end("ok");
				return;
			}
			if (request.method === "GET" && url.pathname === "/v1/status") {
				if (config.server.operatorToken && !bearerMatches(request.headers.authorization, config.server.operatorToken)) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				json(response, 200, {
					ok: true,
					polling: daemon.polling,
					draining: store.getMeta("scheduler:draining") === "true",
					...store.status(config.scheduler?.maxConcurrent ?? 6),
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
				const handlers = {
					"/v1/gmail/search": () => gmailTools.search(target, contextId, body),
					"/v1/gmail/read": () => gmailTools.read(target, contextId, body),
					"/v1/gmail/draft": () => gmailTools.draft(target, contextId, body),
					"/v1/gmail/send": () => gmailTools.send(target, contextId, body),
				};
				json(response, 200, await handlers[url.pathname]());
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/sites/deploy") {
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
				json(response, 200, await sites.deploy(target, contextId, body));
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
				let outbox = store.startOutbox({
					idempotencyKey,
					targetId: target.id,
					contextId,
					providerThreadId: conversation.providerThreadId,
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
			if (error instanceof HostSitesError) {
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
