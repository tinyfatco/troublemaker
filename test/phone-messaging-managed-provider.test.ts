import assert from "node:assert/strict";
import { ManagedPhoneProvider } from "../src/adapters/phone-messaging/managed-provider.js";
import type { PhoneChannelRecord } from "../src/adapters/phone-messaging/types.js";

const channel: PhoneChannelRecord = {
	channelId: "phone-example",
	provider: "sendly",
	transport: "sms",
	conversationId: "+15550001111:+15550002222",
	from: "+15550002222",
	sender: "+15550001111",
	participants: ["+15550001111", "+15550002222"],
	outboundRecipients: ["+15550002222"],
	displayName: "sms/+15550002222",
	updatedAt: new Date().toISOString(),
	providerData: { messagingConversationId: "conversation-example" },
};

async function main(): Promise<void> {
	let captured: { input?: RequestInfo | URL; init?: RequestInit } = {};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		captured = { input, init };
		return Response.json({
			ok: true,
			provider: "sendly",
			providerMessageId: "message-example",
			transport: "sms",
			status: "queued",
		});
	}) as typeof fetch;

	try {
		const provider = new ManagedPhoneProvider({
			endpoint: "https://bridge.example/agents/agent-example/phone/send",
			token: "tools-token-example",
			providerName: "sendly",
		});
		const result = await provider.sendMessage({ channel, text: "Hello from the resident", preferredTransport: "sms" });
		assert.equal(provider.name, "sendly");
		assert.equal(result.providerMessageId, "message-example");
		assert.equal(result.transport, "sms");
		assert.equal(captured.input, "https://bridge.example/agents/agent-example/phone/send");
		assert.equal(new Headers(captured.init?.headers).get("authorization"), "Bearer tools-token-example");
		const body = JSON.parse(String(captured.init?.body));
		assert.deepEqual(body, {
			provider: "sendly",
			transport: "sms",
			threadTarget: "phone-example",
			conversationId: "+15550001111:+15550002222",
			from: "+15550001111",
			to: "+15550002222",
			recipients: ["+15550002222"],
			body: "Hello from the resident",
			providerData: { messagingConversationId: "conversation-example" },
		});

		await assert.rejects(
			provider.sendMessage({
				channel,
				text: "attachment",
				attachments: [{ filePath: "/tmp/example", filename: "example.txt" }],
			}),
			/local attachments/,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
	console.log("phone-messaging-managed-provider ok");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
