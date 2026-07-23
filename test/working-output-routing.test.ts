import assert from "node:assert/strict";
import type {
	MomContext,
	MomEvent,
	PlatformAdapter,
	WorkingOutputContextOptions,
} from "../src/adapters/types.js";
import type { WorkingOutputTarget } from "../src/context.js";
import { routeWorkingOutputContext } from "../src/streaming/working-output.js";
import type { ChannelStore } from "../src/store.js";

type Harness = {
	responds: Array<{ text: string; shouldLog: boolean }>;
	finals: string[];
	threads: string[];
	typing: boolean[];
	working: boolean[];
	restarts: number;
	deletes: number;
};

function createHarness(): Harness {
	return { responds: [], finals: [], threads: [], typing: [], working: [], restarts: 0, deletes: 0 };
}

function createContext(channel: string, harness: Harness): MomContext {
	return {
		message: {
			text: "test turn",
			rawText: "test turn",
			user: "user-1",
			channel,
			ts: "1710000000.000001",
			replyTarget: channel,
			attachments: [],
		},
		channels: [],
		users: [],
		respond: async (text, shouldLog = true) => { harness.responds.push({ text, shouldLog }); },
		sendFinalResponse: async (text) => { harness.finals.push(text); },
		respondInThread: async (text) => { harness.threads.push(text); },
		setTyping: async (value) => { harness.typing.push(value); },
		uploadFile: async () => {},
		setWorking: async (value) => { harness.working.push(value); },
		deleteMessage: async () => { harness.deletes++; },
		workingStreamPresentation: "split",
		restartWorking: async () => { harness.restarts++; },
	};
}

function createAdapter(
	name: string,
	createWorking?: (target: WorkingOutputTarget, options: WorkingOutputContextOptions) => MomContext,
): PlatformAdapter {
	return {
		name,
		maxMessageLength: 40000,
		formatInstructions: "",
		start: async () => {},
		stop: async () => {},
		postMessage: async () => "message-1",
		updateMessage: async () => {},
		deleteMessage: async () => {},
		postInThread: async () => "thread-1",
		uploadFile: async () => {},
		logToFile: () => {},
		logBotResponse: () => {},
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllUsers: () => [],
		getAllChannels: () => [],
		createContext: (event: MomEvent) => createContext(event.channel, createHarness()),
		...(createWorking
			? {
				createWorkingOutputContext: (
					target: WorkingOutputTarget,
					_store: ChannelStore,
					options: WorkingOutputContextOptions,
				) => createWorking(target, options),
			}
			: {}),
		enqueueEvent: () => false,
	};
}

const presentation: WorkingOutputContextOptions = {
	toolStreaming: "all",
	presentation: "split",
	windowMinutes: 5,
};
const store = {} as ChannelStore;

const followHarness = createHarness();
const followSource = createContext("C1111111111", followHarness);
const followed = routeWorkingOutputContext({
	policy: { mode: "follow" },
	sourceContext: followSource,
	adapters: [],
	store,
	presentation,
});
assert.equal(followed, followSource, "follow preserves the adapter's existing response locus");
await followed.respond("_→ Followed label_", false);
assert.deepEqual(followHarness.responds, [{ text: "_→ Followed label_", shouldLog: false }]);

const offHarness = createHarness();
const off = routeWorkingOutputContext({
	policy: { mode: "off" },
	sourceContext: createContext("C2222222222", offHarness),
	adapters: [],
	store,
	presentation,
});
await off.setTyping(true);
await off.respond("_→ Hidden label_", false);
await off.respondInThread("raw tool details");
await off.respond("ordinary assistant text", true);
await off.sendFinalResponse("ordinary final");
assert.equal(offHarness.typing.length, 0, "off suppresses working placeholders");
assert.deepEqual(offHarness.responds, [{ text: "ordinary assistant text", shouldLog: true }], "off preserves ordinary source response semantics");
assert.equal(offHarness.threads.length, 0, "off suppresses raw working detail");
assert.deepEqual(offHarness.finals, ["ordinary final"], "off leaves final delivery on the source context");
assert.equal(off.workingReplyTarget, null, "off disables send-driven working rollover");

