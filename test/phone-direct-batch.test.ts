import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentHostDeliveryScope } from "../src/adapters/host-delivery-scope.js";
import { PhoneMessagingWebhookAdapter } from "../src/adapters/phone-messaging-webhook.js";
import type { PhoneProviderRegistry } from "../src/adapters/phone-messaging/registry.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import { TINYFAT_WEBSITE_INQUIRY_INTENT } from "../src/tinyfat-operator-intent.js";

const CHANNEL_ID = "phone-0123456789abcdef0123";
const CONTEXT_ID = "front-desk:0123456789abcdef01234567:relationship-operator";
const TOKEN = "relationship-inbound-token";

function adapter(
	workingDir: string,
	events: MomEvent[],
	steers: MomEvent[],
	scopes: unknown[] = [],
): PhoneMessagingWebhookAdapter {
	const instance = new PhoneMessagingWebhookAdapter({
		workingDir,
		registry: { available: () => [] } as unknown as PhoneProviderRegistry,
	});
	instance.setHandler({
		resolvePendingInput: () => false,
		handleSlashCommand: async () => false,
		isRunning: () => false,
		handleEvent: async (event: MomEvent) => {
			scopes.push(currentHostDeliveryScope());
			events.push(event);
		},
		handleSteer: async (event: MomEvent) => { steers.push(event); },
	} as unknown as MomHandler);
	return instance;
}

async function serve(instance: PhoneMessagingWebhookAdapter): Promise<{
	endpoint: string;
	close: () => Promise<void>;
}> {
	const server = createServer((request, response) => instance.dispatch(request, response));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
	return {
		endpoint: `http://127.0.0.1:${address.port}/phone-messaging/webhook`,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}

async function post(endpoint: string, payload: Record<string, unknown>): Promise<Response> {
	return fetch(endpoint, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(payload),
	});
}

function batchPayload(): Record<string, unknown> {
	const messages = [
		{
			messageId: "provider-message-one",
			text: "I need a new website.",
			timestamp: "2026-08-31T05:00:00.000Z",
			deliveryId: "phone:provider-message-one",
			operatorIntent: TINYFAT_WEBSITE_INQUIRY_INTENT,
		},
		{
			messageId: "provider-message-two",
			text: "It is for a neighborhood bakery.",
			timestamp: "2026-08-31T05:00:00.400Z",
			deliveryId: "phone:provider-message-two",
		},
		{
			messageId: "provider-message-three",
			text: "We already have a logo but no site.",
			timestamp: "2026-08-31T05:00:00.900Z",
			deliveryId: "phone:provider-message-three",
		},
	];
	return {
		provider: "hostd",
		hostManaged: true,
		transport: "sms",
		direction: "inbound",
		status: "received",
		messageId: messages[0].messageId,
		conversationId: CHANNEL_ID,
		channelId: CHANNEL_ID,
		displayName: "SMS •••• 0123",
		from: "Phone ending 0123",
		sender: "hostd",
		text: messages[0].text,
		timestamp: messages[0].timestamp,
		hostContextId: CONTEXT_ID,
		deliveryId: messages[0].deliveryId,
		operatorIntent: TINYFAT_WEBSITE_INQUIRY_INTENT,
		messages,
	};
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
}

