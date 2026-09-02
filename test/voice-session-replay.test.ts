import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VOICE_REPLAY_CACHE_TTL_MILLISECONDS, VOICE_REPLAY_VERSION, VOICE_SESSION_VERSION,
	voiceFingerprint, voiceReplayRecordingDigest,
	type VoiceIdentity, type VoiceReplayFrameCommitment,
	type VoiceReplayReconciliationRequest,
} from "../src/console/voice-session-contract.js";
import { VoiceSessionRuntime, type VoiceTranscriptionProvider } from "../src/console/voice-session-runtime.js";
import { VoiceSessionStore, type StoredVoiceSession } from "../src/console/voice-session-store.js";

const root = mkdtempSync(join(tmpdir(), "voice-session-replay-example-"));
const agentID = "agent-example";
const configuration = { response_policy: "standard" as const, speech_mode: "silent" as const };
const identity: VoiceIdentity = {
	session_id: "session-replay-example",
	capture_id: "capture-replay-example",
	delivery_id: "delivery-replay-example",
	subject_agent_id: agentID,
};
const audio = [Buffer.alloc(640, 0x31), Buffer.alloc(640, 0x32)];
const frames: VoiceReplayFrameCommitment[] = audio.map((pcm, index) => {
	const sequence = index + 1;
	const event = {
		version: VOICE_SESSION_VERSION,
		identity,
		sequence,
		kind: "audio" as const,
		audio: pcm.toString("base64"),
		duration_milliseconds: 20,
	};
	return {
		sequence,
		audio_sha256: createHash("sha256").update(pcm).digest("hex"),
		event_fingerprint: voiceFingerprint(event),
		byte_count: pcm.byteLength,
		duration_milliseconds: 20,
	};
});
const request = (subject: VoiceIdentity = identity, capturedAt = new Date().toISOString()): VoiceReplayReconciliationRequest => ({
	version: VOICE_REPLAY_VERSION,
	identity: subject,
	configuration,
	captured_at: capturedAt,
	recording_digest: voiceReplayRecordingDigest(frames.map((frame, index) => ({
		...frame,
		event_fingerprint: voiceFingerprint({
			version: VOICE_SESSION_VERSION,
			identity: subject,
			sequence: index + 1,
			kind: "audio",
			audio: audio[index]!.toString("base64"),
			duration_milliseconds: 20,
		}),
	}))),
	frames: frames.map((frame, index) => ({
		...frame,
		event_fingerprint: voiceFingerprint({
			version: VOICE_SESSION_VERSION,
			identity: subject,
			sequence: index + 1,
			kind: "audio",
			audio: audio[index]!.toString("base64"),
			duration_milliseconds: 20,
		}),
	})),
});
const openFor = (subject: VoiceIdentity) => ({
	version: VOICE_SESSION_VERSION,
	identity: subject,
	audio: { encoding: "pcm_s16le" as const, sample_rate: 16_000 as const, channel_count: 1 as const },
	configuration,
});
const provider: VoiceTranscriptionProvider = { open() { return { append() {}, finish() {}, cancel() {} }; } };
const canonicalNever = { async prepare(): Promise<never> { throw new Error("canonical delivery was not expected"); } };

