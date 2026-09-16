import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailWebhookAdapter, matchesBearerToken } from "../src/adapters/email-webhook.js";

assert.equal(matchesBearerToken("Bearer relay-secret", "relay-secret"), true);
assert.equal(matchesBearerToken("bearer relay-secret", "relay-secret"), true);
assert.equal(matchesBearerToken("relay-secret", "relay-secret"), false);
assert.equal(matchesBearerToken("Bearer  relay-secret", "relay-secret"), false);
assert.equal(matchesBearerToken("Bearer wrong", "relay-secret"), false);
assert.equal(matchesBearerToken(undefined, "relay-secret"), false);

const workingDir = mkdtempSync(join(tmpdir(), "tm-email-webhook-auth-"));
try {
	for (const inboundToken of [undefined, "email-inbound-token-example-32-bytes"] as const) {
		const adapter = new EmailWebhookAdapter({
			workingDir,
			toolsToken: "fake-tools-token",
			sendUrl: "https://example.invalid/send",
			inboundToken,
		});
		const server = createServer((request, response) => adapter.dispatch(request, response));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			assert(address && typeof address === "object");
			const endpoint = `http://127.0.0.1:${address.port}/email/inbound`;
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					authorization: "Bearer email-inbound-token-example-32-bytes",
					"content-type": "application/json",
				},
				body: "not json",
			});
			assert.equal(response.status, inboundToken ? 400 : 401);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	}
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

const completionDir = mkdtempSync(join(tmpdir(), "tm-email-host-completion-"));
const originalFetch = globalThis.fetch;
try {
	writeFileSync(
		join(completionDir, "email-inbound-deliveries.jsonl"),
		`${JSON.stringify({ deliveryId: "delivery-1", completedAt: new Date().toISOString() })}\n`,
		{ mode: 0o600 },
	);
	const statuses: string[] = [];
	let rejectCompletion = true;
	globalThis.fetch = async (_input, init) => {
		assert.equal(init?.redirect, "error");
		const status = JSON.parse(String(init?.body)).status as string;
		statuses.push(status);
		if (status === "completed" && rejectCompletion) return new Response("unavailable", { status: 503 });
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	};
	const first = new EmailWebhookAdapter({
		workingDir: completionDir,
		toolsToken: "fake-tools-token",
		sendUrl: "https://example.invalid/send",
		inboundToken: "email-inbound-token-example-32-bytes",
	});
	first.setHandler({} as never);
	await first.start();
	const server = createServer((request, response) => first.dispatch(request, response));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert(address && typeof address === "object");
		const response = await originalFetch(`http://127.0.0.1:${address.port}/email/inbound`, {
			method: "POST",
			headers: {
				authorization: "Bearer email-inbound-token-example-32-bytes",
				"content-type": "application/json",
				"x-troublemaker-wait-for-completion": "1",
			},
			body: JSON.stringify({
				from: "person@example.com",
				to: "agent@example.com",
				subject: "Synthetic",
				body: "Synthetic body",
				deliveryId: "delivery-1",
				hostReceipt: {
					url: "http://127.0.0.1:19090/v1/events/delivery-1/receipt",
					token: "receipt-token",
					leaseToken: "lease-token",
				},
			}),
		});
		assert.equal(response.status, 500);
		assert.deepEqual(statuses, ["running", "completed"]);
		assert.equal(statuses.includes("failed"), false, "terminal receipt failure must not downgrade accepted work");
		const pending = JSON.parse(readFileSync(join(completionDir, "email-host-completions.json"), "utf8"));
		assert.equal(pending[0].deliveryId, "delivery-1");
	} finally {
		await first.stop();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}

	rejectCompletion = false;
	const second = new EmailWebhookAdapter({
		workingDir: completionDir,
		toolsToken: "fake-tools-token",
		sendUrl: "https://example.invalid/send",
		inboundToken: "email-inbound-token-example-32-bytes",
	});
	second.setHandler({} as never);
	await second.start();
	await second.stop();
	assert.equal(statuses.at(-1), "completed");
	assert.deepEqual(JSON.parse(readFileSync(join(completionDir, "email-host-completions.json"), "utf8")), []);
} finally {
	globalThis.fetch = originalFetch;
	rmSync(completionDir, { recursive: true, force: true });
}

console.log("email webhook auth ok");
