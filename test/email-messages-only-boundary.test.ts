import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailWebhookAdapter } from "../src/adapters/email-webhook.js";
import type { MomEvent } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

type FetchCall = { url: string; body: unknown };

function installFetchRecorder(calls: FetchCall[]) {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			body: init?.body,
		});
		return new Response(JSON.stringify({ ok: true, messageId: `msg-${calls.length}` }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

function makeAdapter(workingDir: string): EmailWebhookAdapter {
	return new EmailWebhookAdapter({
		workingDir,
		toolsToken: "test-token",
		sendUrl: "https://example.invalid/send",
	});
}

function seedPendingPayload(adapter: EmailWebhookAdapter, channelId: string) {
	(adapter as unknown as {
		pendingPayloads: Map<string, {
			from: string;
			to: string;
			subject: string;
			body: string;
			messageId?: string;
			references?: string;
			allRecipients?: string[];
		}>;
	}).pendingPayloads.set(channelId, {
		from: "alex@example.com",
		to: "zip@tinyfat.com",
		subject: "Re: Thread",
		body: "please reply",
		messageId: "<incoming@example.com>",
		references: "<root@example.com>",
		allRecipients: ["zip@tinyfat.com"],
	});
}

function makeEvent(channelId: string): MomEvent {
	return {
		type: "dm",
		channel: channelId,
		ts: "1710000000000",
		user: "alex@example.com",
		text: "Subject: Re: Thread\n\nplease reply",
		attachments: [],
	};
}

function readJsonBody(body: unknown): Record<string, unknown> {
	assert.equal(typeof body, "string");
	return JSON.parse(body as string) as Record<string, unknown>;
}

async function run() {
	const workingDir = mkdtempSync(join(tmpdir(), "tm-email-boundary-"));
	const originalFetch = globalThis.fetch;

	try {
		writeFileSync(join(workingDir, "settings.json"), JSON.stringify({ verbose: { default: "messages-only" } }));

		{
			const calls: FetchCall[] = [];
			installFetchRecorder(calls);
			const adapter = makeAdapter(workingDir);
			const channelId = "email-alex_example_com";
			seedPendingPayload(adapter, channelId);
			const ctx = adapter.createContext(makeEvent(channelId), {} as ChannelStore);

			await ctx.respond("thinking transcript that must not leak");
			await ctx.sendFinalResponse("ordinary final transcript that must not leak");
			await ctx.setWorking(false);

			assert.equal(calls.length, 0, "messages-only email suppresses ordinary final transcript");
		}

		{
			const calls: FetchCall[] = [];
			installFetchRecorder(calls);
			const adapter = makeAdapter(workingDir);
			const channelId = "email-alex_example_com";
			seedPendingPayload(adapter, channelId);
			const ctx = adapter.createContext(makeEvent(channelId), {} as ChannelStore);

			await adapter.postMessage("email-alex@example.com", "explicit threaded reply");
			await ctx.sendFinalResponse("duplicate adapter transcript");
			await ctx.setWorking(false);

			assert.equal(calls.length, 1, "explicit active-thread email send suppresses adapter final duplicate");
			const metadata = readJsonBody(calls[0]?.body);
			assert.match(String(metadata.body), /explicit threaded reply/);
			assert.doesNotMatch(String(metadata.body), /duplicate adapter transcript/);
		}

		{
			const calls: FetchCall[] = [];
			installFetchRecorder(calls);
			const adapter = makeAdapter(workingDir);
			const channelId = "email-alex_example_com";
			seedPendingPayload(adapter, channelId);
			const ctx = adapter.createContext(makeEvent(channelId), {} as ChannelStore);

			await ctx.sendFinalResponse("_Sorry, something went wrong: test failure_", { force: true });
			await ctx.setWorking(false);

			assert.equal(calls.length, 1, "forced runtime errors still send in messages-only email");
			const metadata = readJsonBody(calls[0]?.body);
			assert.match(String(metadata.body), /test failure/);
		}
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(workingDir, { recursive: true, force: true });
	}
}

run().then(() => {
	console.log("email-messages-only-boundary ok");
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