try {
	const store = new VoiceSessionStore(join(root, "restart"), 64 * 1024 * 1024, 4);
	let runtime = new VoiceSessionRuntime({ store, inputWindow: 2, transcription: provider, canonical: canonicalNever });
	runtime.open(agentID, openFor(identity));
	await runtime.applyClientEvent(agentID, identity.session_id, {
		version: VOICE_SESSION_VERSION,
		identity,
		sequence: 1,
		kind: "audio",
		audio: audio[0]!.toString("base64"),
		duration_milliseconds: 20,
	});

	// A process restart terminalizes pre-canonical input but keeps exact frame
	// commitments. One manual reconciliation issues one stable authorization.
	runtime = new VoiceSessionRuntime({ store, inputWindow: 2, transcription: provider, canonical: canonicalNever });
	const interrupted = runtime.reconcile(agentID, identity.session_id, request());
	assert.equal(interrupted.disposition, "retry_authorized");
	assert.equal(interrupted.canonical_custody, "none");
	assert.equal(interrupted.input?.audio_event_count, 1);
	assert.equal(interrupted.input?.accepted_event_fingerprints[0]?.fingerprint, frames[0]?.event_fingerprint);
	const authorization = interrupted.retry_authorization!;
	assert.ok(authorization);
	const concurrent = runtime.reconcile(agentID, identity.session_id, request());
	assert.deepEqual(concurrent.retry_authorization, authorization, "concurrent reconciliation returns one idempotent authorization");

	// Authorization and custody survive another restart before retry open.
	runtime = new VoiceSessionRuntime({ store, inputWindow: 2, transcription: provider, canonical: canonicalNever });
	assert.deepEqual(runtime.reconcile(agentID, identity.session_id, request()).retry_authorization, authorization);

	let canonicalDispatches = 0;
	const retryRuntime = new VoiceSessionRuntime({
		store,
		inputWindow: 2,
		transcription: {
			open(_identity, callbacks) {
				return { append() {}, finish() { callbacks.segmentFinal("Example request"); callbacks.thoughtCommitted("Example request"); }, cancel() {} };
			},
		},
		canonical: {
			async prepare() {
				return {
					completionID: "completion-replay-example",
					async dispatch() {
						canonicalDispatches++;
						async function* partials() {}
						return { partials: partials(), final: Promise.resolve({ text: "Example answer", speechEligible: false }) };
					},
				};
			},
		},
	});
	const retryOpen = {
		...openFor(authorization.retry_identity),
		retry_authorization: {
			original_session_id: authorization.original_session_id,
			authorization_id: authorization.authorization_id,
			recording_digest: authorization.recording_digest,
		},
	};
	assert.deepEqual(retryRuntime.open(agentID, retryOpen).events.map((event) => event.kind), ["ready"]);
	assert.deepEqual(retryRuntime.open(agentID, retryOpen).events.map((event) => event.kind), ["ready"], "concurrent exact open is idempotent");
	for (let index = 0; index < audio.length; index++) {
		await retryRuntime.applyClientEvent(agentID, authorization.retry_identity.session_id, {
			version: VOICE_SESSION_VERSION,
			identity: authorization.retry_identity,
			sequence: index + 1,
			kind: "audio",
			audio: audio[index]!.toString("base64"),
			duration_milliseconds: 20,
		});
	}
	await retryRuntime.applyClientEvent(agentID, authorization.retry_identity.session_id, {
		version: VOICE_SESSION_VERSION,
		identity: authorization.retry_identity,
		sequence: 3,
		kind: "end_of_utterance",
	});
	for (let index = 0; index < 20 && !retryRuntime.poll(authorization.retry_identity.session_id, 0).terminal; index++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.equal(retryRuntime.poll(authorization.retry_identity.session_id, 0).events.at(-1)?.kind, "completed");
	assert.equal(canonicalDispatches, 1);
	await retryRuntime.applyClientEvent(agentID, authorization.retry_identity.session_id, {
		version: VOICE_SESSION_VERSION,
		identity: authorization.retry_identity,
		sequence: 3,
		kind: "end_of_utterance",
	});
	assert.equal(canonicalDispatches, 1, "exact replay cannot mint another canonical turn");
	assert.equal(retryRuntime.reconcile(agentID, identity.session_id, request()).disposition, "completed");

	const replayDirectory = join(root, "restart", "replay");
	const authorizationFile = readdirSync(replayDirectory).find((name) => name.startsWith("authorization-"))!;
	const authorizationPath = join(replayDirectory, authorizationFile);
	const expiredOwnership = JSON.parse(readFileSync(authorizationPath, "utf8"));
	expiredOwnership.expires_at = new Date(0).toISOString();
	writeFileSync(authorizationPath, `${JSON.stringify(expiredOwnership)}\n`, { mode: 0o600 });
	chmodSync(authorizationPath, 0o600);
	const ownershipRestart = new VoiceSessionRuntime({
		store: new VoiceSessionStore(join(root, "restart"), 64 * 1024 * 1024, 4),
		inputWindow: 2,
		transcription: provider,
		canonical: canonicalNever,
	});
	assert.equal(ownershipRestart.reconcile(agentID, identity.session_id, request()).disposition, "completed", "consumed ownership survives audio-cache expiry");

	const changedSession = { ...authorization.retry_identity, session_id: "session-unauthorized-example" };
	assert.throws(() => retryRuntime.open(agentID, openFor(changedSession)), /delivery_identity_conflict/);

	// Terminal eviction retains a compact authoritative tombstone for the full
	// recording TTL, so it never degrades into ambiguous not-found.
	const evictionRoot = join(root, "eviction");
	const evictionStore = new VoiceSessionStore(evictionRoot, 64 * 1024 * 1024, 1);
	const evictionRuntime = new VoiceSessionRuntime({ store: evictionStore, inputWindow: 2, transcription: provider, canonical: canonicalNever });
	const evictedIdentity = { ...identity, session_id: "session-evicted-example", capture_id: "capture-evicted-example", delivery_id: "delivery-evicted-example" };
	evictionRuntime.open(agentID, openFor(evictedIdentity));
	await evictionRuntime.applyClientEvent(agentID, evictedIdentity.session_id, { version: VOICE_SESSION_VERSION, identity: evictedIdentity, sequence: 1, kind: "cancel" });
	const replacementIdentity = { ...identity, session_id: "session-replacement-example", capture_id: "capture-replacement-example", delivery_id: "delivery-replacement-example" };
	evictionRuntime.open(agentID, openFor(replacementIdentity));
	assert.throws(() => evictionRuntime.poll(evictedIdentity.session_id, 0), /session_not_found/);
	const evictedRequest = request(evictedIdentity);
	const evictedPlan = evictionRuntime.reconcile(agentID, evictedIdentity.session_id, evictedRequest);
	assert.equal(evictedPlan.disposition, "retry_authorized");
	assert.ok(evictedPlan.retry_authorization);

	const neverIdentity = { ...identity, session_id: "session-never-admitted-example", capture_id: "capture-never-admitted-example", delivery_id: "delivery-never-admitted-example" };
	const neverPlan = evictionRuntime.reconcile(agentID, neverIdentity.session_id, request(neverIdentity));
	assert.equal(neverPlan.disposition, "never_admitted");
	assert.ok(neverPlan.retry_authorization);

	const expiredIdentity = { ...identity, session_id: "session-expired-example", capture_id: "capture-expired-example", delivery_id: "delivery-expired-example" };
	const expiredAt = new Date(Date.now() - VOICE_REPLAY_CACHE_TTL_MILLISECONDS - 1).toISOString();
	const expired = evictionRuntime.reconcile(agentID, expiredIdentity.session_id, request(expiredIdentity, expiredAt));
	assert.equal(expired.disposition, "expired");
	assert.equal(expired.retry_authorization, undefined);

	// A dispatching durable session is explicitly unknown and can never receive
	// a replay authorization, even when its terminal record is restored.
	const unknownRoot = join(root, "unknown");
	const unknownStore = new VoiceSessionStore(unknownRoot, 64 * 1024 * 1024, 4);
	const completedRecord = store.load().find((record) => record.open.identity.session_id === authorization.retry_identity.session_id)!;
	const unknownIdentity = { ...identity, session_id: "session-unknown-example", capture_id: "capture-unknown-example", delivery_id: "delivery-unknown-example" };
	const unknownRecord: StoredVoiceSession = {
		...completedRecord,
		open: { ...completedRecord.open, identity: unknownIdentity, retry_authorization: undefined },
		input: { ...completedRecord.input, identity: unknownIdentity },
		events: completedRecord.events.map((event) => ({ ...event, identity: unknownIdentity })),
		canonical_dispatch: { status: "dispatching", completion_id: completedRecord.completion_id! },
		terminal: false,
		phase: "accepted",
	};
	// Use a legal admitted snapshot and let restart convert dispatching custody
	// into canonical_delivery_unknown.
	unknownRecord.events = unknownRecord.events.slice(0, unknownRecord.events.findIndex((event) => event.kind === "assistant_final"));
	unknownRecord.events = unknownRecord.events.filter((event) => !event.kind.startsWith("assistant_"));
	unknownRecord.events = unknownRecord.events.filter((event) => event.kind !== "completed");
	unknownRecord.timing = unknownRecord.timing?.filter((record) =>
		!["assistant_first_output", "assistant_final", "speech_started",
			"speech_first_segment", "speech_completed", "terminal_persisted"].includes(record.stage))
		.map((record, index) => ({ ...record, ordinal: index + 1 }));
	const unknownRequest = request(unknownIdentity);
	unknownRecord.input = {
		...unknownRecord.input,
		input_closed: true,
		closure_reason: "client_terminal",
		fingerprints: {
			"1": unknownRequest.frames[0]!.event_fingerprint,
			"2": unknownRequest.frames[1]!.event_fingerprint,
			"3": voiceFingerprint({
				version: VOICE_SESSION_VERSION,
				identity: unknownIdentity,
				sequence: 3,
				kind: "end_of_utterance",
			}),
		},
	};
	unknownStore.write(unknownRecord);
	const unknownRuntime = new VoiceSessionRuntime({ store: unknownStore, inputWindow: 2, transcription: provider, canonical: canonicalNever });
	const unknown = unknownRuntime.reconcile(agentID, unknownIdentity.session_id, unknownRequest);
	assert.equal(unknown.disposition, "unknown");
	assert.equal(unknown.canonical_custody, "dispatching");
	assert.equal(unknown.retry_authorization, undefined);

	console.log("voice session replay reconciliation tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
