import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { assertHeadscaleControlIdentity, assertTailnetPeerIdentity, RuntimeManager } from "../src/runtime.mjs";
import { createHostServer } from "../src/server.mjs";
import { contextCapability } from "../src/security.mjs";

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return server.address().port;
}

async function close(server) {
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function headscaleControlCommand(overrides = {}) {
	const node = {
		id: 42,
		name: "example-resident",
		ip_addresses: ["100.64.0.42"],
		...overrides,
	};
	return [process.execPath, "-e", `console.log(${JSON.stringify(JSON.stringify([node]))})`];
}

function tailnetStatusCommand(overrides = {}) {
	const peer = {
		ID: "opaque-stable-node-id",
		HostName: "example-resident",
		TailscaleIPs: ["100.64.0.42"],
		Online: true,
		...overrides,
	};
	return [process.execPath, "-e", `console.log(${JSON.stringify(JSON.stringify({ Peer: { peer } }))})`];
}

function residentTarget(port, overrides = {}) {
	return {
		id: "example-resident",
		driver: "resident",
		protocol: "gmail-history",
		contextId: "example-resident",
		mailbox: "resident@example.com",
		endpoint: `http://127.0.0.1:${port}/email/inbound`,
		identityEndpoint: `http://127.0.0.1:${port}/email/identity`,
		healthEndpoint: `http://127.0.0.1:${port}/health`,
		statusEndpoint: `http://127.0.0.1:${port}/status`,
		receiptBaseUrl: "http://127.0.0.1:19090",
		headscaleNodeId: 42,
		tailnetAddress: "100.64.0.42",
		tailnetHostname: "example-resident",
		headscaleControlCommand: headscaleControlCommand(),
		tailnetStatusCommand: tailnetStatusCommand(),
		runtimeIdentity: "example-resident",
		inboundToken: "resident-application-token-at-least-32-bytes",
		outboundToken: "resident-application-token-at-least-32-bytes",
		gmailToolsOnly: false,
		...overrides,
	};
}

test("exact Headscale control-plane identity and local tailnet reachability fail closed independently", () => {
	const target = residentTarget(1);
	assert.equal(assertHeadscaleControlIdentity(target, [{
		id: 42,
		name: "example-resident",
		ip_addresses: ["100.64.0.42"],
	}]).id, 42);
	assert.equal(assertTailnetPeerIdentity(target, {
		Peer: { one: { ID: "opaque-stable-node-id", HostName: "example-resident", TailscaleIPs: ["100.64.0.42"], Online: true } },
	}).ID, "opaque-stable-node-id");
	assert.throws(() => assertHeadscaleControlIdentity(target, []), /address was not uniquely present/);
	assert.throws(() => assertHeadscaleControlIdentity(target, [{
		id: 99,
		name: "example-resident",
		ip_addresses: ["100.64.0.42"],
	}]), /node ID mismatch/);
	assert.throws(() => assertHeadscaleControlIdentity(target, [{
		id: 42,
		name: "other",
		ip_addresses: ["100.64.0.42"],
	}]), /hostname mismatch/);
	assert.throws(() => assertTailnetPeerIdentity(target, {
		Peer: { one: { ID: "opaque-stable-node-id", HostName: "other", TailscaleIPs: ["100.64.0.42"], Online: true } },
	}), /hostname mismatch/);
	assert.throws(() => assertTailnetPeerIdentity(target, {
		Peer: { one: { ID: "opaque-stable-node-id", HostName: "example-resident", TailscaleIPs: ["100.64.0.42"], Online: false } },
	}), /not online/);
});

test("remote resident receives normalized Gmail only after exact peer and runtime identity checks", async () => {
	const requests = [];
	let acceptanceDeliveryId;
	const resident = createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/email/identity") {
			assert.equal(request.headers.authorization, "Bearer resident-application-token-at-least-32-bytes");
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
				headscaleNodeId: "42",
				runtimeIdentity: "example-resident",
			}));
			return;
		}
		if (request.method === "GET" && request.url === "/health") {
			response.writeHead(200).end("ok");
			return;
		}
		if (request.method === "POST" && request.url === "/email/inbound") {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push({ authorization: request.headers.authorization, body });
			response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({
				accepted: true,
				deliveryId: acceptanceDeliveryId ?? body.deliveryId,
				headscaleNodeId: "42",
				runtimeIdentity: "example-resident",
			}));
			return;
		}
		response.writeHead(404).end();
	});
	const port = await listen(resident);
	try {
		const target = residentTarget(port);
		const manager = new RuntimeManager({ targetsById: new Map([[target.id, target]]) }, {
			hasRunningEvent: () => false,
		});
		await manager.acceptEvent({
			id: "delivery-1",
			leaseToken: "lease-1",
			source: "gmail-history",
			targetId: target.id,
			contextId: target.contextId,
			payloadJson: JSON.stringify({
				mailbox: "resident@example.com",
				historyId: "101",
				providerMessageId: "message-1",
				providerThreadId: "thread-1",
				sender: "sender@example.com",
				fromFull: "Sender <sender@example.com>",
				to: "resident@example.com",
				subject: "Hello",
				body: "Hello resident",
				allRecipients: ["resident@example.com"],
			}),
		});
		assert.equal(requests.length, 1);
		assert.equal(
			requests[0].authorization,
			`Bearer ${contextCapability(target.inboundToken, "inbound", target.contextId)}`,
		);
		assert.equal(requests[0].body.hostContextId, target.contextId);
		assert.equal(requests[0].body.providerThreadId, "thread-1");
		assert.equal(requests[0].body.hostReceipt.url, "http://127.0.0.1:19090/v1/events/delivery-1/receipt");

		acceptanceDeliveryId = "wrong-delivery";
		await assert.rejects(manager.acceptEvent({
			id: "delivery-2",
			leaseToken: "lease-2",
			source: "gmail-history",
			targetId: target.id,
			contextId: target.contextId,
			payloadJson: JSON.stringify({ providerMessageId: "message-2", providerThreadId: "thread-1" }),
		}), /acceptance receipt mismatch/);
	} finally {
		await close(resident);
	}
});

