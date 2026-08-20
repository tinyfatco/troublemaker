import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneMessagingWebhookAdapter } from "../src/adapters/phone-messaging-webhook.js";
import type { PhoneProviderRegistry } from "../src/adapters/phone-messaging/registry.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import {
	formatTrustedOperatorIntentSystemContext,
	TINYFAT_WEBSITE_INQUIRY_INTENT,
} from "../src/tinyfat-operator-intent.js";

const PREFILL = "Get me a TinyFat website!";

async function main(): Promise<void> {
	const workingDir = mkdtempSync(join(tmpdir(), "tinyfat-website-inquiry-"));
	const previousToken = process.env.MOM_PHONE_INBOUND_TOKEN;
	const previousHostManaged = process.env.MOM_PHONE_HOST_MANAGED;
	process.env.MOM_PHONE_INBOUND_TOKEN = "relationship-inbound-token";
	process.env.MOM_PHONE_HOST_MANAGED = "true";
	let resolveEvent!: (event: MomEvent) => void;
	const receivedEvent = new Promise<MomEvent>((resolve) => { resolveEvent = resolve; });
	const adapter = new PhoneMessagingWebhookAdapter({
		workingDir,
		registry: { available: () => [] } as unknown as PhoneProviderRegistry,
	});
	adapter.setHandler({
		resolvePendingInput: () => false,
		handleSlashCommand: async () => false,
		isRunning: () => false,
		handleEvent: async (event: MomEvent) => { resolveEvent(event); },
	} as unknown as MomHandler);
	const server = createServer((request, response) => adapter.dispatch(request, response));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
		const endpoint = `http://127.0.0.1:${address.port}/phone-messaging/webhook`;
		const payload = {
			provider: "hostd",
			hostManaged: true,
			transport: "sms",
			direction: "inbound",
			status: "received",
			messageId: "provider-message-first",
			conversationId: "phone-0123456789abcdef0123",
			channelId: "phone-0123456789abcdef0123",
			displayName: "SMS •••• 0123",
			from: "Phone ending 0123",
			sender: "hostd",
			text: PREFILL,
			hostContextId: "front-desk:0123456789abcdef01234567:relationship-operator",
			deliveryId: "phone:provider-message-first",
			operatorIntent: TINYFAT_WEBSITE_INQUIRY_INTENT,
		};
		const accepted = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer relationship-inbound-token",
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
		});
		assert.equal(accepted.status, 200);
		const event = await Promise.race([
			receivedEvent,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("event timeout")), 2_000)),
		]);
		assert.equal(event.text, PREFILL, "the Operator receives the exact customer message");
		assert.equal(event.rawText, PREFILL, "the original customer message remains the raw history text");
		assert.equal(event.trustedOperatorIntent, TINYFAT_WEBSITE_INQUIRY_INTENT);

		const history = readFileSync(join(workingDir, "log.jsonl"), "utf8");
		assert.equal(JSON.parse(history.trim()).text, PREFILL);
		assert.equal(history.includes("tinyfat_website_inquiry"), false);
		assert.equal(history.includes("campaign"), false);

		const systemContext = formatTrustedOperatorIntentSystemContext(event.trustedOperatorIntent);
		assert.match(systemContext, /expresses interest only/i);
		assert.match(systemContext, /not authorization to build, deploy, publish, charge/i);
		assert.match(systemContext, /greet the person/i);
		assert.match(systemContext, /builds and maintains websites/i);
		assert.match(systemContext, /ask one low-friction useful question/i);
		assert.match(systemContext, /what their business is and whether they already have a website/i);
		assert.match(systemContext, /helpful and non-pushy/i);
		assert.match(systemContext, /\$300 for the first year/);
		assert.match(systemContext, /Do not mention attribution, campaigns, prefilled text, routing/i);
		assert.match(systemContext, /authored by you through the relationship-scoped send_message tool/i);

		const forged = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: "Bearer relationship-inbound-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({ ...payload, hostManaged: false }),
		});
		assert.equal(forged.status, 400, "untrusted provider payloads cannot inject Operator intent");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		if (previousToken === undefined) delete process.env.MOM_PHONE_INBOUND_TOKEN;
		else process.env.MOM_PHONE_INBOUND_TOKEN = previousToken;
		if (previousHostManaged === undefined) delete process.env.MOM_PHONE_HOST_MANAGED;
		else process.env.MOM_PHONE_HOST_MANAGED = previousHostManaged;
		rmSync(workingDir, { recursive: true, force: true });
	}
	console.log("tinyfat-website-inquiry ok");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
