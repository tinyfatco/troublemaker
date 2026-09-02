import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VOICE_RECORDING_VERSION, VOICE_SESSION_VERSION, voiceRecordingReplayRequest,
	type VoiceIdentity,
	type VoiceRecordingUploadRequest,
} from "../src/console/voice-session-contract.js";
import { VoiceSessionRuntime } from "../src/console/voice-session-runtime.js";
import { VoiceSessionStore } from "../src/console/voice-session-store.js";

const root = mkdtempSync(join(tmpdir(), "voice-recording-example-"));
const agentID = "agent-example";
const identity: VoiceIdentity = {
	session_id: "session-recording-example",
	capture_id: "capture-recording-example",
	delivery_id: "delivery-recording-example",
	subject_agent_id: agentID,
};
const configuration = { response_policy: "standard" as const, speech_mode: "silent" as const };
const pcm = Buffer.alloc(1_920_000);
for (let index = 0; index < pcm.length; index++) pcm[index] = index % 251;
const upload = (subject = identity, audio = pcm): VoiceRecordingUploadRequest => ({
	version: VOICE_RECORDING_VERSION,
	identity: subject,
	configuration,
	captured_at: new Date().toISOString(),
	recording_sha256: createHash("sha256").update(audio).digest("hex"),
	audio: audio.toString("base64"),
});

class ManualRecordingClock {
	elapsedMilliseconds = 0;
	readonly requestedDurations: number[] = [];
	private pending: Array<{ duration: number; settle: () => void }> = [];

	readonly wait = (duration: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
		this.requestedDurations.push(duration);
		let settled = false;
		const item = {
			duration,
			settle: () => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", item.settle);
				this.pending = this.pending.filter((candidate) => candidate !== item);
				resolve();
			},
		};
		if (signal.aborted) item.settle();
		else {
			signal.addEventListener("abort", item.settle, { once: true });
			this.pending.push(item);
		}
	});

	get pendingDurations(): number[] {
		return this.pending.map((item) => item.duration);
	}

	async advanceNext(expectedDuration: number): Promise<void> {
		const item = this.pending[0];
		assert.ok(item, "a recording pacing duration must be pending");
		assert.equal(item.duration, expectedDuration);
		this.elapsedMilliseconds += item.duration;
		item.settle();
		await drainMicrotasks();
	}
}

async function drainMicrotasks(): Promise<void> {
	for (let index = 0; index < 12; index++) await Promise.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
}

