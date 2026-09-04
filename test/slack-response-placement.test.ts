import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackBase, type SlackBaseConfig } from "../src/adapters/slack-base.js";
import type { MomEvent } from "../src/adapters/types.js";
import {
	projectToolInvocationDetails,
	projectToolResultDetails,
} from "../src/console/tool-detail-projection.js";
import { routeWorkingOutputContext } from "../src/streaming/working-output.js";
import type { ChannelStore } from "../src/store.js";

type PostedMessage = {
	channel: string;
	text: string;
	thread_ts?: string;
	ts?: string;
};

class TestSlackAdapter extends SlackBase {
	posted: PostedMessage[] = [];
	messageUpdates: Array<{ channel: string; ts: string; text: string }> = [];
	deletedMessages: Array<{ channel: string; ts: string }> = [];
	fileUploads: any[] = [];
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
					const recorded = { ...payload, ts: `posted-${this.posted.length + 1}` };
					this.posted.push(recorded);
					return { ts: recorded.ts };
				},
				update: async (payload: { channel: string; ts: string; text: string }) => { this.messageUpdates.push(payload); },
				delete: async (payload: { channel: string; ts: string }) => { this.deletedMessages.push(payload); },
				startStream: async (payload: any) => {
					this.nativeStarts.push(payload);
					return { ts: `native-${this.nativeStarts.length}` };
				},
				appendStream: async (payload: any) => { this.nativeAppends.push(payload); },
				stopStream: async (payload: any) => { this.nativeStops.push(payload); },
			},
			files: { uploadV2: async (payload: any) => { this.fileUploads.push(payload); } },
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
	const attachmentPath = join(workingDir, "test-attachment.zip");
	writeFileSync(attachmentPath, "test attachment");

	const threaded = new TestSlackAdapter(workingDir);
	await threaded.postResponseMessage(event(), "_Stopping..._");
	assert.equal(threaded.posted[0]?.thread_ts, "1710000000.000001", "default control output enters the inbound Slack thread");
	threaded.posted.length = 0;
	await threaded.createContext(event(), {} as ChannelStore).uploadFile(attachmentPath, "threaded.zip");
	assert.equal(threaded.fileUploads[0]?.thread_ts, "1710000000.000001", "default attachment upload enters the inbound Slack thread");
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
	await channel.postResponseMessage(event(), "_Stopping..._");
	assert.equal(channel.posted[0]?.thread_ts, undefined, "channel override also moves control output to channel top level");
	channel.posted.length = 0;
	await channel.createContext(event(), {} as ChannelStore).uploadFile(attachmentPath, "channel.zip");
	assert.equal(channel.fileUploads[0]?.thread_ts, undefined, "channel override also moves attachment uploads to channel top level");
	posted = await exerciseContext(channel, event());
	assert.equal(posted.length, 3);
	assert.equal(posted[0]?.thread_ts, undefined, "channel override moves working output to channel top level");
	assert.equal(posted[1]?.thread_ts, "posted-1", "channel override keeps tool detail under its working message");
	assert.equal(posted[2]?.thread_ts, undefined, "channel override moves harness final output to channel top level");

	const dm = new TestSlackAdapter(workingDir);
	await dm.postResponseMessage(event({ type: "dm", channel: "D123", threadTs: undefined }), "_Nothing running_");
	assert.equal(dm.posted[0]?.thread_ts, undefined, "Slack DM control output remains top-level");
	dm.posted.length = 0;
	await dm.createContext(event({ type: "dm", channel: "D123", threadTs: undefined }), {} as ChannelStore).uploadFile(attachmentPath, "dm.zip");
	assert.equal(dm.fileUploads[0]?.thread_ts, undefined, "Slack DM attachment upload remains top-level");
	posted = await exerciseContext(dm, event({ type: "dm", channel: "D123", threadTs: undefined }));
	assert.equal(posted[0]?.thread_ts, undefined, "Slack DMs remain top-level when no inbound thread exists");
	assert.equal(posted[2]?.thread_ts, undefined, "Slack DM final output remains top-level");

	rmSync(join(workingDir, "settings.json"), { force: true });
	const defaults = new TestSlackAdapter(workingDir);
	const defaultContext = defaults.createContext(event(), {} as ChannelStore);
	assert.equal(defaultContext.message.replyTarget, "slack:C123:1710000000.000001", "setting-free turn suggests its inbound thread for send_message");
	assert.equal(defaultContext.workingStreamPresentation, "split", "setting-free Slack uses edited event-driven time windows");
	await defaultContext.setTyping(true);
	await defaultContext.respond("_→ Default routine label_", false, { show: false });
	await defaultContext.respondInThread("default raw tool detail");
	await defaultContext.sendFinalResponse("default ordinary harness final");
	assert.equal(defaults.posted.length, 1, "setting-free messages-only Slack emits routine labels in default all mode");
	assert.equal(defaults.posted[0]?.thread_ts, "1710000000.000001", "setting-free routine label stays in the inbound thread");

	writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
		verbose: { slack: "messages-only" },
		slack: { toolStreaming: "all", toolStreamPresentation: "split", toolStreamWindowMinutes: 5 },
	}));
	const fixedDestination = new TestSlackAdapter(workingDir);
	const fixedDestinationContext = fixedDestination.createWorkingOutputContext(
		{ platform: "slack", channelId: "C9999999999" },
		{} as ChannelStore,
		{ toolStreaming: "all", presentation: "split", windowMinutes: 5 },
	);
	await fixedDestinationContext.setTyping(true);
	await fixedDestinationContext.respond("_→ Fixed cross-channel label_", false);
	await fixedDestinationContext.respondInThread("raw fixed detail");
	await fixedDestinationContext.sendFinalResponse("ordinary fixed final");
	assert.equal(fixedDestination.posted.length, 1, "fixed working context emits only its safe tool-label message");
	assert.equal(fixedDestination.posted[0]?.channel, "C9999999999", "fixed working context uses the configured Slack channel");
	assert.equal(fixedDestination.posted[0]?.thread_ts, undefined, "fixed working output is stable top-level channel output, not a transient thread");
	assert.match(fixedDestination.posted[0]?.text || "", /Fixed cross-channel label/, "fixed working output preserves the standard label renderer");
	assert.doesNotMatch(fixedDestination.posted[0]?.text || "", /raw fixed detail|ordinary fixed final/, "fixed working output preserves the messages-only detail boundary");
	const fixedDmContext = new TestSlackAdapter(workingDir).createWorkingOutputContext(
		{ platform: "slack", channelId: "D9999999999" },
		{} as ChannelStore,
		{ toolStreaming: "all", presentation: "split", windowMinutes: 5 },
	);
	assert.equal(fixedDmContext.updateToolProgress, undefined, "fixed Slack DMs preserve the existing compact renderer");
	const fixedOffContext = new TestSlackAdapter(workingDir).createWorkingOutputContext(
		{ platform: "slack", channelId: "C9999999999" },
		{} as ChannelStore,
		{ toolStreaming: "off", presentation: "split", windowMinutes: 5 },
	);
	assert.equal(fixedOffContext.updateToolProgress, undefined, "fixed Slack output avoids detail projection when tool streaming is off");

	const multiplayer = new TestSlackAdapter(workingDir);
	const requestRootTs = "1710000000.000001";
	const sourceContext = multiplayer.createContext(event({ channel: "C123", threadTs: requestRootTs }), {} as ChannelStore);
	const routed = routeWorkingOutputContext({
		policy: { mode: "fixed", target: { platform: "slack", channelId: "C9999999999" } },
		sourceContext,
		adapters: [multiplayer],
		store: {} as ChannelStore,
		presentation: { toolStreaming: "all", presentation: "split", windowMinutes: 5 },
	});
	assert.equal(routed.message.channel, "C123", "the addressed source channel remains the turn identity");
	assert.equal(routed.workingReplyTarget, "C9999999999", "the dedicated Slack channel remains the working-output locus");
	assert(routed.updateToolProgress, "fixed Slack channels expose batched per-tool lifecycle updates");
	await routed.updateToolProgress?.({
		id: "tool-one",
		label: "Reading the project package.json",
		status: "in_progress",
		details: projectToolInvocationDetails({ name: "read", arguments: { path: "/tmp/example-one.txt", apiKey: "SYNTHETIC_SECRET_VALUE" } }),
	});
	await routed.updateToolProgress?.({
		id: "tool-one",
		label: "Reading the project package.json",
		status: "complete",
		details: projectToolResultDetails({ name: "read", result: "FIRST_RESULT person@example.com" }),
	});
	await routed.updateToolProgress?.({
		id: "tool-two",
		label: "Checking the working tree",
		status: "in_progress",
		details: projectToolInvocationDetails({ name: "bash", arguments: { command: "git status --short" } }),
	});
	await routed.updateToolProgress?.({
		id: "tool-two",
		label: "Checking the working tree",
		status: "error",
		details: projectToolResultDetails({ name: "bash", result: "SECOND_ERROR", isError: true }),
	});
	await routed.updateToolProgress?.({
		id: "tool-report",
		label: "Reporting check result",
		status: "in_progress",
		details: projectToolInvocationDetails({ name: "send_message", arguments: { target: `slack:C123:${requestRootTs}` } }),
	});
	const explicitFinalTs = await multiplayer.postInThread("C123", requestRootTs, "No.");
	await routed.updateToolProgress?.({
		id: "tool-report",
		label: "Reporting check result",
		status: "complete",
		details: projectToolResultDetails({ name: "send_message", result: "Delivered", durationMs: 50 }),
	});
	await routed.setWorking(false);

	const fixedRoots = multiplayer.posted.filter((message) => message.channel === "C9999999999" && !message.thread_ts);
	assert.equal(fixedRoots.length, 1, "two checks plus final reporting stay in one rolling-window batch root");
	const batchRoot = fixedRoots[0];
	const batchReplies = multiplayer.posted.filter((message) => message.channel === "C9999999999" && message.thread_ts === batchRoot?.ts);
	assert.equal(batchReplies.length, 3, "three tool calls create exactly three lifecycle replies");
	assert.deepEqual(batchReplies.map((message) => message.ts), ["posted-2", "posted-3", "posted-4"], "lifecycle replies retain tool start order");
	const finalBatchRoot = multiplayer.messageUpdates.filter((update) => update.ts === batchRoot?.ts).at(-1)?.text || "";
	assert.match(finalBatchRoot, /Reading the project package\.json/);
	assert.match(finalBatchRoot, /Checking the working tree/);
	assert.match(finalBatchRoot, /Reporting check result/);
	assert.doesNotMatch(finalBatchRoot, /\.\.\.$/, "turn finalization removes the batch spinner");
	assert(multiplayer.messageUpdates.some((update) => update.ts === "posted-2" && /✓ Reading[\s\S]*FIRST_RESULT/.test(update.text)), "first lifecycle reply coheres from input to result");
	assert(multiplayer.messageUpdates.some((update) => update.ts === "posted-3" && /✗ Checking[\s\S]*SECOND_ERROR/.test(update.text)), "failed lifecycle reply coheres in place");
	assert(multiplayer.messageUpdates.some((update) => update.ts === "posted-4" && /✓ Reporting[\s\S]*Delivered/.test(update.text)), "report lifecycle reply coheres in place");
	assert.doesNotMatch(JSON.stringify({ posted: multiplayer.posted, updates: multiplayer.messageUpdates }), /person@example\.com|SYNTHETIC_SECRET_VALUE/, "batch lifecycle replies retain the existing redaction boundary");
	const explicitFinal = multiplayer.posted.find((message) => message.ts === explicitFinalTs);
	assert.deepEqual(
		{ channel: explicitFinal?.channel, threadTs: explicitFinal?.thread_ts, text: explicitFinal?.text },
		{ channel: "C123", threadTs: requestRootTs, text: "No." },
		"authorized final output remains in the owner request thread",
	);
	await routed.deleteMessage();
	const ownedBatchIds = [batchRoot?.ts, ...batchReplies.map((message) => message.ts)].filter((value): value is string => Boolean(value)).sort();
	assert.deepEqual(multiplayer.deletedMessages.map((message) => message.ts).sort(), ownedBatchIds, "cleanup deletes the current batch root and its agent-owned lifecycle replies");
	assert(!multiplayer.deletedMessages.some((message) => message.ts === explicitFinalTs), "cleanup never deletes the separately authorized final reply");

	const boundary = new TestSlackAdapter(workingDir);
	const boundaryContext = boundary.createWorkingOutputContext(
		{ platform: "slack", channelId: "C9999999999" },
		{} as ChannelStore,
		{ toolStreaming: "all", presentation: "split", windowMinutes: 5 },
	);
	await boundaryContext.updateToolProgress?.({ id: "send-tool", label: "Posting status", status: "in_progress" });
	await boundary.postMessage("C9999999999", "Authorized visible status");
	await boundaryContext.updateToolProgress?.({ id: "send-tool", label: "Posting status", status: "complete", details: projectToolResultDetails({ name: "send_message", result: "Delivered" }) });
	await boundaryContext.restartWorking();
	await boundaryContext.updateToolProgress?.({ id: "after-send", label: "Work after status", status: "in_progress" });
	assert.deepEqual(
		boundary.posted.filter((message) => !message.thread_ts).map((message) => message.text),
		["_→ Posting status_ ...", "Authorized visible status", "_→ Work after status_ ..."],
		"an explicit-send rollover keeps later batch work below the authorized message",
	);

	const realDateNow = Date.now;
	let fakeNow = 1_000_000;
	Date.now = () => fakeNow;
	try {
		writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
			verbose: { slack: "messages-only" },
			slack: { toolStreaming: "all", toolStreamPresentation: "split", toolStreamWindowMinutes: 1 },
		}));
		const split = new TestSlackAdapter(workingDir);
		const splitContext = split.createContext(event(), {} as ChannelStore);
		await splitContext.respond("_→ First split label_", false);
		fakeNow += 59_999;
		await splitContext.respond("_→ Second split label_", false);
		assert.equal(split.posted.length, 1, "labels within the rolling minute keep editing one working message");
		fakeNow += 1;
		assert.equal(split.posted.length, 1, "elapsed time alone never creates a harness message");
		await splitContext.respond("_→ Third split label_", false);
		assert.equal(split.posted.length, 2, "the first real tool label after a minute opens a fresh working message");
		assert.match(split.posted[1]?.text || "", /Third split label/, "the boundary event becomes the first label in the fresh window");

		fakeNow = 2_000_000;
		const rolling = new TestSlackAdapter(workingDir);
		const rollingContext = rolling.createWorkingOutputContext(
			{ platform: "slack", channelId: "C9999999999" },
			{} as ChannelStore,
			{ toolStreaming: "all", presentation: "split", windowMinutes: 1 },
		);
		await rollingContext.updateToolProgress?.({ id: "long-a", label: "Long A", status: "in_progress" });
		fakeNow += 30_000;
		await rollingContext.updateToolProgress?.({ id: "parallel-b", label: "Parallel B", status: "in_progress" });
		fakeNow += 30_000;
		await rollingContext.updateToolProgress?.({ id: "next-c", label: "Next C", status: "in_progress" });
		await rollingContext.updateToolProgress?.({ id: "parallel-b", label: "Parallel B", status: "complete", details: projectToolResultDetails({ name: "read", result: "B_DONE" }) });
		await rollingContext.updateToolProgress?.({ id: "long-a", label: "Long A", status: "complete", details: projectToolResultDetails({ name: "read", result: "A_DONE" }) });
		await rollingContext.updateToolProgress?.({ id: "next-c", label: "Next C", status: "complete", details: projectToolResultDetails({ name: "read", result: "C_DONE" }) });
		const rollingRoots = rolling.posted.filter((message) => !message.thread_ts);
		assert.equal(rollingRoots.length, 2, "the first tool at the minute boundary opens exactly one new batch root");
		const firstWindowReplies = rolling.posted.filter((message) => message.thread_ts === rollingRoots[0]?.ts);
		const secondWindowReplies = rolling.posted.filter((message) => message.thread_ts === rollingRoots[1]?.ts);
		assert.equal(firstWindowReplies.length, 2, "parallel tools inside the first window share one root");
		assert.equal(secondWindowReplies.length, 1, "the boundary tool owns one lifecycle reply under the second root");
		assert(rolling.messageUpdates.some((update) => update.ts === firstWindowReplies[0]?.ts && update.text.includes("A_DONE")), "long-running A completes in its original batch after rollover");
		assert(rolling.messageUpdates.some((update) => update.ts === firstWindowReplies[1]?.ts && update.text.includes("B_DONE")), "parallel B can complete before A without changing ownership");
		await rollingContext.deleteMessage();
		const rollingOwned = [...rollingRoots, ...firstWindowReplies, ...secondWindowReplies].flatMap((message) => message.ts ? [message.ts] : []).sort();
		assert.deepEqual(rolling.deletedMessages.map((message) => message.ts).sort(), rollingOwned, "cleanup retains ownership across rolling batch roots");

		fakeNow = 3_000_000;
		const sevenPlusOne = new TestSlackAdapter(workingDir);
		const sevenPlusOneContext = sevenPlusOne.createWorkingOutputContext(
			{ platform: "slack", channelId: "C9999999999" },
			{} as ChannelStore,
			{ toolStreaming: "all", presentation: "split", windowMinutes: 1 },
		);
		for (let index = 1; index <= 7; index++) {
			await sevenPlusOneContext.updateToolProgress?.({ id: `window-${index}`, label: `Window ${index}`, status: "in_progress" });
			fakeNow += 5_000;
		}
		fakeNow = 3_060_000;
		await sevenPlusOneContext.updateToolProgress?.({ id: "window-8", label: "Window 8", status: "in_progress" });
		const sevenPlusOneRoots = sevenPlusOne.posted.filter((message) => !message.thread_ts);
		assert.equal(sevenPlusOneRoots.length, 2, "seven calls inside one minute create one root and the eighth after rollover creates the next");
		assert.equal(sevenPlusOne.posted.filter((message) => message.thread_ts === sevenPlusOneRoots[0]?.ts).length, 7);
		assert.equal(sevenPlusOne.posted.filter((message) => message.thread_ts === sevenPlusOneRoots[1]?.ts).length, 1);

		writeFileSync(join(workingDir, "settings.json"), JSON.stringify({
			verbose: { slack: "messages-only" },
			slack: { toolStreaming: "all", toolStreamPresentation: "condensed", toolStreamWindowMinutes: 1 },
		}));
		const condensed = new TestSlackAdapter(workingDir);
		const condensedContext = condensed.createContext(event(), {} as ChannelStore);
		await condensedContext.respond("_→ First condensed label_", false);
		fakeNow += 60_000;
		await condensedContext.respond("_→ Second condensed label_", false);
		await condensedContext.respond("_→ Third condensed label_", false);
		assert.equal(condensed.posted.length, 1, "condensed presentation keeps editing one message beyond the configured time window");
	} finally {
		Date.now = realDateNow;
	}

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
		verbose: { slack: false },
		slack: { toolStreaming: "important" },
	}));
	const quietWithFallback = new TestSlackAdapter(workingDir);
	const quietWithFallbackContext = quietWithFallback.createContext(event(), {} as ChannelStore);
	await quietWithFallbackContext.respond(":thought_balloon: _private reasoning_", true);
	await quietWithFallbackContext.respond("_→ Checking the deployed revision_", false, { show: true });
	await quietWithFallbackContext.sendFinalResponse("fallback final answer");
	assert.equal(quietWithFallback.posted.length, 2, "false Slack verbosity permits a selected label and fallback final answer");
	assert.match(quietWithFallback.posted[0]?.text || "", /Checking the deployed revision/, "selected safe label remains visible in false mode");
	assert.doesNotMatch(quietWithFallback.posted[0]?.text || "", /private reasoning/, "selected label cannot flush hidden reasoning in false mode");
	assert.equal(quietWithFallback.posted[1]?.text, "fallback final answer", "false mode preserves the fallback harness final");

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
		slack: { toolStreaming: "all", toolStreamPresentation: "condensed" },
	}));
	const chronological = new TestSlackAdapter(workingDir);
	const chronologicalContext = chronological.createContext(event(), {} as ChannelStore);
	assert.equal(chronologicalContext.workingStreamPresentation, "condensed", "Slack context carries the configured working-stream presentation into the runner");
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
