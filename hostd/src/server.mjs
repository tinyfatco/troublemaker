import { createServer } from "node:http";
import { GmailToolError, HostGmailTools } from "./gmail-tools.mjs";
import { bearerMatches, contextCapability } from "./security.mjs";

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

export function createHostServer({ config, store, gmail, daemon, routingKey }) {
	const gmailTools = routingKey ? new HostGmailTools({ config, store, gmail, routingKey }) : null;
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
				json(response, 200, { ok: true, polling: daemon.polling, ...store.status() });
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
				json(response, 200, handlers[url.pathname]());
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/outbound/gmail") {
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
				try {
					const receipt = gmail.sendThreadReply(threadId, subject, message);
					outbox = store.completeOutbox(idempotencyKey, receipt.messageId);
					json(response, 200, { ok: true, messageId: outbox.providerMessageId });
				} catch (error) {
					store.failOutbox(idempotencyKey, error instanceof Error ? error.message : String(error));
					throw error;
				}
				return;
			}
			json(response, 404, { error: "not_found" });
		} catch (error) {
			if (error instanceof GmailToolError) {
				json(response, error.status, { error: error.code });
				return;
			}
			console.error(`troublemaker-hostd: request failed (${url.pathname}):`, error);
			json(response, 500, { error: "internal_error" });
		}
	});
}
