import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	VOICE_SESSION_VERSION,
	type VoiceIdentity,
} from "../src/console/voice-session-contract.js";
import {
	VoiceSessionRuntime,
	type VoiceTranscriptionProvider,
} from "../src/console/voice-session-runtime.js";
import {
	VoiceSessionStore,
	type StoredVoiceSession,
} from "../src/console/voice-session-store.js";
import {
	VOICE_RECEIPT_VERSION,
	parseVoiceReceiptAuthorityKey,
	verifyVoiceReceiptAuthorityProof,
	voiceReceiptAgentCorrelation,
	voiceReceiptAuthorityProof,
	voiceReceiptBodyDigest,
	voiceReceiptCorrelation,
} from "../src/console/voice-receipts.js";

const root = mkdtempSync(join(tmpdir(), "troublemaker-voice-receipts-"));
const storeRoot = join(root, "sessions");
const provider: VoiceTranscriptionProvider = {
	open() { return { append() {}, finish() {}, cancel() {} }; },
};
const canonical = { async prepare() { throw new Error("canonical work is not expected"); } };
const baseTime = Date.parse("2030-01-01T00:00:00.000Z");
let now = baseTime;
const routeAgentID = "agent-example";
const agentCorrelation = voiceReceiptAgentCorrelation("current", routeAgentID);