test("peer mismatch fails before runtime identity or message delivery", async () => {
	let requests = 0;
	const resident = createServer((_request, response) => {
		requests += 1;
		response.writeHead(500).end();
	});
	const port = await listen(resident);
	try {
		const target = residentTarget(port, { headscaleControlCommand: headscaleControlCommand({ id: 99 }) });
		const manager = new RuntimeManager({ targetsById: new Map([[target.id, target]]) }, { hasRunningEvent: () => false });
		await assert.rejects(manager.acceptEvent({
			id: "delivery-mismatch",
			leaseToken: "lease-mismatch",
			source: "gmail-history",
			targetId: target.id,
			contextId: target.contextId,
			payloadJson: "{}",
		}), /node ID mismatch/);
		assert.equal(requests, 0);

		const offlineTarget = residentTarget(port, {
			tailnetStatusCommand: tailnetStatusCommand({ Online: false }),
		});
		const offlineManager = new RuntimeManager({ targetsById: new Map([[offlineTarget.id, offlineTarget]]) }, {
			hasRunningEvent: () => false,
		});
		await assert.rejects(offlineManager.acceptEvent({
			id: "delivery-offline",
			leaseToken: "lease-offline",
			source: "gmail-history",
			targetId: offlineTarget.id,
			contextId: offlineTarget.contextId,
			payloadJson: "{}",
		}), /tailnet peer is not online/);
		assert.equal(requests, 0);
	} finally {
		await close(resident);
	}
});

test("resident application identity mismatch fails before message delivery", async () => {
	let identity = { headscaleNodeId: 42, runtimeIdentity: "wrong-runtime" };
	let deliveries = 0;
	const resident = createServer((request, response) => {
		if (request.url === "/email/identity") {
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(identity));
			return;
		}
		if (request.url === "/email/inbound") deliveries += 1;
		response.writeHead(200).end("ok");
	});
	const port = await listen(resident);
	try {
		const target = residentTarget(port);
		const manager = new RuntimeManager({ targetsById: new Map([[target.id, target]]) }, { hasRunningEvent: () => false });
		const event = {
			id: "delivery-identity-mismatch",
			leaseToken: "lease-identity-mismatch",
			source: "gmail-history",
			targetId: target.id,
			contextId: target.contextId,
			payloadJson: "{}",
		};
		await assert.rejects(manager.acceptEvent(event), /resident runtime identity mismatch/);
		identity = { headscaleNodeId: 99, runtimeIdentity: "example-resident" };
		await assert.rejects(manager.acceptEvent(event), /resident runtime Headscale node identity mismatch/);
		assert.equal(deliveries, 0);
	} finally {
		await close(resident);
	}
});

test("remote resident rejects identity redirects instead of following an alternate endpoint", async () => {
	let redirectedRequests = 0;
	const resident = createServer((request, response) => {
		if (request.url === "/email/identity") {
			response.writeHead(302, { location: "/alternate-identity" }).end();
			return;
		}
		redirectedRequests += 1;
		response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
			headscaleNodeId: 42,
			runtimeIdentity: "example-resident",
		}));
	});
	const port = await listen(resident);
	try {
		const target = residentTarget(port);
		const manager = new RuntimeManager({ targetsById: new Map([[target.id, target]]) }, { hasRunningEvent: () => false });
		await assert.rejects(manager.acceptEvent({
			id: "delivery-redirect",
			leaseToken: "lease-redirect",
			source: "gmail-history",
			targetId: target.id,
			contextId: target.contextId,
			payloadJson: "{}",
		}));
		assert.equal(redirectedRequests, 0);
	} finally {
		await close(resident);
	}
});

