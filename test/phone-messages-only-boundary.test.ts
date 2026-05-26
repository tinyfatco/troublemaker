import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneMessagingWebhookAdapter } from "../src/adapters/phone-messaging-webhook.js";
import type { PhoneChannelRecord, PhoneMessagingProvider, PhoneSendRequest, PhoneSendResult } from "../src/adapters/phone-messaging/types.js";
import type { MomEvent } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

type Sent = { channelId: string; text: string };

function makeAdapter(workingDir: string, sent: Sent[]): PhoneMessagingWebhookAdapter {
	const provider: PhoneMessagingProvider = {
		name: "test",
		sendMessage: async (request: PhoneSendRequest): Promise<PhoneSendResult> => {
			sent.push({ channelId: request.channel.channelId, text: request.text });
			return { providerMessageId: `phone-${sent.length}` };
		},
	};
	const adapter = new PhoneMessagingWebhookAdapter({
		workingDir,
		registry: {
			available: () => ["test"],
			select: () => provider,
		},
	});
	const record: PhoneChannelRecord = {
		channelId: "phone-test",
		provider: "test",
		transport: "sms",
		conversationId: "conversation",
		from: "+15555550123",
		sender: "+15555550100",
		participants: ["+15555550100", "+15555550123"],
		displayName: "sms/+15555550123",
		updatedAt: new Date().toISOString(),
	};
	(adapter as unknown as { channels: Map<string, PhoneChannelRecord> }).channels.set(record.channelId, record);
	return adapter;
}

function makeEvent(): MomEvent {
	return {
		type: "dm",
		channel: "phone-test",
		ts: "2026-05-26T00:00:00.000Z",
		user: "+15555550123",
		text: "hello",
		attachments: [],
	};
}

async function run() {
	const workingDir = mkdtempSync(join(tmpdir(), "tm-phone-boundary-"));
	try {
		const sent: Sent[] = [];
		const adapter = makeAdapter(workingDir, sent);

		{
			const ctx = adapter.createContext(makeEvent(), {} as ChannelStore);
			await ctx.respond("ordinary transcript that must not leak");
			await ctx.sendFinalResponse("ordinary final transcript that must not leak");
			await ctx.setWorking(false);
			assert.equal(sent.length, 0, "phone suppresses ordinary harness final response");
		}

		{
			const ctx = adapter.createContext(makeEvent(), {} as ChannelStore);
			await ctx.sendFinalResponse("_Sorry, something went wrong: test failure_", { force: true });
			await ctx.setWorking(false);
			assert.equal(sent.length, 1, "phone still sends forced runtime errors");
			assert.match(sent[0].text, /test failure/);
		}

		console.log("phone-messages-only-boundary ok");
	} finally {
		rmSync(workingDir, { recursive: true, force: true });
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