try {
	const crossLanguageIdentity: VoiceIdentity = {
		session_id: "voice-session-fixture-0001",
		capture_id: "voice-capture-fixture-0001",
		delivery_id: "voice-delivery-fixture-0001",
		subject_agent_id: "agent-fixture",
	};
	const crossLanguagePCM = Buffer.alloc(640, 0x2a);
	const crossLanguage = voiceRecordingReplayRequest({
		version: VOICE_RECORDING_VERSION,
		identity: crossLanguageIdentity,
		configuration,
		captured_at: new Date().toISOString(),
		recording_sha256: createHash("sha256").update(crossLanguagePCM).digest("hex"),
		audio: crossLanguagePCM.toString("base64"),
	});
	assert.equal(crossLanguage.frames[0]?.event_fingerprint, "f68c636dc34c4e61bd01187897214fd299230004e18c4b0a4c315569431b41d6");

	const store = new VoiceSessionStore(join(root, "durable"), 96 * 1024 * 1024, 4);
	const appended: Buffer[] = [];
	let finishes = 0;
	let prepares = 0;
	let dispatches = 0;
	let syntheticPacedMilliseconds = 0;
	const makeRuntime = () => new VoiceSessionRuntime({
		store,
		inputWindow: 64,
		recordingPacingWait: async (duration) => { syntheticPacedMilliseconds += duration; },
		transcription: {
			open(_identity, callbacks) {
				return {
					append(audio) { appended.push(Buffer.from(audio)); },
					finish() {
						finishes++;
						callbacks.segmentFinal("Example request");
						callbacks.thoughtCommitted("Example request");
					},
					cancel() {},
				};
			},
		},
		canonical: {
			async prepare() {
				prepares++;
				return {
					completionID: "completion-recording-example",
					async dispatch() {
						dispatches++;
						async function* partials() { yield { text: "Example answer", speechEligible: false }; }
						return { partials: partials(), final: Promise.resolve({ text: "Example answer", speechEligible: false }) };
					},
				};
			},
		},
	});
	let runtime = makeRuntime();

	// Two overlapping attempts model a response timeout and immediate exact
	// retry. The duplicate joins one ingestion even if committed-thought
	// completion terminalizes the session before the duplicate could send EOU.
	const immutableUpload = upload();
	const firstAttempt = runtime.applyRecording(agentID, identity.session_id, immutableUpload);
	const duplicateAttempt = runtime.applyRecording(agentID, identity.session_id, immutableUpload);
	const changedWhileInFlight = Buffer.from(pcm);
	changedWhileInFlight[0] ^= 0xff;
	await assert.rejects(
		runtime.applyRecording(agentID, identity.session_id, {
			...immutableUpload,
			recording_sha256: createHash("sha256").update(changedWhileInFlight).digest("hex"),
			audio: changedWhileInFlight.toString("base64"),
		}),
		/replay_commitment_mismatch/,
		"a concurrent changed recording cannot join the exact ingestion",
	);
	const [first, duplicate] = await Promise.all([firstAttempt, duplicateAttempt]);
	assert.ok(["processing", "completed"].includes(first.disposition));
	assert.ok(["processing", "completed"].includes(duplicate.disposition));
	for (let index = 0; index < 200 && !runtime.poll(identity.session_id, 0).terminal; index++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.equal(runtime.poll(identity.session_id, 0).events.at(-1)?.kind, "completed");
	assert.equal(Buffer.concat(appended).length, pcm.length);
	assert.equal(createHash("sha256").update(Buffer.concat(appended)).digest("hex"), immutableUpload.recording_sha256);
	assert.equal(syntheticPacedMilliseconds, 60_000, "maximum legal PCM schedules exactly the bounded 60-second cadence");
	assert.equal(finishes, 1, "the immutable recording is transcribed once");
	assert.equal(prepares, 1, "one canonical completion is prepared");
	assert.equal(dispatches, 1, "one canonical user turn is submitted");

	// A relaunch/repeated unknown request restores durable custody and returns
	// completion without replaying provider input or canonical submission.
	runtime = makeRuntime();
	const relaunched = await runtime.applyRecording(agentID, identity.session_id, immutableUpload);
	assert.equal(relaunched.disposition, "completed");
	assert.equal(Buffer.concat(appended).length, pcm.length);
	assert.equal(finishes, 1);
	assert.equal(dispatches, 1);
	assert.equal(syntheticPacedMilliseconds, 60_000, "durable completion does not pace or replay provider input");

	const pacedIdentity: VoiceIdentity = {
		session_id: "session-recording-paced-example",
		capture_id: "capture-recording-paced-example",
		delivery_id: "delivery-recording-paced-example",
		subject_agent_id: agentID,
	};
	const pacedPCM = Buffer.alloc(24_000, 0x33);
	const pacedUpload = upload(pacedIdentity, pacedPCM);
	const pacingClock = new ManualRecordingClock();
	const appendCadence: Array<{ at: number; bytes: number }> = [];
	const finalizeCadence: number[] = [];
	let pacedPrepares = 0;
	let pacedDispatches = 0;
	const timingDiagnostics: unknown[] = [];
	const pacedRuntime = new VoiceSessionRuntime({
		store: new VoiceSessionStore(join(root, "paced"), 96 * 1024 * 1024, 4),
		inputWindow: 64,
		recordingPacingWait: pacingClock.wait,
		timingNow: () => pacingClock.elapsedMilliseconds,
		runtimeIdentity: "runtime-example",
		sourceIdentity: "source-example",
		onTimingDiagnostic: (diagnostic) => timingDiagnostics.push(diagnostic),
		transcription: {
			open(_subject, callbacks) {
				return {
					append(audio) {
						appendCadence.push({ at: pacingClock.elapsedMilliseconds, bytes: audio.byteLength });
					},
					finish() {
						finalizeCadence.push(pacingClock.elapsedMilliseconds);
						callbacks.segmentFinal("Paced request");
						callbacks.thoughtCommitted("Paced request");
					},
					cancel() {},
				};
			},
		},
		canonical: {
			async prepare() {
				pacedPrepares++;
				return {
					completionID: "completion-recording-paced-example",
					async dispatch() {
						pacedDispatches++;
						async function* partials() { yield { text: "Paced answer", speechEligible: false }; }
						return { partials: partials(), final: Promise.resolve({ text: "Paced answer", speechEligible: false }) };
					},
				};
			},
		},
	});
	const pacedFirst = pacedRuntime.applyRecording(agentID, pacedIdentity.session_id, pacedUpload);
	const pacedDuplicate = pacedRuntime.applyRecording(agentID, pacedIdentity.session_id, pacedUpload);
	await drainMicrotasks();
	assert.deepEqual(appendCadence, [{ at: 0, bytes: 8_000 }]);
	assert.deepEqual(pacingClock.pendingDurations, [250]);
	assert.deepEqual(finalizeCadence, [], "Finalize cannot precede the first declared frame duration");
	await pacingClock.advanceNext(250);
	assert.deepEqual(appendCadence, [{ at: 0, bytes: 8_000 }, { at: 250, bytes: 8_000 }]);
	assert.deepEqual(finalizeCadence, []);
	await pacingClock.advanceNext(250);
	assert.deepEqual(appendCadence, [
		{ at: 0, bytes: 8_000 },
		{ at: 250, bytes: 8_000 },
		{ at: 500, bytes: 8_000 },
	]);
	assert.deepEqual(finalizeCadence, [], "Finalize cannot coincide with the final frame append");
	await pacingClock.advanceNext(250);
	const [pacedFirstResult, pacedDuplicateResult] = await Promise.all([pacedFirst, pacedDuplicate]);
	assert.deepEqual(pacedDuplicateResult, pacedFirstResult, "an exact concurrent duplicate joins paced ingestion");
	assert.deepEqual(pacingClock.requestedDurations, [250, 250, 250]);
	assert.deepEqual(finalizeCadence, [750], "EOU/Finalize follows the complete declared recording duration");
	for (let index = 0; index < 100 && !pacedRuntime.poll(pacedIdentity.session_id, 0).terminal; index++) {
		await drainMicrotasks();
	}
	const pacedPoll = pacedRuntime.poll(pacedIdentity.session_id, 0);
	assert.equal(pacedPoll.events.at(-1)?.kind, "completed");
	assert.deepEqual(pacedPoll.timing.map((record) => record.stage), [
		"session_opened",
		"recording_custody_accepted",
		"input_first_audio_committed",
		"recording_last_frame_committed",
		"input_finalized",
		"transcription_final",
		"canonical_admitted",
		"canonical_dispatch_started",
		"assistant_first_output",
		"assistant_final",
		"terminal_persisted",
	], "one content-free timeline spans custody through terminal completion");
	assert.deepEqual(
		pacedPoll.timing.map((record) => record.elapsed_milliseconds),
		[0, 0, 0, 500, 750, 750, 750, 750, 750, 750, 750],
		"server stages retain deterministic monotonic elapsed time",
	);
	assert.equal(new Set(pacedPoll.timing.map((record) => record.stage)).size, pacedPoll.timing.length);
	assert.deepEqual(
		(timingDiagnostics as Array<{ stage: string }>).map((record) => record.stage),
		pacedPoll.timing.map((record) => record.stage),
		"post-commit diagnostics exactly mirror durable timing truth",
	);
	assert.doesNotMatch(JSON.stringify(timingDiagnostics), /Paced request|Paced answer|session-recording-paced-example/);
	assert.match(JSON.stringify(timingDiagnostics), /sha256:[a-f0-9]{24}/);
	assert.equal(pacedPrepares, 1, "paced duplicate ingestion prepares one canonical turn");
	assert.equal(pacedDispatches, 1, "paced duplicate ingestion dispatches one canonical turn");

	const batchIdentity: VoiceIdentity = {
		session_id: "session-recording-batch-example",
		capture_id: "capture-recording-batch-example",
		delivery_id: "delivery-recording-batch-example",
		subject_agent_id: agentID,
	};
	const batchAppends: number[] = [];
	let batchFinishes = 0;
	let batchPacingCalls = 0;
	let batchDispatches = 0;
	let completeBatchTranscription: (() => void) | undefined;
	const batchRuntime = new VoiceSessionRuntime({
		store: new VoiceSessionStore(join(root, "batch"), 96 * 1024 * 1024, 4),
		inputWindow: 64,
		recordingPacingWait: async () => { batchPacingCalls++; },
		transcription: {
			open() {
				throw new Error("complete recording must prefer the explicit batch path");
			},
			openRecording(_subject, callbacks) {
				return {
					append(audio) { batchAppends.push(audio.byteLength); },
					finish() {
						batchFinishes++;
						completeBatchTranscription = () => {
							callbacks.ready?.();
							callbacks.segmentFinal("Batch request");
							callbacks.thoughtCommitted("Batch request");
						};
					},
					cancel() {},
				};
			},
		},
		canonical: {
			async prepare() {
				return {
					completionID: "completion-recording-batch-example",
					async dispatch() {
						batchDispatches++;
						async function* partials() { yield { text: "Batch answer", speechEligible: false }; }
						return { partials: partials(), final: Promise.resolve({ text: "Batch answer", speechEligible: false }) };
					},
				};
			},
		},
	});
	const batchPCM = Buffer.alloc(24_000, 0x55);
	let batchResponseSettled = false;
	const batchResponse = batchRuntime.applyRecording(
		agentID,
		batchIdentity.session_id,
		upload(batchIdentity, batchPCM),
	).then((result) => {
		batchResponseSettled = true;
		return result;
	});
	await drainMicrotasks();
	assert.equal(batchResponseSettled, true, "validated custody responds before prerecorded STT completes");
	const batchResult = await batchResponse;
	assert.equal(batchResult.disposition, "processing");
	assert.deepEqual(batchAppends, [8_000, 8_000, 8_000]);
	assert.equal(batchPacingCalls, 0, "explicit prerecorded transcription never waits for realtime cadence");
	assert.equal(batchFinishes, 1, "the complete immutable body is finalized once");
	assert.equal(batchDispatches, 0, "canonical work waits for the exact prerecorded transcript");
	assert.ok(completeBatchTranscription);
	completeBatchTranscription();
	for (let index = 0; index < 100 && !batchRuntime.poll(batchIdentity.session_id, 0).terminal; index++) {
		await drainMicrotasks();
	}
	const batchPoll = batchRuntime.poll(batchIdentity.session_id, 0);
	assert.equal(batchPoll.events.at(-1)?.kind, "completed");
	assert.equal(batchDispatches, 1);
	const batchLastFrameElapsed = batchPoll.timing.find(
		(record) => record.stage === "recording_last_frame_committed"
	)?.elapsed_milliseconds ?? Number.POSITIVE_INFINITY;
	assert.ok(
		batchLastFrameElapsed < 100,
		"batch custody commits every durable frame without replaying capture duration",
	);

	const cancelledIdentity: VoiceIdentity = {
		session_id: "session-recording-cancelled-example",
		capture_id: "capture-recording-cancelled-example",
		delivery_id: "delivery-recording-cancelled-example",
		subject_agent_id: agentID,
	};
	const cancellationClock = new ManualRecordingClock();
	let cancelledAppends = 0;
	let cancelledFinishes = 0;
	let providerCancellations = 0;
	let cancelledPrepares = 0;
	const cancelledRuntime = new VoiceSessionRuntime({
		store: new VoiceSessionStore(join(root, "cancelled"), 96 * 1024 * 1024, 4),
		inputWindow: 64,
		recordingPacingWait: cancellationClock.wait,
		transcription: {
			open() {
				return {
					append() { cancelledAppends++; },
					finish() { cancelledFinishes++; },
					cancel() { providerCancellations++; },
				};
			},
		},
		canonical: {
			async prepare() {
				cancelledPrepares++;
				throw new Error("cancelled recording must not prepare canonical work");
			},
		},
	});
	const cancelledUpload = upload(cancelledIdentity, Buffer.alloc(16_000, 0x44));
	const cancelledIngestion = cancelledRuntime.applyRecording(
		agentID,
		cancelledIdentity.session_id,
		cancelledUpload,
	);
	await drainMicrotasks();
	assert.equal(cancelledAppends, 1);
	assert.deepEqual(cancellationClock.pendingDurations, [250]);
	await cancelledRuntime.applyClientEvent(agentID, cancelledIdentity.session_id, {
		version: VOICE_SESSION_VERSION,
		identity: cancelledIdentity,
		sequence: 2,
		kind: "cancel",
	});
	const cancelledResult = await cancelledIngestion;
	assert.equal(cancelledResult.terminal, true);
	assert.equal(cancelledAppends, 1, "terminal cancellation stops later recording frames");
	assert.equal(cancelledFinishes, 0, "terminal cancellation never Finalizes partial recording input");
	assert.equal(providerCancellations, 1);
	assert.equal(cancelledPrepares, 0);
	assert.equal(cancellationClock.elapsedMilliseconds, 0, "terminal cancellation aborts the active pacing wait");
	assert.deepEqual(cancellationClock.pendingDurations, []);

	let livePacingCalls = 0;
	let liveFinishes = 0;
	let liveBatchSelections = 0;
	const liveIdentity: VoiceIdentity = {
		session_id: "session-live-unpaced-example",
		capture_id: "capture-live-unpaced-example",
		delivery_id: "delivery-live-unpaced-example",
		subject_agent_id: agentID,
	};
	const liveRuntime = new VoiceSessionRuntime({
		recordingPacingWait: async () => { livePacingCalls++; },
		transcription: {
			open() {
				return { append() {}, finish() { liveFinishes++; }, cancel() {} };
			},
			openRecording() {
				liveBatchSelections++;
				return { append() {}, finish() {}, cancel() {} };
			},
		},
		canonical: { async prepare() { throw new Error("live fixture does not commit thought"); } },
	});
	liveRuntime.open(agentID, {
		version: VOICE_SESSION_VERSION,
		identity: liveIdentity,
		audio: { encoding: "pcm_s16le", sample_rate: 16_000, channel_count: 1 },
		configuration,
	});
	await liveRuntime.applyClientEvent(agentID, liveIdentity.session_id, {
		version: VOICE_SESSION_VERSION,
		identity: liveIdentity,
		sequence: 1,
		kind: "audio",
		audio: Buffer.alloc(8_000, 0x55).toString("base64"),
		duration_milliseconds: 250,
	});
	await liveRuntime.applyClientEvent(agentID, liveIdentity.session_id, {
		version: VOICE_SESSION_VERSION,
		identity: liveIdentity,
		sequence: 2,
		kind: "end_of_utterance",
	});
	assert.equal(livePacingCalls, 0, "live streaming never selects complete-recording pacing");
	assert.equal(liveBatchSelections, 0, "live automatic streaming never selects prerecorded STT");
	assert.equal(liveFinishes, 1, "live EOU remains immediate and unchanged");

	const changed = Buffer.from(pcm);
	changed[0] ^= 0xff;
	await assert.rejects(
		runtime.applyRecording(agentID, identity.session_id, {
			...immutableUpload,
			recording_sha256: createHash("sha256").update(changed).digest("hex"),
			audio: changed.toString("base64"),
		}),
		/replay_commitment_mismatch/,
		"same immutable identity cannot bind different recording bytes",
	);
	await assert.rejects(
		runtime.applyRecording(agentID, identity.session_id, {
			...immutableUpload,
			recording_sha256: "0".repeat(64),
		}),
		/invalid_voice_recording/,
	);
	await assert.rejects(
		runtime.applyRecording(agentID, identity.session_id, upload(identity, Buffer.alloc(1_920_002))),
		/invalid_voice_recording/,
	);

	console.log("voice recording upload tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
