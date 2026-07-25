import assert from "node:assert/strict";
import { HostManagedPhoneProvider } from "../src/adapters/phone-messaging/host-managed-provider.js";
import type { PhoneChannelRecord } from "../src/adapters/phone-messaging/types.js";

async function run() {
	const originalFetch = globalThis.fetch;
	let sentBody: Record<string, unknown> | undefined;
	globalThis.fetch = async (_input, init) => {
		sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Response.json({
			ok: true,
			messageId: "provider-message-example",
			status: "queued",
		});
	};
	try {
		const provider = new HostManagedPhoneProvider({
			endpoint: "http://host.internal/v1/outbound/phone",
			token: "context-scoped-example-token",
			contextId: "front-desk:0123456789abcdef01234567:intake",
		});
		const channel: PhoneChannelRecord = {
			channelId: "phone-0123456789abcdef0123",
			provider: "hostd",
			transport: "sms",
			conversationId: "phone-0123456789abcdef0123",
			from: "SMS •••• 0123",
			sender: "hostd",
			participants: [],
			displayName: "SMS •••• 0123",
			updatedAt: new Date().toISOString(),
			hostManaged: true,
			hostContextId: "front-desk:0123456789abcdef01234567:intake",
		};
		const receipt = await provider.sendMessage({
			channel,
			text: "An agent-authored direct reply.",
		});
		assert.equal(receipt.providerMessageId, "provider-message-example");
		assert.equal(sentBody?.context_id, channel.hostContextId);
		assert.equal(sentBody?.thread_target, channel.channelId);
		assert.equal(sentBody?.agent_body, "An agent-authored direct reply.");
		assert.match(String(sentBody?.idempotency_key), /^front-desk:.*:[a-f0-9]{24}$/);
		assert.equal("to" in (sentBody || {}), false);
		assert.equal("from" in (sentBody || {}), false);
		assert.equal("recipients" in (sentBody || {}), false);

		await assert.rejects(
			() => provider.sendMessage({
				channel: { ...channel, hostContextId: "front-desk:other:intake" },
				text: "Out of scope.",
			}),
			/outside this runtime context/,
		);
		await assert.rejects(
			() => provider.sendMessage({
				channel,
				text: "No media.",
				attachments: [{ filePath: "/tmp/example.png", filename: "example.png" }],
			}),
			/direct text messages only/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
	console.log("phone-host-managed ok");
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
