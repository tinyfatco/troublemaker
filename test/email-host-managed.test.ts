import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailWebhookAdapter } from "../src/adapters/email-webhook.js";
import type { MomEvent, MomHandler, SlashCommandResult } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

const workingDir = mkdtempSync(join(tmpdir(), "tm-email-host-managed-"));
const originalFetch = globalThis.fetch;

function adapterWithPayload() {
	const adapter = new EmailWebhookAdapter({
		workingDir,
		toolsToken: "context-scoped-token",
		sendUrl: "http://host.containers.internal:3099/v1/outbound/gmail",
	});
	const channelId = "email-thread-native_thread_123";
	(adapter as unknown as {
		pendingPayloads: Map<string, Record<string, unknown>>;
	}).pendingPayloads.set(channelId, {
		from: "customer@example.com",
		to: "agent@example.com",
		subject: "Website update",
		body: "Please update the homepage.",
		providerMessageId: "native_message_123",
		providerThreadId: "native_thread_123",
		deliveryId: "delivery-123",
		hostContextId: "front-desk:private-principal:intake",
	});
	const event: MomEvent = {
		type: "dm",
		channel: channelId,
		ts: "1710000000000",
		user: "customer@example.com",
		text: "Subject: Website update\n\nPlease update the homepage.",
		attachments: [],
	};
	return { adapter, channelId, event };
}

async function run() {
	try {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return new Response(JSON.stringify({ ok: true, messageId: "native_reply_123" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const success = adapterWithPayload();
		const context = success.adapter.createContext(success.event, {} as ChannelStore);
		await success.adapter.postMessage(success.channelId, "I’ll handle the homepage update.");
		await context.setWorking(false);

		assert.equal(calls.length, 1);
		const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
		assert.equal(body.provider_thread_id, "native_thread_123");
		assert.equal(body.context_id, "front-desk:private-principal:intake");
		assert.equal(body.delivery_id, "delivery-123");
		assert.equal(body.idempotency_key, "delivery-123:message");
		assert.equal(body.agent_body, "I’ll handle the homepage update.");
		assert.match(String(body.body), /Please update the homepage/);

		calls.length = 0;
		writeFileSync(join(workingDir, "email-thread-events.jsonl"), `${JSON.stringify({
			type: "inbound",
			at: "2026-07-23T20:59:51.410Z",
			channelId: "email-thread-deadbeefcafebabe",
			from: "customer@example.com",
			to: ["agent@example.com"],
			subject: "Website update",
			body: "Please update the homepage.",
			messageId: "0123456789abcdef",
		})}\n`);
		const storedThreadAdapter = new EmailWebhookAdapter({
			workingDir,
			toolsToken: "context-scoped-token",
			sendUrl: "http://host.containers.internal:3099/v1/outbound/gmail",
			hostContextId: "front-desk:private-principal:intake",
		});
		await storedThreadAdapter.postMessage(
			"email-thread:deadbeefcafebabe",
			"Following up in the native Gmail thread.",
		);
		assert.equal(calls.length, 1);
		const storedBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
		assert.equal(storedBody.provider_thread_id, "deadbeefcafebabe");
		assert.equal(storedBody.context_id, "front-desk:private-principal:intake");
		assert.match(String(storedBody.delivery_id), /^explicit-[0-9a-f-]{36}$/);
		assert.match(String(storedBody.idempotency_key), /^explicit-[0-9a-f-]{36}:message$/);
		assert.equal(storedBody.agent_body, "Following up in the native Gmail thread.");
		assert.match(String(storedBody.body), /Please update the homepage/);

		globalThis.fetch = (async () => new Response(
			JSON.stringify({ error: "conversation_scope_denied" }),
			{ status: 403, headers: { "content-type": "application/json" } },
		)) as typeof fetch;
		const failure = adapterWithPayload();
		const failedContext = failure.adapter.createContext(failure.event, {} as ChannelStore);
		await assert.rejects(
			failure.adapter.postMessage(failure.channelId, "This must not be acknowledged as delivered."),
			/Email send failed/,
		);
		await assert.rejects(
			failedContext.setWorking(false),
			/attempted but never delivered/,
		);
		globalThis.fetch = originalFetch;

		let handled = 0;
		const deliveryAdapter = new EmailWebhookAdapter({
			workingDir,
			toolsToken: "context-scoped-token",
			sendUrl: "http://host.containers.internal:3099/v1/outbound/gmail",
			inboundToken: "private-inbound-token",
		});
		const handler: MomHandler = {
			isRunning: () => false,
			handleEvent: async () => {
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
				handled++;
			},
			handleSlashCommand: async (): Promise<SlashCommandResult> => false,
			handleSteer: () => {},
			handleStop: async () => {},
			resolvePendingInput: () => false,
		};
		deliveryAdapter.setHandler(handler);
		const server = createServer((request, response) => deliveryAdapter.dispatch(request, response));
		await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
		const address = server.address();
		assert(address && typeof address === "object");
		const inbound = {
			from: "customer@example.com",
			to: "agent@example.com",
			subject: "Native delivery",
			body: "Handle exactly once.",
			providerThreadId: "native_thread_once",
			deliveryId: "delivery-once",
		};
		try {
			for (const duplicate of [false, true]) {
				const response = await fetch(`http://127.0.0.1:${address.port}`, {
					method: "POST",
					headers: {
						authorization: "Bearer private-inbound-token",
						"content-type": "application/json",
						"x-troublemaker-wait-for-completion": "1",
					},
					body: JSON.stringify(inbound),
				});
				assert.equal(response.status, 200);
				const receipt = await response.json() as { duplicate?: boolean };
				assert.equal(receipt.duplicate, duplicate);
			}
			assert.equal(handled, 1);
		} finally {
			await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
		}
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(workingDir, { recursive: true, force: true });
	}
}

run().then(() => {
	console.log("email-host-managed ok");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
