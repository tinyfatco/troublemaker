import assert from "node:assert/strict";
import test from "node:test";
import { createHostServer } from "../src/server.mjs";
import { contextCapability } from "../src/security.mjs";
import { HostServiceMailbox } from "../src/service-mailbox.mjs";

test("Hostd service-mailbox routes require the dedicated exact-context capability", async () => {
	const contextId = "front-desk:relationship:relationship-example";
	const grant = { targetId: "front-desk", contextId, address: "scout@example.com" };
	const target = {
		id: "front-desk",
		driver: "oci",
		inboundToken: "synthetic-inbound-secret",
		outboundToken: "synthetic-outbound-secret",
	};
	const config = {
		server: {},
		scheduler: { maxConcurrent: 1 },
		targetsById: new Map([[target.id, target]]),
		serviceMailbox: {
			provider: "resend",
			apiKey: "re_synthetic_service_mailbox_key",
			requestTimeoutMs: 5_000,
			maximumScanPages: 1,
			grants: [grant],
			grantsByContextId: new Map([[contextId, grant]]),
		},
	};
	const providerRequests = [];
	const serviceMailboxGateway = new HostServiceMailbox(config, {
		fetch: async (input) => {
			providerRequests.push(String(input));
			return new Response(JSON.stringify({
				has_more: false,
				data: [{
					id: "mail_owner_1",
					to: ["scout@example.com"],
					from: "sender@example.com",
					subject: "Example",
					created_at: "2026-08-25T12:00:00.000Z",
				}],
			}), { status: 200 });
		},
	});
	const store = {
		activeMcpInstructionForContext() { return null; },
	};
	const server = createHostServer({
		config,
		store,
		daemon: { polling: false },
		serviceMailboxGateway,
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const endpoint = `http://127.0.0.1:${address.port}/v1/service-mailbox/list`;
	const post = (selectedContextId, token) => fetch(endpoint, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ context_id: selectedContextId, limit: 5 }),
	});
	try {
		const wrongPurpose = await post(
			contextId,
			contextCapability(target.outboundToken, "outbound", contextId),
		);
		assert.equal(wrongPurpose.status, 401);

		const otherContextId = "front-desk:relationship:someone-else";
		const crossContext = await post(
			otherContextId,
			contextCapability(target.outboundToken, "service-mailbox", otherContextId),
		);
		assert.equal(crossContext.status, 403);
		assert.deepEqual(await crossContext.json(), { error: "service_mailbox_scope_denied" });
		assert.equal(providerRequests.length, 0);

		const allowed = await post(
			contextId,
			contextCapability(target.outboundToken, "service-mailbox", contextId),
		);
		assert.equal(allowed.status, 200);
		assert.deepEqual((await allowed.json()).messages.map((message) => message.email_id), ["mail_owner_1"]);
		assert.equal(providerRequests.length, 1);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => (
			error ? reject(error) : resolvePromise()
		)));
	}
});
