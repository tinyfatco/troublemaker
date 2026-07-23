import assert from "node:assert/strict";
import { LoopProvider } from "../src/adapters/phone-messaging/loop-provider.js";
import { createPhoneProviderRegistryFromEnv } from "../src/adapters/phone-messaging/registry.js";
import type { PhoneChannelRecord } from "../src/adapters/phone-messaging/types.js";

const directChannel: PhoneChannelRecord = {
	channelId: "phone-loop-example",
	provider: "loop",
	transport: "imessage",
	conversationId: "loop-conversation-example",
	from: "+15550002222",
	sender: "+15550001111",
	participants: ["+15550001111", "+15550002222"],
	outboundRecipients: ["+15550002222"],
	displayName: "imessage/+15550002222",
	updatedAt: new Date().toISOString(),
	providerData: { senderId: "sender-from-channel" },
};

async function main(): Promise<void> {
	const originalFetch = globalThis.fetch;
	const originalEnv = {
		LOOPMESSAGE_API_KEY: process.env.LOOPMESSAGE_API_KEY,
		LOOPMESSAGE_BASE_URL: process.env.LOOPMESSAGE_BASE_URL,
		LOOPMESSAGE_SENDER_ID: process.env.LOOPMESSAGE_SENDER_ID,
		MOM_PHONE_SEND_URL: process.env.MOM_PHONE_SEND_URL,
		MOM_PHONE_SEND_TOKEN: process.env.MOM_PHONE_SEND_TOKEN,
		FAT_TOOLS_TOKEN: process.env.FAT_TOOLS_TOKEN,
		MOM_PHONE_DEFAULT_PROVIDER: process.env.MOM_PHONE_DEFAULT_PROVIDER,
	};
	const captured: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		captured.push({ input, init });
		return Response.json({ success: true, message_id: `loop-message-${captured.length}` });
	}) as typeof fetch;

	try {
		const provider = new LoopProvider({
			apiKey: "loop-key-example",
			baseUrl: "https://loop.example/",
			senderId: "sender-from-config",
		});
		const directResult = await provider.sendMessage({ channel: directChannel, text: "Direct reply" });
		assert.equal(directResult.providerMessageId, "loop-message-1");
		assert.equal(directResult.transport, "imessage");
		assert.equal(captured[0].input, "https://loop.example/api/v1/message/send/");
		assert.equal(new Headers(captured[0].init?.headers).get("authorization"), "loop-key-example");
		assert.equal(new Headers(captured[0].init?.headers).get("authorization")?.startsWith("Bearer "), false);
		assert.deepEqual(JSON.parse(String(captured[0].init?.body)), {
			text: "Direct reply",
			passthrough: JSON.stringify({
				channelId: "phone-loop-example",
				conversationId: "loop-conversation-example",
			}),
			contact: "+15550002222",
			sender: "sender-from-channel",
			channel: "imessage",
		});

		const groupChannel: PhoneChannelRecord = {
			...directChannel,
			conversationId: "loop-group-example",
			providerData: { groupId: "group-example" },
		};
		await provider.sendMessage({ channel: groupChannel, text: "Group reply", preferredTransport: "sms" });
		const groupBody = JSON.parse(String(captured[1].init?.body));
		assert.equal(groupBody.group, "group-example");
		assert.equal(groupBody.contact, undefined);
		assert.equal(groupBody.sender, "sender-from-config");
		assert.equal(groupBody.channel, "sms");

		await assert.rejects(
			provider.sendMessage({
				channel: directChannel,
				text: "attachment",
				attachments: [{ filePath: "/tmp/example", filename: "example.txt" }],
			}),
			/local file attachments/,
		);

		process.env.LOOPMESSAGE_API_KEY = "loop-key-from-env";
		process.env.LOOPMESSAGE_BASE_URL = "https://loop-env.example";
		process.env.LOOPMESSAGE_SENDER_ID = "loop-sender-from-env";
		delete process.env.MOM_PHONE_SEND_URL;
		delete process.env.MOM_PHONE_SEND_TOKEN;
		delete process.env.FAT_TOOLS_TOKEN;
		delete process.env.MOM_PHONE_DEFAULT_PROVIDER;
		const registry = createPhoneProviderRegistryFromEnv();
		assert.deepEqual(registry.available(), ["loop"]);
		assert.equal(registry.select(directChannel).name, "loop");
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}

	console.log("phone-messaging-loop-provider ok");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
