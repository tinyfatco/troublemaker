import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneMessagingWebhookAdapter } from "../src/adapters/phone-messaging-webhook.js";
import type { PhoneProviderRegistry } from "../src/adapters/phone-messaging/registry.js";

async function main(): Promise<void> {
	const workingDir = mkdtempSync(join(tmpdir(), "tm-phone-auth-"));
	const previous = process.env.MOM_PHONE_INBOUND_TOKEN;
	process.env.MOM_PHONE_INBOUND_TOKEN = "resident-token-example";
	const adapter = new PhoneMessagingWebhookAdapter({
		workingDir,
		registry: {
			available: () => [],
		} as unknown as PhoneProviderRegistry,
	});
	const server = createServer((request, response) => adapter.dispatch(request, response));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
		const endpoint = `http://127.0.0.1:${address.port}/phone-messaging/webhook`;
		const payload = {
			provider: "sendly",
			messageId: "message-example",
			conversationId: "conversation-example",
			from: "+15550002222",
			to: "+15550001111",
			sender: "+15550001111",
			text: "delivery receipt",
			direction: "outbound",
			status: "delivered",
		};

		const unauthenticated = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(unauthenticated.status, 401);

		const authenticated = await fetch(endpoint, {
			method: "POST",
			headers: { Authorization: "Bearer resident-token-example", "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(authenticated.status, 200);
		assert.deepEqual(await authenticated.json(), { ok: true });

		const forgedVerificationHeader = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: "Bearer wrong-token",
				"X-Crawdad-VPS-Verified": "true",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		assert.equal(forgedVerificationHeader.status, 401);

		delete process.env.MOM_PHONE_INBOUND_TOKEN;
		const missingServerSecret = await fetch(endpoint, {
			method: "POST",
			headers: { Authorization: "Bearer resident-token-example", "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		assert.equal(missingServerSecret.status, 401, "phone ingress fails closed without a configured secret");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		if (previous === undefined) delete process.env.MOM_PHONE_INBOUND_TOKEN;
		else process.env.MOM_PHONE_INBOUND_TOKEN = previous;
		rmSync(workingDir, { recursive: true, force: true });
	}
	console.log("phone-messaging-webhook-auth ok");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