async function main(): Promise<void> {
	const workingDir = mkdtempSync(join(tmpdir(), "phone-direct-batch-"));
	const previousToken = process.env.MOM_PHONE_INBOUND_TOKEN;
	const previousHostManaged = process.env.MOM_PHONE_HOST_MANAGED;
	process.env.MOM_PHONE_INBOUND_TOKEN = TOKEN;
	process.env.MOM_PHONE_HOST_MANAGED = "true";
	const events: MomEvent[] = [];
	const steers: MomEvent[] = [];
	const scopes: unknown[] = [];
	const first = adapter(workingDir, events, steers, scopes);
	const firstServer = await serve(first);
	let secondServer: Awaited<ReturnType<typeof serve>> | undefined;
	try {
		const payload = batchPayload();
		const accepted = await post(firstServer.endpoint, payload);
		assert.equal(accepted.status, 200);
		await waitFor(() => events.length === 1, "direct batch did not reach the Operator");
		assert.equal(events.length, 1, "the full burst creates exactly one Operator turn");
		assert.equal(steers.length, 0);
		const [event] = events;
		assert.equal(event.type, "dm");
		assert.equal(event.sourceEventType, "phone_message");
		assert.equal(event.directlyAddressed, true);
		assert.deepEqual(scopes, [{
			source: "hostd-phone",
			eventId: "phone:provider-message-three",
			eventIds: [
				"phone:provider-message-one",
				"phone:provider-message-two",
				"phone:provider-message-three",
			],
			replyTarget: CHANNEL_ID,
		}], "the Operator turn is bound to every durable batch identity in order");
		assert.equal(currentHostDeliveryScope(), undefined, "the exact batch scope clears after the turn");
		assert.equal(event.channel, CHANNEL_ID);
		assert.equal(event.replyTarget, CHANNEL_ID);
		assert.equal(event.trustedOperatorIntent, TINYFAT_WEBSITE_INQUIRY_INTENT);
		assert.match(event.text, /^Recent messages:\n/);
		assert.equal(event.rawText, event.text, "all burst context remains in raw history");
		assert.equal(event.text.toLowerCase().includes("ambient"), false, "a customer burst is never ambient");
		const bodies = [
			"I need a new website.",
			"It is for a neighborhood bakery.",
			"We already have a logo but no site.",
		];
		let previousIndex = -1;
		for (const body of bodies) {
			const index = event.text.indexOf(body);
			assert.ok(index > previousIndex, `missing or out-of-order body: ${body}`);
			previousIndex = index;
		}

		const history = readFileSync(join(workingDir, "log.jsonl"), "utf8")
			.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(history.map((entry) => [entry.providerMessageId, entry.deliveryId, entry.text]), [
			["provider-message-one", "phone:provider-message-one", bodies[0]],
			["provider-message-two", "phone:provider-message-two", bodies[1]],
			["provider-message-three", "phone:provider-message-three", bodies[2]],
		]);
		const ledger = readFileSync(join(workingDir, "phone-inbound-deliveries.jsonl"), "utf8")
			.trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(ledger.length, 1, "all identities commit in one durable ledger record");
		assert.deepEqual(ledger[0].deliveryIds, [
			"phone:provider-message-one",
			"phone:provider-message-two",
			"phone:provider-message-three",
		]);

		const restartedEvents: MomEvent[] = [];
		const restarted = adapter(workingDir, restartedEvents, []);
		secondServer = await serve(restarted);
		assert.equal((await post(secondServer.endpoint, payload)).status, 200);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(restartedEvents.length, 0, "a restart cannot replay any completed batch identity");

		const duplicateDelivery = structuredClone(payload) as { messages: Array<Record<string, unknown>> };
		duplicateDelivery.messages[1].deliveryId = duplicateDelivery.messages[0].deliveryId;
		assert.equal((await post(firstServer.endpoint, duplicateDelivery)).status, 400);
		const crossedPrimary = structuredClone(payload) as { messages: Array<Record<string, unknown>> };
		crossedPrimary.messages[0].text = "forged mismatch";
		assert.equal((await post(firstServer.endpoint, crossedPrimary)).status, 400);
		const forgedIntent = structuredClone(payload) as { messages: Array<Record<string, unknown>> };
		forgedIntent.messages[1].operatorIntent = "untrusted_action";
		assert.equal((await post(firstServer.endpoint, forgedIntent)).status, 400);
		assert.equal(events.length, 1, "invalid batches never reach the Operator");
	} finally {
		await secondServer?.close();
		await firstServer.close();
		if (previousToken === undefined) delete process.env.MOM_PHONE_INBOUND_TOKEN;
		else process.env.MOM_PHONE_INBOUND_TOKEN = previousToken;
		if (previousHostManaged === undefined) delete process.env.MOM_PHONE_HOST_MANAGED;
		else process.env.MOM_PHONE_HOST_MANAGED = previousHostManaged;
		rmSync(workingDir, { recursive: true, force: true });
	}
	console.log("phone-direct-batch ok");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