test("lost completion responses reconcile idempotently under the original durable lease", async () => {
	const target = residentTarget(1);
	const event = {
		id: "delivery-completed",
		targetId: target.id,
		contextId: target.contextId,
		status: "completed",
		leaseToken: null,
		completionLeaseToken: "lease-completed",
	};
	let receiptCalls = 0;
	const server = createHostServer({
		config: { server: {}, targetsById: new Map([[target.id, target]]) },
		store: { getEvent: (id) => id === event.id ? event : null },
		scheduler: { receipt: () => { receiptCalls += 1; } },
		daemon: {},
	});
	const port = await listen(server);
	const token = contextCapability(target.inboundToken, "receipt", target.contextId);
	const post = async (leaseToken, status = "completed") => await fetch(
		`http://127.0.0.1:${port}/v1/events/${event.id}/receipt`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ lease_token: leaseToken, status }),
		},
	);
	try {
		const retry = await post("lease-completed");
		assert.equal(retry.status, 200);
		assert.deepEqual(await retry.json(), { ok: true, status: "completed", duplicate: true });
		assert.equal(receiptCalls, 0);
		assert.equal((await post("wrong-lease")).status, 409);
		assert.equal((await post("lease-completed", "failed")).status, 409);
	} finally {
		await close(server);
	}
});

test("Hostd durably deduplicates guest History events before exact acknowledgement and immediate pump", async () => {
	const target = residentTarget(1);
	const events = new Map();
	const positions = new Map();
	let failPositionWrite = false;
	let pumps = 0;
	const store = {
		getEventByProviderMessage: (source, id) => events.get(`${source}:${id}`),
		upsertEvent: (event) => {
			const key = `${event.source}:${event.providerMessageId}`;
			if (!events.has(key)) events.set(key, { ...event, status: "queued" });
			return events.get(key);
		},
		markSeen: (source, id, disposition) => {
			if (failPositionWrite) {
				failPositionWrite = false;
				throw new Error("synthetic position crash");
			}
			positions.set(`${source}:${id}`, disposition);
		},
	};
	const server = createHostServer({
		config: { server: {}, targetsById: new Map([[target.id, target]]) },
		store,
		scheduler: { pump: () => { pumps += 1; } },
		daemon: {},
	});
	const port = await listen(server);
	const token = contextCapability(target.outboundToken, "gmail-history-ingress", target.contextId);
	const body = {
		contextId: target.contextId,
		mailbox: target.mailbox,
		historyId: "101",
		providerMessageId: "message-1",
		providerThreadId: "thread-1",
		sender: "sender@example.com",
		fromFull: "Sender <sender@example.com>",
		to: target.mailbox,
		subject: "Hello",
		body: "Synthetic body",
		allRecipients: [target.mailbox],
	};
	try {
		for (const duplicate of [false, true]) {
			const response = await fetch(`http://127.0.0.1:${port}/v1/inbound/gmail-history`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			assert.equal(response.status, 202);
			const receipt = await response.json();
			assert.equal(receipt.accepted, true);
			assert.equal(receipt.duplicate, duplicate);
			assert.equal(receipt.providerMessageId, "message-1");
			assert.equal(receipt.historyId, "101");
		}
		assert.equal(events.size, 1);
		assert.equal(positions.get("gmail-history-position:example-resident:101"), "message-1");
		assert.equal(pumps, 2);

		failPositionWrite = true;
		const crashed = await fetch(`http://127.0.0.1:${port}/v1/inbound/gmail-history`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ ...body, historyId: "102", providerMessageId: "message-2" }),
		});
		assert.equal(crashed.status, 500);
		assert.equal(events.has("gmail-history:message-2"), true);
		const recovered = await fetch(`http://127.0.0.1:${port}/v1/inbound/gmail-history`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ ...body, historyId: "102", providerMessageId: "message-2" }),
		});
		assert.equal(recovered.status, 202);
		assert.equal((await recovered.json()).duplicate, true);
		assert.equal(positions.get("gmail-history-position:example-resident:102"), "message-2");

		const wrongMailbox = await fetch(`http://127.0.0.1:${port}/v1/inbound/gmail-history`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ ...body, mailbox: "other@example.com", providerMessageId: "message-2" }),
		});
		assert.equal(wrongMailbox.status, 403);
		const wrongToken = await fetch(`http://127.0.0.1:${port}/v1/inbound/gmail-history`, {
			method: "POST",
			headers: { authorization: "Bearer wrong", "content-type": "application/json" },
			body: JSON.stringify({ ...body, providerMessageId: "message-3" }),
		});
		assert.equal(wrongToken.status, 401);
	} finally {
		await close(server);
	}
});
