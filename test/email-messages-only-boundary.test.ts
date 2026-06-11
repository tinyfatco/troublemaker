import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailWebhookAdapter } from "../src/adapters/email-webhook.js";
import { collectEmailThreadListings } from "../src/adapters/email/thread-ledger.js";
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

		{
			const calls: FetchCall[] = [];
			installFetchRecorder(calls);
			const adapter = makeAdapter(workingDir);
			writeFileSync(join(workingDir, "email-thread-events.jsonl"), [
				{
					type: "inbound",
					at: "2026-05-26T10:00:00.000Z",
					channelId: "email-alex_example_com",
					from: "alex@example.com",
					to: ["zip@tinyfat.ai"],
					subject: "Project timing",
					body: "Please keep this in the existing Gmail thread.",
					messageId: "<email-thread-root@example.com>",
					references: "<older-root@example.com>",
				},
			].map((row) => JSON.stringify(row)).join("\n") + "\n");
			const target = collectEmailThreadListings(workingDir)[0]?.sendTarget;
			assert.ok(target, "email ledger exposes a thread target");

			await adapter.postMessage(target, "thread-selected reply");

			assert.equal(calls.length, 1, "email-thread target sends exactly one email");
			const metadata = readJsonBody(calls[0]?.body);
			assert.equal(metadata.to, "alex@example.com");
			assert.equal(metadata.subject, "Re: Project timing");
			assert.equal(metadata.in_reply_to, "<email-thread-root@example.com>");
			assert.match(String(metadata.references), /<older-root@example.com>/);
			assert.match(String(metadata.references), /<email-thread-root@example.com>/);
			assert.match(String(metadata.body), /thread-selected reply/);
			assert.match(String(metadata.body), /existing Gmail thread/);
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
