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
	nativeStarts: any[] = [];
	nativeAppends: any[] = [];
	nativeStops: any[] = [];

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
				startStream: async (payload: any) => {
					this.nativeStarts.push(payload);
					return { ts: `native-${this.nativeStarts.length}` };
				},
				appendStream: async (payload: any) => { this.nativeAppends.push(payload); },
				stopStream: async (payload: any) => { this.nativeStops.push(payload); },
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
		replyTarget: "slack:C123:1710000000.000001",
		replyTargetDescription: "Slack thread under this direct mention",
		directlyAddressed: true,
		user: "U123",
		text: "hello",
		...overrides,
	};
}

async function exerciseContext(adapter: TestSlackAdapter, incoming: MomEvent): Promise<PostedMessage[]> {
	const ctx = adapter.createContext(incoming, {} as ChannelStore);
	await ctx.setTyping(true);
	await ctx.respond("_→ Test operation_", false, { show: true });
	await ctx.respondInThread("tool detail");
	await ctx.sendFinalResponse("final answer");
	return adapter.posted;
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-slack-placement-"));

try {
	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { default: true },
	}));

	const threaded = new TestSlackAdapter(workingDir);
	let posted = await exerciseContext(threaded, event());
	assert.equal(posted.length, 3);
	assert.doesNotMatch(posted[0]?.text || "", /Thinking/, "default working output starts with the operation arrow");
	assert.equal(posted[0]?.thread_ts, "1710000000.000001", "default working output enters the inbound Slack thread");
	assert.equal(posted[1]?.thread_ts, "1710000000.000001", "default detail output stays in the inbound Slack thread");
	assert.equal(posted[2]?.thread_ts, "1710000000.000001", "default final output stays in the inbound Slack thread");

	// An explicit channel override moves the whole delivery locus. It must not
	// leave the agent targeting the inbound thread while harness UI goes top-level.
	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { default: true },
		slack: { responsePlacement: "channel" },
	}));

	const channelTargetContext = new TestSlackAdapter(workingDir).createContext(event(), {} as ChannelStore);
	assert.equal(channelTargetContext.message.replyTarget, "C123", "channel override changes the suggested send_message target to channel top level");
	assert.equal(channelTargetContext.message.threadTs, undefined, "channel override does not advertise a competing delivery thread");

	const channel = new TestSlackAdapter(workingDir);
	posted = await exerciseContext(channel, event());
	assert.equal(posted.length, 3);
	assert.equal(posted[0]?.thread_ts, undefined, "channel override moves working output to channel top level");
	assert.equal(posted[1]?.thread_ts, "posted-1", "channel override keeps tool detail under its working message");
	assert.equal(posted[2]?.thread_ts, undefined, "channel override moves harness final output to channel top level");

	const dm = new TestSlackAdapter(workingDir);
	posted = await exerciseContext(dm, event({ type: "dm", channel: "D123", threadTs: undefined }));
	assert.equal(posted[0]?.thread_ts, undefined, "Slack DMs remain top-level when no inbound thread exists");
	assert.equal(posted[2]?.thread_ts, undefined, "Slack DM final output remains top-level");

	rmSync(join(workingDir, "settings.json"), { force: true });
	const defaults = new TestSlackAdapter(workingDir);
	const defaultContext = defaults.createContext(event(), {} as ChannelStore);
	assert.equal(defaultContext.message.replyTarget, "slack:C123:1710000000.000001", "setting-free turn suggests its inbound thread for send_message");
	await defaultContext.setTyping(true);
	await defaultContext.respond("_→ Default selected label_", false, { show: true });
	await defaultContext.respondInThread("default raw tool detail");
	await defaultContext.sendFinalResponse("default ordinary harness final");
	assert.equal(defaults.posted.length, 1, "setting-free messages-only Slack emits only its selected safe label");
	assert.equal(defaults.posted[0]?.thread_ts, "1710000000.000001", "setting-free selected label stays in the inbound thread");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { slack: "messages-only" },
		slack: { toolStreaming: "important" },
	}));
	const selective = new TestSlackAdapter(workingDir);
	const selectiveContext = selective.createContext(event(), {} as ChannelStore);
	await selectiveContext.setTyping(true);
	assert.equal(selective.posted.length, 0, "headerless Slack does not post a blank thinking placeholder");
	await selectiveContext.respond("_→ Routine read_", false, { show: false });
	await selectiveContext.respond("_→ Checking the deployed revision_", false, { show: true });
	await selectiveContext.respondInThread("raw tool arguments and result");
	await selectiveContext.sendFinalResponse("ordinary harness final");
	assert.equal(selective.posted.length, 1, "messages-only Slack emits only the selected safe tool label");
	assert.equal(selective.posted[0]?.thread_ts, "1710000000.000001", "selected label enters the inbound Slack thread");
	assert.match(selective.posted[0]?.text || "", /Checking the deployed revision/, "selected label text is visible");
	assert.doesNotMatch(selective.posted[0]?.text || "", /Thinking/, "Slack working stream needs no Thinking header");
	assert.doesNotMatch(selective.posted[0]?.text || "", /raw tool arguments/, "raw tool detail remains suppressed");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { slack: "messages-only" },
		slack: { toolStreaming: "important", nativeProgress: true },
	}));
	const native = new TestSlackAdapter(workingDir);
	const nativeContext = native.createContext(event({ directlyAddressed: true, teamId: "T123" }), {} as ChannelStore);
	assert(nativeContext.updateToolProgress, "eligible direct Slack turn exposes native progress lifecycle");
	await nativeContext.updateToolProgress?.({ id: "tool-1", label: "Checking deployment health", status: "in_progress", show: true });
	await nativeContext.updateToolProgress?.({ id: "tool-1", label: "Checking deployment health", status: "complete", show: true });
	await nativeContext.setWorking(false);
	assert.equal(native.posted.length, 0, "native task lifecycle does not duplicate the edited-message renderer");
	assert.equal(native.nativeStarts[0]?.thread_ts, "1710000000.000001", "native task stream uses the inbound thread");
	assert.equal(native.nativeStarts[0]?.recipient_team_id, "T123", "native task stream binds the invoking workspace");
	assert.equal(native.nativeStarts[0]?.recipient_user_id, "U123", "native task stream binds the invoking user");
	assert.equal(native.nativeAppends[0]?.chunks?.[0]?.status, "complete", "native task completion updates the card");
	assert.deepEqual(native.nativeStops, [{ channel: "C123", ts: "native-1" }], "turn completion finalizes the native stream");

	for (const toolStreaming of ["important", "all"] as const) {
		writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
			verbose: { slack: "messages-only" },
			slack: { toolStreaming },
		}));
		const ambient = new TestSlackAdapter(workingDir);
		const ambientContext = ambient.createContext(event({ sourceEventType: "ambient_evaluation", directlyAddressed: false }), {} as ChannelStore);
		await ambientContext.respond(`_→ Ambient ${toolStreaming} label_`, false, { show: toolStreaming === "important" });
		assert.equal(ambient.posted.length, 1, `${toolStreaming} ambient tool stream emits one working message`);
		assert.equal(ambient.posted[0]?.thread_ts, "1710000000.000001", `${toolStreaming} ambient tool stream stays inline in the resolved thread`);
	}

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { slack: true },
		slack: { toolStreaming: "all" },
	}));
	const ambiguousAmbient = new TestSlackAdapter(workingDir);
	const ambiguousContext = ambiguousAmbient.createContext(event({
		sourceEventType: "ambient_evaluation",
		directlyAddressed: false,
		threadTs: undefined,
		replyTarget: undefined,
	}), {} as ChannelStore);
	await ambiguousContext.setTyping(true);
	await ambiguousContext.respond("_→ Must not leak to channel top level_", false, { show: true });
	await ambiguousContext.sendFinalResponse("ordinary ambiguous harness final");
	assert.equal(ambiguousAmbient.posted.length, 0, "ambiguous ambient wake suppresses all automatic top-level harness output");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { slack: "messages-only" },
		slack: { toolStreaming: "all" },
	}));
	const chronological = new TestSlackAdapter(workingDir);
	const chronologicalContext = chronological.createContext(event(), {} as ChannelStore);
	await chronologicalContext.respond("_→ Work before milestone_", false);
	await chronological.postInThread("C123", "1710000000.000001", "milestone");
	await chronologicalContext.restartWorking();
	await chronologicalContext.respond("_→ Work after milestone_", false);
	assert.equal(chronological.posted.length, 3, "working rollover creates a new segment after the user-visible milestone");
	assert.match(chronological.posted[0]?.text || "", /Work before milestone/, "first working segment stays before the milestone");
	assert.equal(chronological.posted[1]?.text, "milestone", "user-visible milestone remains in chronological position");
	assert.match(chronological.posted[2]?.text || "", /Work after milestone/, "later work opens a new segment after the milestone");
	assert.doesNotMatch(chronological.posted[0]?.text || "", /Work after milestone/, "later labels never mutate the earlier working segment");
	assert(chronological.posted.every((message) => message.thread_ts === "1710000000.000001"), "every chronological segment stays in the active thread");

	console.log("slack-response-placement ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
