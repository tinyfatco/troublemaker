import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackBase, type SlackBaseConfig } from "../src/adapters/slack-base.js";
import type { MomEvent } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

type PostedMessage = {
	channel: string;
	text: string;
	thread_ts?: string;
};

class TestSlackAdapter extends SlackBase {
	posted: PostedMessage[] = [];

	constructor(workingDir: string) {
		const store = { processAttachments: () => [] } as unknown as ChannelStore;
		const config: SlackBaseConfig = { botToken: "xoxb-test", workingDir, store };
		super(config);
		this.webClient = {
			chat: {
				postMessage: async (payload: PostedMessage) => {
					this.posted.push(payload);
					return { ts: `posted-${this.posted.length}` };
				},
				update: async () => {},
				delete: async () => {},
			},
			files: { uploadV2: async () => {} },
		} as any;
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
}

function event(overrides: Partial<MomEvent> = {}): MomEvent {
	return {
		type: "mention",
		channel: "C123",
		ts: "1710000000.000100",
		threadTs: "1710000000.000001",
		user: "U123",
		text: "hello",
		...overrides,
	};
}

async function exerciseContext(adapter: TestSlackAdapter, incoming: MomEvent): Promise<PostedMessage[]> {
	const ctx = adapter.createContext(incoming, {} as ChannelStore);
	await ctx.setTyping(true);
	await ctx.respondInThread("tool detail");
	await ctx.sendFinalResponse("final answer");
	return adapter.posted;
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-slack-placement-"));

try {
	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { default: true },
		slack: { responsePlacement: "thread" },
	}));

	const threaded = new TestSlackAdapter(workingDir);
	let posted = await exerciseContext(threaded, event());
	assert.equal(posted.length, 3);
	assert.equal(posted[0]?.thread_ts, "1710000000.000001", "working output enters the inbound Slack thread");
	assert.equal(posted[1]?.thread_ts, "1710000000.000001", "detail output stays in the inbound Slack thread");
	assert.equal(posted[2]?.thread_ts, "1710000000.000001", "final output stays in the inbound Slack thread");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { default: true },
		slack: { responsePlacement: "channel" },
	}));

	const channel = new TestSlackAdapter(workingDir);
	posted = await exerciseContext(channel, event());
	assert.equal(posted.length, 3);
	assert.equal(posted[0]?.thread_ts, undefined, "working output is a new top-level channel message");
	assert.equal(posted[1]?.thread_ts, "posted-1", "detail output keeps the legacy working-message subthread");
	assert.equal(posted[2]?.thread_ts, undefined, "final output is a new top-level channel message");

	const dm = new TestSlackAdapter(workingDir);
	posted = await exerciseContext(dm, event({ type: "dm", channel: "D123", threadTs: undefined }));
	assert.equal(posted[0]?.thread_ts, undefined, "Slack DMs remain top-level when no inbound thread exists");
	assert.equal(posted[2]?.thread_ts, undefined, "Slack DM final output remains top-level");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { slack: "messages-only" },
		slack: { responsePlacement: "thread", toolStreaming: "important" },
	}));
	const selective = new TestSlackAdapter(workingDir);
	const selectiveContext = selective.createContext(event(), {} as ChannelStore);
	await selectiveContext.setTyping(true);
	await selectiveContext.respond("_→ Routine read_", false, { show: false });
	await selectiveContext.respond("_→ Checking the deployed revision_", false, { show: true });
	await selectiveContext.respondInThread("raw tool arguments and result");
	await selectiveContext.sendFinalResponse("ordinary harness final");
	assert.equal(selective.posted.length, 1, "messages-only Slack emits only the selected safe tool label");
	assert.equal(selective.posted[0]?.thread_ts, "1710000000.000001", "selected label enters the inbound Slack thread");
	assert.match(selective.posted[0]?.text || "", /Checking the deployed revision/, "selected label text is visible");
	assert.doesNotMatch(selective.posted[0]?.text || "", /raw tool arguments/, "raw tool detail remains suppressed");

	console.log("slack-response-placement ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
