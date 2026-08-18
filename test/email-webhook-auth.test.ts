import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

console.log("email webhook auth ok");
