import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneMessagingWebhookAdapter } from "../src/adapters/phone-messaging-webhook.js";
import type { PhoneProviderRegistry } from "../src/adapters/phone-messaging/registry.js";
import type { MomHandler } from "../src/adapters/types.js";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-phone-host-failure-"));
const previousManaged = process.env.MOM_PHONE_HOST_MANAGED;
const previousToken = process.env.MOM_PHONE_INBOUND_TOKEN;
process.env.MOM_PHONE_HOST_MANAGED = "true";
process.env.MOM_PHONE_INBOUND_TOKEN = "example-inbound-token";

const receiptStatuses: string[] = [];
const receiptServer = createServer((request, response) => {
	assert.equal(request.headers.authorization, "Bearer example-receipt-token");
	const chunks: Buffer[] = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => {
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status: string; error?: string };
		receiptStatuses.push(body.status);
		if (body.status === "completed_with_failure") assert.equal(body.error, "model_credential_unavailable");
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => receiptServer.listen(0, "127.0.0.1", resolve));
const receiptAddress = receiptServer.address();
if (!receiptAddress || typeof receiptAddress === "string") throw new Error("receipt server did not bind TCP");

const adapter = new PhoneMessagingWebhookAdapter({
	workingDir,
	registry: { available: () => [] } as unknown as PhoneProviderRegistry,
});
adapter.setHandler({
	resolvePendingInput: () => false,
	handleSlashCommand: async () => false,
	isRunning: () => false,
	handleEvent: async () => ({
		stopReason: "error",
		errorMessage: "synthetic unavailable credential",
		failureKind: "model_credential_unavailable",
	}),
} as unknown as MomHandler);

const webhookServer = createServer((request, response) => adapter.dispatch(request, response));
await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
const webhookAddress = webhookServer.address();
if (!webhookAddress || typeof webhookAddress === "string") throw new Error("webhook server did not bind TCP");

try {
	const response = await fetch(`http://127.0.0.1:${webhookAddress.port}/phone-messaging/webhook`, {
		method: "POST",
		headers: {
			authorization: "Bearer example-inbound-token",
			"content-type": "application/json",
			"x-tinyfat-hostd-verified": "true",
		},
		body: JSON.stringify({
			provider: "hostd",
			hostManaged: true,
			transport: "sms",
			direction: "inbound",
			status: "received",
			messageId: "example-provider-message",
			conversationId: "phone-0123456789abcdef0123",
			channelId: "phone-0123456789abcdef0123",
			displayName: "SMS ending 0123",
			from: "SMS ending 0123",
			sender: "hostd",
			text: "Example inbound request",
			timestamp: "2030-01-01T00:00:00.000Z",
			hostContextId: "operator:0123456789abcdef01234567:intake",
			deliveryId: "example-delivery-id",
			hostReceipt: {
				url: `http://127.0.0.1:${receiptAddress.port}/receipt`,
				token: "example-receipt-token",
				leaseToken: "example-lease-token",
			},
		}),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	await waitFor(() => receiptStatuses.length === 2, "operational failure receipt was not reported");
	assert.deepEqual(receiptStatuses, ["running", "completed_with_failure"]);
	assert.equal(receiptStatuses.includes("failed"), false);
	const ledgerPath = join(workingDir, "phone-inbound-deliveries.jsonl");
	await waitFor(
		() => existsSync(ledgerPath) && readFileSync(ledgerPath, "utf8").includes('"deliveryId":"example-delivery-id"'),
		"completed delivery ledger was not written",
	);
	assert.match(readFileSync(ledgerPath, "utf8"), /"deliveryId":"example-delivery-id"/);
} finally {
	await new Promise<void>((resolve, reject) => webhookServer.close((error) => error ? reject(error) : resolve()));
	await new Promise<void>((resolve, reject) => receiptServer.close((error) => error ? reject(error) : resolve()));
	if (previousManaged === undefined) delete process.env.MOM_PHONE_HOST_MANAGED;
	else process.env.MOM_PHONE_HOST_MANAGED = previousManaged;
	if (previousToken === undefined) delete process.env.MOM_PHONE_INBOUND_TOKEN;
	else process.env.MOM_PHONE_INBOUND_TOKEN = previousToken;
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("phone host-managed failure detection ok");
