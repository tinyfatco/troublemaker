import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MomEvent,
	PlatformAdapter,
	VoiceSessionNotice,
} from "../src/adapters/types.js";
import { FilesystemWorkspaceStore } from "../src/storage/node/filesystem-workspace.js";
import {
	FirstClassVoiceContract,
	matchWakePrefix,
	parseIdentityName,
	parseSpokenVoiceControl,
	readVoiceWakeConfiguration,
} from "../src/voice-contract.js";

const SESSION_ONE = "11111111-2222-4333-8444-555555555555";
const SESSION_TWO = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function event(text: string, sessionId = SESSION_ONE, channel = "voice-example"): MomEvent {
	return {
		type: "dm",
		channel,
		ts: String(Date.now()),
		user: "voice-user-example",
		text,
		rawText: text,
		sessionId,
		sourceEventType: "test_voice",
	};
}

function fakeAdapter(name: string) {
	const interruptions: string[] = [];
	const notices: Array<{ text: string; notice: VoiceSessionNotice }> = [];
	const appliedVoices: string[] = [];
	const adapter = {
		name,
		interruptOutputAudio(input: MomEvent) {
			interruptions.push(input.text);
		},
		handleVoiceSessionNotice(input: MomEvent, notice: VoiceSessionNotice) {
			notices.push({ text: input.text, notice });
		},
		applyRealtimeVoice(_input: MomEvent, voice: string) {
			appliedVoices.push(voice);
		},
	} as unknown as PlatformAdapter;
	return { adapter, interruptions, notices, appliedVoices };
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-voice-contract-"));
try {
	const workspace = new FilesystemWorkspaceStore(workingDir);
	workspace.writeText("IDENTITY.md", "# Identity\n\n- **Name:** Orbit\n");
	workspace.writeText("settings.json", JSON.stringify({
		defaultProvider: "example-provider",
		voice: { aliases: ["Lantern", "orbit", ""] },
	}, null, 2));

	assert.equal(parseIdentityName("- **Name:** Orbit"), "Orbit");
	assert.equal(parseIdentityName("- **Name**: Lantern"), "Lantern");
	assert.equal(parseIdentityName("Name: Example Agent"), "Example Agent");
	assert.equal(parseIdentityName("- **Name:**\n  _(pick something)_"), null, "blank seeded identity fails closed");
	assert.deepEqual(readVoiceWakeConfiguration(workspace), {
		primaryName: "Orbit",
		wakeNames: ["Orbit", "Lantern"],
	});
	assert.deepEqual(
		matchWakePrefix("  hEy,   Orbit!!!   Keep  these   inner spaces.  ", ["Orbit"]),
		{ wakeName: "Orbit", text: "Keep  these   inner spaces." },
		"wake parsing is case/spacing/punctuation tolerant and preserves remaining content",
	);
	assert.equal(matchWakePrefix("hey Orbiter, no", ["Orbit"]), null, "wake names require a complete-name boundary");
	assert.deepEqual(parseSpokenVoiceControl("turn off the voice session"), { type: "close" });
	assert.deepEqual(parseSpokenVoiceControl("voice off"), { type: "close" });
	assert.deepEqual(parseSpokenVoiceControl("switch voice to cedar"), {
		type: "voice_change",
		requested: "cedar",
		voice: "cedar",
	});
	assert.deepEqual(parseSpokenVoiceControl("switch to ash voice"), {
		type: "voice_change",
		requested: "ash",
		voice: "ash",
	});
	assert.equal(parseSpokenVoiceControl("please use a warmer tone"), null, "ordinary content is not mistaken for a control");

	const primary = fakeAdapter("voice");
	const delivered: MomEvent[] = [];
	let busy = false;
	const contract = new FirstClassVoiceContract({
		workspace,
		isCanonicalBusy: () => busy,
		runCanonicalTurn: async (input) => {
			delivered.push(input);
			return { stopReason: "stop" };
		},
		resolvePendingInput: () => false,
		handleStop: async () => {},
	});

	assert.equal(contract.commit(event("ambient room conversation"), primary.adapter), "ignored");
	assert.equal(delivered.length, 0, "pre-wake ambient transcript never reaches the canonical runner");
	assert.equal(primary.interruptions.length, 1, "even a gated committed transcript invokes barge-in immediately");

	assert.equal(
		contract.commit(event("  Hey, Orbit!   Keep  these   inner spaces.  "), primary.adapter),
		"queued",
	);
	await flush();
	assert.equal(delivered[0]?.text, "Keep  these   inner spaces.", "only the initial wake prefix is stripped");
	assert.equal(delivered[0]?.rawText, "Keep  these   inner spaces.");
	assert.equal(delivered[0]?.directlyAddressed, true);

	contract.commit(event("natural follow-up without another wake"), primary.adapter);
	await flush();
	assert.equal(delivered[1]?.text, "natural follow-up without another wake", "open sessions accept natural follow-ups");

	contract.commit(event("switch voice to cedar"), primary.adapter);
	assert.deepEqual(primary.appliedVoices, ["cedar"], "supported spoken voice changes apply locally");
	let settings = JSON.parse(readFileSync(join(workingDir, "settings.json"), "utf8"));
	assert.equal(settings.realtimeVoice, "cedar");
	assert.equal(settings.defaultProvider, "example-provider", "voice changes preserve unrelated settings");
	assert.equal(delivered.length, 2, "spoken voice controls are not canonical turns");

	contract.commit(event("change voice to moonbeam"), primary.adapter);
	contract.commit(event("change voice to cedar or ash"), primary.adapter);
	settings = JSON.parse(readFileSync(join(workingDir, "settings.json"), "utf8"));
	assert.equal(settings.realtimeVoice, "cedar", "unsupported or ambiguous changes leave the selected voice unchanged");
	assert.equal(primary.appliedVoices.length, 1);
	assert(
		primary.notices.some(({ notice }) => notice.type === "voice_change_rejected" && notice.reason === "unsupported"),
		"unsupported voice changes fail locally",
	);
	assert(
		primary.notices.some(({ notice }) => notice.type === "voice_change_rejected" && notice.reason === "ambiguous"),
		"ambiguous voice changes fail locally",
	);

	busy = true;
	contract.commit(event("queued content that close must discard"), primary.adapter);
	assert.equal(contract.pendingCount, 1);
	contract.commit(event("close the voice session"), primary.adapter);
	assert.equal(contract.pendingCount, 0, "session close discards that session's queued turns");
	busy = false;
	contract.notifyCanonicalBoundary();
	await flush();
	assert.equal(delivered.length, 2, "discarded close-session work never drains");
	contract.commit(event("ambient after close"), primary.adapter);
	await flush();
	assert.equal(delivered.length, 2, "close returns the transport to wake-gated state");
	contract.commit(event("Hey Orbit"), primary.adapter);
	contract.commit(event("open again"), primary.adapter);
	await flush();
	assert.equal(delivered.at(-1)?.text, "open again", "a fresh valid wake reopens the same transport");

	const aliasAdapter = fakeAdapter("web-voice");
	contract.commit(event("Hey Lantern, alias wake works", SESSION_TWO, "web-voice"), aliasAdapter.adapter);
	await flush();
	assert.equal(delivered.at(-1)?.text, "alias wake works", "configured aliases are valid initial attention");
	const deliveredBeforeTransportClose = delivered.length;
	busy = true;
	contract.commit(event("queued before transport close", SESSION_TWO, "web-voice"), aliasAdapter.adapter);
	assert.equal(contract.closeTransportSession(SESSION_TWO, aliasAdapter.adapter), 1, "transport close discards its queued follow-ups");
	busy = false;
	contract.notifyCanonicalBoundary();
	contract.commit(event("ambient after transport reconnect", SESSION_TWO, "web-voice"), aliasAdapter.adapter);
	await flush();
	assert.equal(delivered.length, deliveredBeforeTransportClose, "transport reconnect starts wake-gated with no replay");

	const missingDir = mkdtempSync(join(tmpdir(), "tm-voice-no-identity-"));
	try {
		const missingWorkspace = new FilesystemWorkspaceStore(missingDir);
		const missingAdapter = fakeAdapter("realtime-voice");
		const missingDelivered: MomEvent[] = [];
		const missingContract = new FirstClassVoiceContract({
			workspace: missingWorkspace,
			isCanonicalBusy: () => false,
			runCanonicalTurn: async (input) => { missingDelivered.push(input); },
			resolvePendingInput: () => false,
			handleStop: async () => {},
		});
		missingContract.commit(event("Hey ProductionName, do not guess"), missingAdapter.adapter);
		await flush();
		assert.equal(missingDelivered.length, 0, "missing IDENTITY Name has no hardcoded production fallback");
		assert(
			missingAdapter.notices.some(({ notice }) => notice.type === "wake_required" && notice.reason === "wake_name_unconfigured"),
			"missing wake configuration fails closed deterministically",
		);
	} finally {
		rmSync(missingDir, { recursive: true, force: true });
	}

	// Busy canonical/tool work: committed voice turns only barge in and queue.
	const fifoOne = fakeAdapter("voice");
	const fifoTwo = fakeAdapter("realtime-voice");
	const order: string[] = [];
	const releases: Array<() => void> = [];
	let canonicalBusy = true;
	let concurrent = 0;
	let maxConcurrent = 0;
	let abortCalls = 0;
	const fifoContract = new FirstClassVoiceContract({
		workspace,
		isCanonicalBusy: () => canonicalBusy,
		runCanonicalTurn: async (input) => {
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			order.push(input.text);
			await new Promise<void>((resolve) => releases.push(resolve));
			concurrent--;
			return { stopReason: "stop" };
		},
		resolvePendingInput: () => false,
		handleStop: async () => { abortCalls++; },
	});

	fifoContract.commit(event("Hey Orbit, first", SESSION_ONE), fifoOne.adapter);
	fifoContract.commit(event("second", SESSION_ONE), fifoOne.adapter);
	fifoContract.commit(event("Hey Orbit, third", SESSION_TWO, "mac-realtime"), fifoTwo.adapter);
	assert.deepEqual(order, [], "voice turns do not enter an active canonical run or tool call");
	assert.equal(fifoContract.pendingCount, 3);
	assert.equal(fifoOne.interruptions.length, 2);
	assert.equal(fifoTwo.interruptions.length, 1, "each adapter hook runs synchronously on commit");
	assert.equal(abortCalls, 0, "ordinary busy voice commits never call the stop/abort path");

	canonicalBusy = false;
	fifoContract.notifyCanonicalBoundary();
	assert.deepEqual(order, ["first"], "only one fresh turn starts at the safe boundary");
	releases.shift()?.();
	await flush();
	assert.deepEqual(order, ["first", "second"]);
	releases.shift()?.();
	await flush();
	assert.deepEqual(order, ["first", "second", "third"], "global FIFO preserves cross-adapter arrival order");
	releases.shift()?.();
	await flush();
	assert.equal(maxConcurrent, 1, "queued voice turns drain one canonical run at a time");
	assert.equal(fifoContract.pendingCount, 0);

	// Pending input and stop remain immediate control-plane exceptions.
	const controlsAdapter = fakeAdapter("web-voice");
	let pendingResolutions = 0;
	let stopCalls = 0;
	const controlRuns: MomEvent[] = [];
	const controlContract = new FirstClassVoiceContract({
		workspace,
		isCanonicalBusy: () => true,
		runCanonicalTurn: async (input) => { controlRuns.push(input); },
		resolvePendingInput: (_channel, text) => {
			if (text !== "123456") return false;
			pendingResolutions++;
			return true;
		},
		handleStop: async () => { stopCalls++; },
	});
	assert.equal(controlContract.commit(event("123456"), controlsAdapter.adapter), "pending_input");
	assert.equal(pendingResolutions, 1, "pending input bypasses wake gating and the FIFO immediately");
	assert.equal(controlContract.commit(event("stop"), controlsAdapter.adapter), "stop");
	await flush();
	assert.equal(stopCalls, 1, "spoken stop bypasses wake gating immediately");
	controlContract.commit(event("Hey Orbit"), controlsAdapter.adapter);
	controlContract.commit(event("ordinary queued turn"), controlsAdapter.adapter);
	assert.equal(controlContract.pendingCount, 1);
	assert.equal(controlContract.commit(event("stop"), controlsAdapter.adapter), "stop");
	await flush();
	assert.equal(stopCalls, 2, "spoken stop bypasses the FIFO immediately");
	assert.equal(controlContract.pendingCount, 0, "stop clears stale queued voice follow-ups");
	assert.equal(controlRuns.length, 0);

	const cli = readFileSync("src/host/node/cli.ts", "utf8");
	assert.match(cli, /handleSteer[\s\S]*?steerOrQueueBusyMessage\(event, adapter\)/, "non-voice busy routing soft-steers or queues without interruption");
	assert.match(cli, /handleVoiceEvent[\s\S]*?voiceContract\.commit\(event, adapter\)/, "voice busy routing uses the FIFO contract instead");
	assert.match(cli, /isConfigurableVoiceWebhook[\s\S]*?getVoiceWebhookInputMode\(\) === "steer"[\s\S]*?steerOrQueueVoiceWebhook[\s\S]*?enqueueHardInterrupt/, "legacy voice webhooks honor the durable steer mode before explicit hard interruption");
	assert.match(cli, /steerOrQueueVoiceWebhook[\s\S]*?awareness\.runner\.steer\(event\.text\)[\s\S]*?withGlobalRunSlot/, "voice webhook steer mode queues safely when the active model cannot accept steering");

	console.log("first-class voice contract ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