try {
	const authorityKey = Buffer.alloc(32, 0x41);
	const authorityInput = {
		method: "POST" as const,
		path_and_query: "/api/v2/agents/current/voice-sessions/session-example/events",
		body_digest: voiceReceiptBodyDigest(Buffer.from("synthetic-audio-event", "utf8")),
		agent_correlation: agentCorrelation,
		request_correlation: voiceReceiptCorrelation("signed-request-nonce-authority"),
	};
	const authorityProof = voiceReceiptAuthorityProof(authorityKey, authorityInput);
	assert.equal(verifyVoiceReceiptAuthorityProof(authorityKey, authorityInput, authorityProof), true);
	assert.equal(verifyVoiceReceiptAuthorityProof(authorityKey, {
		...authorityInput,
		body_digest: voiceReceiptBodyDigest(Buffer.from("changed-event", "utf8")),
	}, authorityProof), false, "authority is bound to the exact body, route, request, and agent claim");
	assert.deepEqual(
		parseVoiceReceiptAuthorityKey(authorityKey.toString("base64url")),
		new Uint8Array(authorityKey),
	);
	assert.throws(() => parseVoiceReceiptAuthorityKey("not-a-protected-key"), /Invalid voice receipt authority key/);

	const identity = makeIdentity("one", routeAgentID);
	const store = new VoiceSessionStore(storeRoot, 64 * 1024 * 1024, 8);
	let runtime = new VoiceSessionRuntime({
		transcription: provider,
		canonical,
		store,
		inputWindow: 2,
		receiptNow: () => new Date(now),
		receiptRetentionMs: 1_000,
		maximumReceiptsPerSession: 4,
	});
	const open = makeOpen(identity);
	runtime.open(routeAgentID, open);
	const requestCorrelation = voiceReceiptCorrelation("signed-request-nonce-example-0001");
	const claim = {
		agent_correlation: agentCorrelation,
		request_correlation: requestCorrelation,
	};
	const audio = makeAudio(identity, 1);

	// The returned Poll is deliberately discarded: the durable checkpoint is
	// the authority across the crash-before-response window.
	await runtime.applyClientEvent(routeAgentID, identity.session_id, audio, claim);
	const stored = store.load()[0]!;
	assert.equal(stored.input.highest_client_sequence, 1);
	assert.equal(stored.voice_receipts?.length, 1);
	const durableReceipt = structuredClone(stored.voice_receipts![0]!);
	assert.deepEqual(Object.keys(stored.voice_receipts![0]!).sort(), [
		"agent_correlation",
		"client_sequence",
		"expires_at",
		"kind",
		"receipt_digest",
		"recorded_at",
		"request_correlation",
		"server_sequence",
		"session_correlation",
		"version",
	].sort());
	assert.doesNotMatch(JSON.stringify(stored.voice_receipts), /session-one|signed-request-nonce|audio|transcript|text|url|route|prompt|credential/i);

	runtime = new VoiceSessionRuntime({
		transcription: provider,
		canonical,
		store: new VoiceSessionStore(storeRoot, 64 * 1024 * 1024, 8),
		inputWindow: 2,
		receiptNow: () => new Date(now),
		receiptRetentionMs: 1_000,
		maximumReceiptsPerSession: 4,
	});
	const lookup = {
		session_correlation: voiceReceiptCorrelation(identity.session_id),
		request_correlation: requestCorrelation,
		client_sequence: 1,
	};
	const recovered = runtime.lookupVoiceReceipt(routeAgentID, lookup, agentCorrelation);
	assert.equal(recovered?.version, VOICE_RECEIPT_VERSION);
	assert.equal(recovered?.kind, "event_applied");
	assert.equal(recovered?.client_sequence, 1);
	assert.equal(recovered?.session_correlation, lookup.session_correlation);
	assert.equal(recovered?.request_correlation, lookup.request_correlation);
	assert.equal(recovered?.receipt_digest.length, 64);
	assert.equal(runtime.lookupVoiceReceipt(routeAgentID, lookup, agentCorrelation)?.receipt_digest, recovered?.receipt_digest, "lookup is idempotent");
	assert.equal(runtime.lookupVoiceReceipt(routeAgentID, lookup, voiceReceiptAgentCorrelation("other", routeAgentID)), null, "route authority is isolated");
	assert.equal(runtime.lookupVoiceReceipt("other-agent", lookup, agentCorrelation), null, "subject authority is isolated");

	for (let index = 2; index <= 6; index++) {
		await runtime.applyClientEvent(routeAgentID, identity.session_id, audio, {
			agent_correlation: agentCorrelation,
			request_correlation: voiceReceiptCorrelation(`signed-request-nonce-example-000${index}`),
		});
	}
	const retained = new VoiceSessionStore(storeRoot, 64 * 1024 * 1024, 8).load()[0]!.voice_receipts!;
	assert.equal(retained.length, 4, "per-session receipt custody is bounded");
	assert.equal(retained.some((receipt) => receipt.request_correlation === requestCorrelation), false, "oldest receipt is evicted deterministically");
	assert.equal(retained.at(-1)?.request_correlation, voiceReceiptCorrelation("signed-request-nonce-example-0006"));

	now += 1_001;
	assert.equal(runtime.lookupVoiceReceipt(routeAgentID, {
		...lookup,
		request_correlation: voiceReceiptCorrelation("signed-request-nonce-example-0006"),
	}, agentCorrelation), null, "expired evidence is unavailable");
	assert.deepEqual(new VoiceSessionStore(storeRoot, 64 * 1024 * 1024, 8).load()[0]!.voice_receipts, [], "expiry is durably pruned");

	const crashRoot = join(root, "crash-after-checkpoint");
	class CrashAfterCheckpointStore extends VoiceSessionStore {
		private crashed = false;
		override write(record: StoredVoiceSession): string[] {
			const evicted = super.write(record);
			if (!this.crashed && record.input.highest_client_sequence === 1) {
				this.crashed = true;
				throw new Error("synthetic crash after durable checkpoint");
			}
			return evicted;
		}
	}
	const crashStore = new CrashAfterCheckpointStore(crashRoot, 64 * 1024 * 1024, 4);
	const crashIdentity = makeIdentity("crash-window", routeAgentID);
	const crashRuntime = new VoiceSessionRuntime({
		transcription: provider,
		canonical,
		store: crashStore,
		inputWindow: 2,
		receiptNow: () => new Date(baseTime),
	});
	crashRuntime.open(routeAgentID, makeOpen(crashIdentity));
	const crashRequestCorrelation = voiceReceiptCorrelation("signed-request-nonce-crash-window");
	await assert.rejects(crashRuntime.applyClientEvent(
		routeAgentID,
		crashIdentity.session_id,
		makeAudio(crashIdentity, 1),
		{
			agent_correlation: agentCorrelation,
			request_correlation: crashRequestCorrelation,
		},
	), /synthetic crash after durable checkpoint/);
	const crashRestart = new VoiceSessionRuntime({
		transcription: provider,
		canonical,
		store: new VoiceSessionStore(crashRoot, 64 * 1024 * 1024, 4),
		inputWindow: 2,
		receiptNow: () => new Date(baseTime),
	});
	assert.equal(crashRestart.lookupVoiceReceipt(routeAgentID, {
		session_correlation: voiceReceiptCorrelation(crashIdentity.session_id),
		request_correlation: crashRequestCorrelation,
		client_sequence: 1,
	}, agentCorrelation)?.kind, "event_applied", "checkpoint replacement survives a crash before any response escapes");

	const failureRoot = join(root, "failure");
	class FailSecondWriteStore extends VoiceSessionStore {
		private writes = 0;
		override write(record: StoredVoiceSession): string[] {
			this.writes++;
			if (this.writes === 2) throw new Error("synthetic checkpoint failure");
			return super.write(record);
		}
	}
	const failureStore = new FailSecondWriteStore(failureRoot, 64 * 1024 * 1024, 4);
	const failureIdentity = makeIdentity("failure", routeAgentID);
	const failureRuntime = new VoiceSessionRuntime({
		transcription: provider,
		canonical,
		store: failureStore,
		inputWindow: 2,
		receiptNow: () => new Date(baseTime),
	});
	failureRuntime.open(routeAgentID, makeOpen(failureIdentity));
	await assert.rejects(failureRuntime.applyClientEvent(
		routeAgentID,
		failureIdentity.session_id,
		makeAudio(failureIdentity, 1),
		claim,
	), /synthetic checkpoint failure/);
	const failedRecord = new VoiceSessionStore(failureRoot, 64 * 1024 * 1024, 4).load()[0]!;
	assert.equal(failedRecord.input.highest_client_sequence, 0);
	assert.deepEqual(failedRecord.voice_receipts, [], "receipt cannot outlive a rolled-back audio checkpoint");

	const corruptRoot = join(root, "corrupt");
	mkdirSync(corruptRoot, { recursive: true, mode: 0o700 });
	const sourceFile = readdirSync(storeRoot).find((name) => name.endsWith(".json"))!;
	const corrupt = structuredClone(new VoiceSessionStore(storeRoot, 64 * 1024 * 1024, 8).load()[0]!);
	corrupt.voice_receipts = [{
		...durableReceipt,
		raw_session_id: identity.session_id,
	} as never];
	const corruptPath = join(corruptRoot, sourceFile);
	writeFileSync(corruptPath, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
	chmodSync(corruptPath, 0o600);
	assert.throws(() => new VoiceSessionStore(corruptRoot, 64 * 1024 * 1024, 8).load(), /unreadable/, "extra or content-bearing receipt fields fail closed");
	const digestRoot = join(root, "corrupt-digest");
	mkdirSync(digestRoot, { recursive: true, mode: 0o700 });
	const changedDigest = structuredClone(new VoiceSessionStore(storeRoot, 64 * 1024 * 1024, 8).load()[0]!);
	changedDigest.voice_receipts = [{ ...durableReceipt, receipt_digest: "0".repeat(64) }];
	const digestPath = join(digestRoot, sourceFile);
	writeFileSync(digestPath, `${JSON.stringify(changedDigest)}\n`, { mode: 0o600 });
	chmodSync(digestPath, 0o600);
	assert.throws(() => new VoiceSessionStore(digestRoot, 64 * 1024 * 1024, 8).load(), /unreadable/, "receipt identity and counters are digest-bound");

	console.log("voice receipt contract tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function makeIdentity(suffix: string, subjectAgentID: string): VoiceIdentity {
	return {
		session_id: `session-${suffix}`,
		capture_id: `capture-${suffix}`,
		delivery_id: `delivery-${suffix}`,
		subject_agent_id: subjectAgentID,
	};
}

function makeOpen(identity: VoiceIdentity) {
	return {
		version: VOICE_SESSION_VERSION,
		identity,
		audio: { encoding: "pcm_s16le" as const, sample_rate: 16_000 as const, channel_count: 1 as const },
		configuration: { response_policy: "standard" as const, speech_mode: "silent" as const },
	};
}

function makeAudio(identity: VoiceIdentity, sequence: number) {
	return {
		version: VOICE_SESSION_VERSION,
		identity,
		sequence,
		kind: "audio" as const,
		audio: Buffer.alloc(32).toString("base64"),
		duration_milliseconds: 1,
	};
}