const sourceHarness = createHarness();
const fixedHarness = createHarness();
let capturedTarget: WorkingOutputTarget | undefined;
let capturedPresentation: WorkingOutputContextOptions | undefined;
const slack = createAdapter("slack", (target, options) => {
	capturedTarget = target;
	capturedPresentation = options;
	return createContext(target.channelId, fixedHarness);
});
const fixed = routeWorkingOutputContext({
	policy: {
		mode: "fixed",
		target: { platform: "slack", channelId: "D3333333333" },
	},
	sourceContext: createContext("heartbeat", sourceHarness),
	adapters: [slack],
	store,
	presentation,
});
await fixed.setTyping(true);
await fixed.setWorking(true);
await fixed.respond("_→ Cross-channel tool label_", false, { show: true });
await fixed.respondInThread("private arguments and result");
await fixed.respond("ordinary assistant text", true);
await fixed.sendFinalResponse("source final");
await fixed.restartWorking();
await fixed.setWorking(false);
assert.deepEqual(capturedTarget, { platform: "slack", channelId: "D3333333333" }, "fixed resolves the configured Slack DM");
assert.deepEqual(capturedPresentation, presentation, "fixed passes the existing label and split policy to Slack");
assert.deepEqual(fixedHarness.responds, [{ text: "_→ Cross-channel tool label_", shouldLog: false }], "fixed sends only working lifecycle to the destination");
assert.deepEqual(sourceHarness.responds, [{ text: "ordinary assistant text", shouldLog: true }], "fixed keeps ordinary assistant output on the source context");
assert.equal(sourceHarness.threads.length, 0, "fixed does not leak raw details at the source");
assert.equal(fixedHarness.threads.length, 0, "fixed does not leak raw details at the destination");
assert.deepEqual(sourceHarness.finals, ["source final"], "fixed keeps final delivery on the source");
assert.equal(fixed.workingReplyTarget, "D3333333333", "fixed advertises its visible rollover locus");
assert.deepEqual(fixedHarness.working, [true, false], "fixed destination follows turn lifecycle");
assert.deepEqual(sourceHarness.working, [true, false], "source finalization remains intact");
assert.equal(fixedHarness.restarts, 1, "fixed destination rolls chronologically");

const mattermostHarness = createHarness();
let mattermostTarget: WorkingOutputTarget | undefined;
const mattermost = createAdapter("mattermost", (target) => {
	mattermostTarget = target;
	return createContext(target.channelId, mattermostHarness);
});
const mattermostFixed = routeWorkingOutputContext({
	policy: {
		mode: "fixed",
		target: { platform: "mattermost", channelId: "mmmmmmmmmmmmmmmmmmmmmmmmmm" },
	},
	sourceContext: createContext("email-user@example.com", createHarness()),
	adapters: [mattermost],
	store,
	presentation,
});
await mattermostFixed.respond("_→ Mattermost-routed label_", false, { show: true });
assert.deepEqual(
	mattermostTarget,
	{ platform: "mattermost", channelId: "mmmmmmmmmmmmmmmmmmmmmmmmmm" },
	"fixed resolves a configured Mattermost work room",
);
assert.deepEqual(
	mattermostHarness.responds,
	[{ text: "_→ Mattermost-routed label_", shouldLog: false }],
	"fixed sends working lifecycle to Mattermost without changing the source channel",
);

const warnings: string[] = [];
const unavailableHarness = createHarness();
const unavailable = routeWorkingOutputContext({
	policy: { mode: "fixed", target: { platform: "slack", channelId: "C4444444444" } },
	sourceContext: createContext("email-user@example.com", unavailableHarness),
	adapters: [],
	store,
	presentation,
	warn: (message) => warnings.push(message),
});
await unavailable.respond("_→ Must fail closed_", false);
assert.equal(unavailableHarness.responds.length, 0, "missing fixed adapter never falls back to the source conversation");
assert.equal(warnings.length, 1, "missing fixed adapter emits an internal warning");

console.log("working-output-routing ok");
