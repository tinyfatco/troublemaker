import assert from "node:assert/strict";
import { TwilioProvider } from "../src/adapters/phone-messaging/twilio-provider.js";
import type { PhoneChannelRecord } from "../src/adapters/phone-messaging/types.js";

type CapturedFetch = {
	url: string;
	init: RequestInit;
	params: URLSearchParams;
};

const originalFetch = globalThis.fetch;

function makeChannel(overrides: Partial<PhoneChannelRecord> = {}): PhoneChannelRecord {
	return {
		channelId: "phone-group",
		provider: "twilio",
		transport: "mms",
		conversationId: "+15555550100:group:+15555550123,+15555550124",
		from: "+15555550123",
		sender: "+15555550100",
		participants: ["+15555550100", "+15555550123", "+15555550124"],
		outboundRecipients: ["+15555550123", "+15555550124"],
		displayName: "mms/+15555550123",
		updatedAt: "2026-06-24T00:00:00.000Z",
		...overrides,
	};
}

async function captureSend(channel: PhoneChannelRecord): Promise<{ captured: CapturedFetch; transport?: string }> {
	let captured: CapturedFetch | undefined;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const body = init?.body;
		assert(body instanceof URLSearchParams, "Twilio request body is form encoded URLSearchParams");
		captured = {
			url: String(url),
			init: init || {},
			params: new URLSearchParams(body.toString()),
		};
		return new Response(JSON.stringify({ sid: "MMtest", status: "queued" }), {
			status: 201,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	const provider = new TwilioProvider({
		accountSid: "AC123",
		authToken: "secret",
	});
	const result = await provider.sendMessage({ channel, text: "Group reply" });
	assert(captured, "fetch captured");
	return { captured, transport: result.transport };
}

async function run() {
	try {
		{
			const { captured, transport } = await captureSend(makeChannel());
			assert.equal(captured.url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
			assert.equal(captured.params.get("To"), "+15555550123");
			assert.equal(captured.params.get("OtherRecipients0"), "+15555550124");
			assert.equal(captured.params.get("From"), "+15555550100");
			assert.equal(captured.params.get("Body"), "Group reply");
			assert.equal(transport, "mms");
		}

		{
			const { captured, transport } = await captureSend(makeChannel({
				transport: "sms",
				conversationId: "+15555550100:+15555550123",
				participants: ["+15555550100", "+15555550123"],
				outboundRecipients: ["+15555550123"],
			}));
			assert.equal(captured.params.get("To"), "+15555550123");
			assert.equal(captured.params.has("OtherRecipients0"), false);
			assert.equal(transport, "sms");
		}

		{
			const { captured } = await captureSend(makeChannel({
				outboundRecipients: ["+15555550100", "+15555550123", "+15555550124"],
			}));
			assert.equal(captured.params.get("To"), "+15555550123");
			assert.equal(captured.params.get("OtherRecipients0"), "+15555550124");
			assert.equal(captured.params.has("OtherRecipients1"), false);
		}

		console.log("phone-messaging-twilio-provider ok");
	} finally {
		globalThis.fetch = originalFetch;
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
