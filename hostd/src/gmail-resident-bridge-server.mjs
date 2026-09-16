import { createServer } from "node:http";
import { bearerMatches } from "./security.mjs";

function json(response, status, value) {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	response.end(body);
}

async function readJson(request, maximum) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > maximum) throw new Error("request body is too large");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("request body is not valid JSON");
	}
}

function safeError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function assertHostReceipt(receipt) {
	if (!receipt || typeof receipt.url !== "string" || typeof receipt.token !== "string" || typeof receipt.leaseToken !== "string") {
		throw new Error("host receipt capability is invalid");
	}
	const url = new URL(receipt.url);
	if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) {
		throw new Error("host receipt URL must use the guest loopback end of the supervised tunnel");
	}
	if (!receipt.token || !receipt.leaseToken) throw new Error("host receipt capability is invalid");
	return url;
}

export function runtimeEmailDeliverer({ url, token, fetchImpl = fetch }) {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(parsed.hostname)) {
		throw new Error("canonical runtime email URL must use guest loopback");
	}
	return async (payload) => {
		const response = await fetchImpl(parsed, {
			method: "POST",
			redirect: "error",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`canonical runtime returned HTTP ${response.status}`);
	};
}

export function createGmailResidentBridgeServer({
	contextId,
	identity,
	identityToken,
	inboundToken,
	runtimeDeliver,
}) {
	const active = new Set();
	const acceptance = (deliveryId) => ({
		accepted: true,
		deliveryId,
		runtimeIdentity: identity.runtimeIdentity,
		headscaleNodeId: identity.headscaleNodeId,
	});

	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url || "/", "http://127.0.0.1");
			if (request.method === "GET" && url.pathname === "/health") {
				json(response, 200, { ok: true });
				return;
			}
			if (request.method === "GET" && url.pathname === "/email/identity") {
				if (!bearerMatches(request.headers.authorization, identityToken)) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				json(response, 200, identity);
				return;
			}
			if (request.method === "POST" && url.pathname === "/email/inbound") {
				if (!bearerMatches(request.headers.authorization, inboundToken)) {
					json(response, 401, { error: "unauthorized" });
					return;
				}
				const payload = await readJson(request, 2 * 1024 * 1024);
				if (payload.hostContextId !== contextId) throw new Error("host context ID mismatch");
				if (typeof payload.deliveryId !== "string" || !payload.deliveryId) throw new Error("delivery ID is invalid");
				assertHostReceipt(payload.hostReceipt);
				const work = Promise.resolve()
					.then(() => runtimeDeliver(payload))
					.catch(() => {})
					.finally(() => active.delete(work));
				active.add(work);
				json(response, 202, acceptance(payload.deliveryId));
				return;
			}
			if (request.method === "POST" && url.pathname === "/v1/outbound/gmail") {
				json(response, 503, { error: "outbound_gmail_disabled" });
				return;
			}
			json(response, 404, { error: "not_found" });
		} catch (error) {
			json(response, 400, { error: safeError(error) });
		}
	});

	server.waitForActive = () => Promise.allSettled([...active]);
	return server;
}
