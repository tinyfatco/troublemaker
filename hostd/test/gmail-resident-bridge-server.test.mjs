import assert from "node:assert/strict";
import test from "node:test";
import { createGmailResidentBridgeServer, runtimeEmailDeliverer } from "../src/gmail-resident-bridge-server.mjs";

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function identity() {
	return { runtimeIdentity: "runtime-identity", headscaleNodeId: 42 };
}

function inbound() {
	return {
		from: "person@example.com",
		fromFull: "Person <person@example.com>",
		to: "agent@example.com",
		subject: "Synthetic",
		body: "Synthetic body",
		providerMessageId: "message-1",
		providerThreadId: "thread-1",
		deliveryId: "delivery-1",
		hostContextId: "example-resident",
		hostReceipt: {
			url: "http://127.0.0.1:19090/v1/events/delivery-1/receipt",
			token: "receipt-token",
			leaseToken: "lease-token",
		},
	};
}

test("resident relay authenticates identity and delegates completion receipts to the canonical runtime", async () => {
	const runtimePayloads = [];
	const server = createGmailResidentBridgeServer({
		contextId: "example-resident",
		identity: identity(),
		identityToken: "identity-token",
		inboundToken: "context-inbound-token",
		runtimeDeliver: async (payload) => runtimePayloads.push(payload),
	});
	const base = await listen(server);
	try {
		assert.equal((await fetch(`${base}/email/identity`)).status, 401);
		const identityResponse = await fetch(`${base}/email/identity`, {
			headers: { authorization: "Bearer identity-token" },
		});
		assert.deepEqual(await identityResponse.json(), identity());

		const response = await fetch(`${base}/email/inbound`, {
			method: "POST",
			headers: {
				authorization: "Bearer context-inbound-token",
				"content-type": "application/json",
			},
			body: JSON.stringify(inbound()),
		});
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), {
			accepted: true,
			deliveryId: "delivery-1",
			runtimeIdentity: "runtime-identity",
			headscaleNodeId: 42,
		});
		await server.waitForActive();
		assert.equal(runtimePayloads.length, 1);
		assert.deepEqual(runtimePayloads[0].hostReceipt, inbound().hostReceipt);
		assert.equal(runtimePayloads[0].providerMessageId, "message-1");
	} finally {
		await close(server);
	}
});

test("bridge acceptance never reports model-turn completion", async () => {
	let runtimeAccepted = false;
	let turnDone = false;
	let releaseTurn;
	const turn = new Promise((resolve) => { releaseTurn = resolve; });
	const server = createGmailResidentBridgeServer({
		contextId: "example-resident",
		identity: identity(),
		identityToken: "identity-token",
		inboundToken: "context-inbound-token",
		runtimeDeliver: async (payload) => {
			runtimeAccepted = true;
			assert.deepEqual(payload.hostReceipt, inbound().hostReceipt);
			await turn;
			turnDone = true;
		},
	});
	const base = await listen(server);
	try {
		const response = await fetch(`${base}/email/inbound`, {
			method: "POST",
			headers: { authorization: "Bearer context-inbound-token", "content-type": "application/json" },
			body: JSON.stringify(inbound()),
		});
		assert.equal(response.status, 202);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(runtimeAccepted, true);
		assert.equal(turnDone, false);
		releaseTurn();
		await server.waitForActive();
		assert.equal(turnDone, true);
	} finally {
		releaseTurn();
		await close(server);
	}
});

test("resident relay fails closed on context, receipt transport, and outbound Gmail", async () => {
	const server = createGmailResidentBridgeServer({
		contextId: "example-resident",
		identity: identity(),
		identityToken: "identity-token",
		inboundToken: "context-inbound-token",
		runtimeDeliver: async () => {},
	});
	const base = await listen(server);
	try {
		const wrongContext = await fetch(`${base}/email/inbound`, {
			method: "POST",
			headers: { authorization: "Bearer context-inbound-token", "content-type": "application/json" },
			body: JSON.stringify({ ...inbound(), hostContextId: "other-context" }),
		});
		assert.equal(wrongContext.status, 400);
		const publicReceipt = await fetch(`${base}/email/inbound`, {
			method: "POST",
			headers: { authorization: "Bearer context-inbound-token", "content-type": "application/json" },
			body: JSON.stringify({ ...inbound(), hostReceipt: { ...inbound().hostReceipt, url: "https://example.com/receipt" } }),
		});
		assert.equal(publicReceipt.status, 400);
		assert.equal((await fetch(`${base}/v1/outbound/gmail`, { method: "POST" })).status, 503);
	} finally {
		await close(server);
	}
});

test("runtime deliverer pins guest loopback and rejects redirects", async () => {
	const calls = [];
	const deliver = runtimeEmailDeliverer({
		url: "http://127.0.0.1:3018/email/inbound",
		token: "runtime-token",
		fetchImpl: async (url, options) => {
			calls.push({ url: String(url), options });
			return new Response("accepted", { status: 202 });
		},
	});
	await deliver({ deliveryId: "gmail:message-1", body: "synthetic" });
	assert.equal(calls[0].options.redirect, "error");
	assert.equal(calls[0].options.headers.authorization, "Bearer runtime-token");
	await assert.rejects(async () => runtimeEmailDeliverer({
		url: "http://192.0.2.1:3018/email/inbound",
		token: "runtime-token",
	}), /guest loopback/);
});
