import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhoneMessagingWebhookAdapter } from "../src/adapters/phone-messaging-webhook.js";
import type { PhoneChannelRecord, PhoneMessagingProvider, PhoneSendRequest, PhoneSendResult } from "../src/adapters/phone-messaging/types.js";
import type { MomEvent } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

type Sent = { channelId: string; text: string; outboundRecipients?: string[]; transport?: string };

function makeAdapter(workingDir: string, sent: Sent[]): PhoneMessagingWebhookAdapter {
	const provider: PhoneMessagingProvider = {
		name: "test",
		sendMessage: async (request: PhoneSendRequest): Promise<PhoneSendResult> => {
			sent.push({
				channelId: request.channel.channelId,
				text: request.text,
				outboundRecipients: request.channel.outboundRecipients,
				transport: request.channel.transport,
			});
			return { providerMessageId: `phone-${sent.length}`, transport: request.channel.transport };
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

		{
			const ts = await adapter.postMessageToRecipients("phone-test", "hello both", ["+15555550124", "+15555550124"]);
			assert.equal(ts, "phone-2", "phone explicit recipient send returns provider message id");
			assert.deepEqual(sent[1].outboundRecipients, ["+15555550123", "+15555550124"], "phone explicit recipients merge with original contact");
			assert.equal(sent[1].transport, "mms", "phone explicit recipients promote transport to mms");
			const record = (adapter as unknown as { channels: Map<string, PhoneChannelRecord> }).channels.get("phone-test");
			assert.deepEqual(record?.outboundRecipients, ["+15555550123", "+15555550124"], "phone explicit recipients persist on channel record");
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
