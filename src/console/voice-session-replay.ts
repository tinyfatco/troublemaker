import { createHash } from "node:crypto";
import {
	chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
	statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	VOICE_REPLAY_CACHE_TTL_MILLISECONDS, VOICE_REPLAY_VERSION, VoiceInputLedger,
	isSafeVoiceIdentifier, isVoiceIdentity, sameVoiceIdentity, validateVoiceOpen,
	voiceReplayRecordingDigest,
	type VoiceCanonicalCustody, type VoiceConfiguration, type VoiceIdentity,
	type VoiceReplayAuthorization, type VoiceReplayFrameCommitment,
} from "./voice-session-contract.js";
import type { StoredVoiceSession } from "./voice-session-store.js";

export interface VoiceReplayTombstone {
	version: 1;
	kind: "tombstone";
	identity: VoiceIdentity;
	configuration: VoiceConfiguration;
	input: StoredVoiceSession["input"];
	canonical_custody: VoiceCanonicalCustody;
	terminal_kind: "completed" | "cancelled" | "error";
	completion_id?: string;
	error_code?: string;
	updated_at: string;
	expires_at: string;
}

export interface VoiceReplayPresenceRecord {
	version: 1;
	kind: "presence";
	identity: VoiceIdentity;
	configuration: VoiceConfiguration;
	canonical_custody: VoiceCanonicalCustody;
	terminal_kind?: "completed" | "cancelled" | "error";
	error_code?: string;
	updated_at: string;
	expires_at: string;
}

export interface VoiceReplayAuthorizationRecord {
	version: 1;
	kind: "authorization";
	original_identity: VoiceIdentity;
	configuration: VoiceConfiguration;
	recording_digest: string;
	frames: VoiceReplayFrameCommitment[];
	authorization_id: string;
	retry_identity: VoiceIdentity;
	state: "issued" | "consumed";
	issued_at: string;
	expires_at: string;
}

export type VoiceReplayDurableRecord = VoiceReplayTombstone | VoiceReplayPresenceRecord | VoiceReplayAuthorizationRecord;

export class VoiceSessionReplayStore {
	constructor(
		private readonly directory: string,
		private readonly maximumBytes = 64 * 1024 * 1024,
		private readonly maximumRecords = 1_024,
		private readonly now: () => Date = () => new Date(),
	) {
		if (!directory.startsWith("/") || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
			|| !Number.isSafeInteger(maximumRecords) || maximumRecords < 1) {
			throw new Error("Voice replay store bounds are invalid");
		}
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	}

	load(): VoiceReplayDurableRecord[] {
		this.removeExpired();
		return this.entries().map((entry) => entry.record);
	}

	findTombstone(sessionID: string): VoiceReplayTombstone | undefined {
		return this.load().find((record): record is VoiceReplayTombstone =>
			record.kind === "tombstone" && record.identity.session_id === sessionID);
	}

	findPresence(sessionID: string): VoiceReplayPresenceRecord | undefined {
		return this.load().find((record): record is VoiceReplayPresenceRecord =>
			record.kind === "presence" && record.identity.session_id === sessionID);
	}

	markPresent(open: StoredVoiceSession["open"]): VoiceReplayPresenceRecord {
		const existing = this.findPresence(open.identity.session_id);
		if (existing) {
			if (!sameVoiceIdentity(existing.identity, open.identity)
				|| JSON.stringify(existing.configuration) !== JSON.stringify(open.configuration)) {
				throw new Error("session_identity_conflict");
			}
			return existing;
		}
		const now = this.now();
		const presence: VoiceReplayPresenceRecord = {
			version: 1,
			kind: "presence",
			identity: open.identity,
			configuration: open.configuration,
			canonical_custody: "none",
			updated_at: now.toISOString(),
			expires_at: new Date(now.getTime() + VOICE_REPLAY_CACHE_TTL_MILLISECONDS).toISOString(),
		};
		this.write(presence);
		return presence;
	}

	synchronize(record: StoredVoiceSession): VoiceReplayPresenceRecord {
		const existing = this.findPresence(record.open.identity.session_id);
		const custody = canonicalCustody(record);
		const terminal = record.events.at(-1);
		const now = this.now();
		const presence: VoiceReplayPresenceRecord = {
			version: 1,
			kind: "presence",
			identity: record.open.identity,
			configuration: record.open.configuration,
			canonical_custody: custody,
			...(["completed", "cancelled", "error"].includes(terminal?.kind ?? "")
				? { terminal_kind: terminal!.kind as VoiceReplayPresenceRecord["terminal_kind"] }
				: {}),
			...(terminal?.error_code ? { error_code: terminal.error_code } : {}),
			updated_at: record.updated_at,
			expires_at: existing?.expires_at
				?? new Date(now.getTime() + VOICE_REPLAY_CACHE_TTL_MILLISECONDS).toISOString(),
		};
		this.write(presence);
		return presence;
	}

	findAuthorizationForOriginal(sessionID: string): VoiceReplayAuthorizationRecord | undefined {
		return this.load().find((record): record is VoiceReplayAuthorizationRecord =>
			record.kind === "authorization" && record.original_identity.session_id === sessionID);
	}

	findAuthorizationForRetry(sessionID: string): VoiceReplayAuthorizationRecord | undefined {
		return this.load().find((record): record is VoiceReplayAuthorizationRecord =>
			record.kind === "authorization" && record.retry_identity.session_id === sessionID);
	}

	preserve(record: StoredVoiceSession): VoiceReplayTombstone {
		if (!record.terminal) throw new Error("Only terminal voice sessions may become replay tombstones");
		this.synchronize(record);
		const terminal = record.events.at(-1);
		if (!terminal || !["completed", "cancelled", "error"].includes(terminal.kind)) {
			throw new Error("Voice replay tombstone requires a terminal event");
		}
		const expires = new Date(this.now().getTime() + VOICE_REPLAY_CACHE_TTL_MILLISECONDS).toISOString();
		const tombstone: VoiceReplayTombstone = {
			version: 1,
			kind: "tombstone",
			identity: record.open.identity,
			configuration: record.open.configuration,
			input: record.input,
			canonical_custody: canonicalCustody(record),
			terminal_kind: terminal.kind as VoiceReplayTombstone["terminal_kind"],
			...(record.completion_id ? { completion_id: record.completion_id } : {}),
			...(terminal.error_code ? { error_code: terminal.error_code } : {}),
			updated_at: record.updated_at,
			expires_at: expires,
		};
		this.write(tombstone);
		return tombstone;
	}

	issue(
		originalIdentity: VoiceIdentity,
		configuration: VoiceConfiguration,
		recordingDigest: string,
		frames: VoiceReplayFrameCommitment[],
	): VoiceReplayAuthorizationRecord {
		const existing = this.findAuthorizationForOriginal(originalIdentity.session_id);
		if (existing) {
			if (!sameVoiceIdentity(existing.original_identity, originalIdentity)
				|| JSON.stringify(existing.configuration) !== JSON.stringify(configuration)
				|| existing.recording_digest !== recordingDigest
				|| JSON.stringify(existing.frames) !== JSON.stringify(frames)) {
				throw new Error("voice_replay_authorization_conflict");
			}
			return existing;
		}
		const seed = createHash("sha256").update([
			originalIdentity.session_id,
			originalIdentity.capture_id,
			originalIdentity.delivery_id,
			recordingDigest,
		].join("\n")).digest("hex");
		const issuedAt = this.now();
		const record: VoiceReplayAuthorizationRecord = {
			version: 1,
			kind: "authorization",
			original_identity: originalIdentity,
			configuration,
			recording_digest: recordingDigest,
			frames,
			authorization_id: `voice-retry-auth-${seed.slice(0, 32)}`,
			retry_identity: {
				session_id: `voice-retry-session-${seed.slice(0, 32)}`,
				capture_id: `voice-retry-capture-${seed.slice(32)}`,
				delivery_id: originalIdentity.delivery_id,
				subject_agent_id: originalIdentity.subject_agent_id,
			},
			state: "issued",
			issued_at: issuedAt.toISOString(),
			expires_at: new Date(issuedAt.getTime() + VOICE_REPLAY_CACHE_TTL_MILLISECONDS).toISOString(),
		};
		this.write(record);
		return record;
	}

	consume(
		originalSessionID: string,
		authorizationID: string,
		recordingDigest: string,
		retryIdentity: VoiceIdentity,
		configuration: VoiceConfiguration,
	): VoiceReplayAuthorizationRecord {
		const record = this.findAuthorizationForOriginal(originalSessionID);
		if (!record || record.authorization_id !== authorizationID
			|| record.recording_digest !== recordingDigest
			|| !sameVoiceIdentity(record.retry_identity, retryIdentity)
			|| JSON.stringify(record.configuration) !== JSON.stringify(configuration)) {
			throw new Error("invalid_retry_authorization");
		}
		if (record.state === "consumed") return record;
		if (Date.parse(record.expires_at) <= this.now().getTime()) throw new Error("retry_authorization_expired");
		const consumed: VoiceReplayAuthorizationRecord = { ...record, state: "consumed" };
		this.write(consumed);
		return consumed;
	}

	wireAuthorization(record: VoiceReplayAuthorizationRecord): VoiceReplayAuthorization {
		return {
			authorization_id: record.authorization_id,
			original_session_id: record.original_identity.session_id,
			retry_identity: record.retry_identity,
			recording_digest: record.recording_digest,
			expires_at: record.expires_at,
		};
	}

	private write(record: VoiceReplayDurableRecord): void {
		if (!validRecord(record)) throw new Error("Invalid voice replay record");
		this.removeExpired();
		const name = fileName(record);
		const path = join(this.directory, name);
		const body = `${JSON.stringify(record)}\n`;
		const entries = this.entries().filter((entry) => entry.name !== name);
		const projectedBytes = entries.reduce((sum, entry) => sum + entry.size, 0) + Buffer.byteLength(body);
		if (entries.length + 1 > this.maximumRecords || projectedBytes > this.maximumBytes) {
			throw new Error("Voice replay store capacity is exhausted by unexpired records");
		}
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
	}

	private removeExpired(): void {
		const now = this.now().getTime();
		for (const entry of this.entries(false)) {
			if (entry.record.kind === "authorization" && entry.record.state === "consumed") continue;
			if (entry.record.kind === "presence" && entry.record.canonical_custody !== "none") continue;
			if (Date.parse(entry.record.expires_at) > now) continue;
			rmSync(join(this.directory, entry.name), { force: true });
		}
	}

	private entries(validateExpiry = true): Array<{ name: string; size: number; record: VoiceReplayDurableRecord }> {
		const result: Array<{ name: string; size: number; record: VoiceReplayDurableRecord }> = [];
		for (const name of readdirSync(this.directory)) {
			if (!name.endsWith(".json")) continue;
			const path = join(this.directory, name);
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Voice replay store is unsafe");
			let record: VoiceReplayDurableRecord;
			try { record = JSON.parse(readFileSync(path, "utf8")) as VoiceReplayDurableRecord; }
			catch { throw new Error("Voice replay store is unreadable"); }
			const durableConsumedOwnership = record.kind === "authorization" && record.state === "consumed";
			const durableCanonicalOwnership = record.kind === "presence" && record.canonical_custody !== "none";
			if (!validRecord(record) || fileName(record) !== name
				|| (validateExpiry && !durableConsumedOwnership && !durableCanonicalOwnership
					&& Date.parse(record.expires_at) <= this.now().getTime())) {
				throw new Error("Voice replay store is unreadable");
			}
			result.push({ name, size: statSync(path).size, record });
		}
		return result;
	}
}

export function canonicalCustody(record: StoredVoiceSession): VoiceCanonicalCustody {
	if (record.canonical_dispatch) return record.canonical_dispatch.status;
	if (record.events.some((event) => event.kind === "send_accepted")) return "unknown";
	return "none";
}

function fileName(record: VoiceReplayDurableRecord): string {
	const sessionID = record.kind === "authorization"
		? record.original_identity.session_id
		: record.identity.session_id;
	const prefix = record.kind;
	return `${prefix}-${createHash("sha256").update(sessionID).digest("hex")}.json`;
}

function validRecord(record: VoiceReplayDurableRecord): boolean {
	if (!record || record.version !== 1 || !Number.isFinite(Date.parse(record.expires_at))) return false;
	if (record.kind === "tombstone") {
		try {
			validateVoiceOpen({
				version: "computer.voice-session.v1",
				identity: record.identity,
				audio: { encoding: "pcm_s16le", sample_rate: 16_000, channel_count: 1 },
				configuration: record.configuration,
			});
			new VoiceInputLedger(record.identity, record.input);
		} catch { return false; }
		return ["none", "admitted", "dispatching", "completed", "failed", "unknown"].includes(record.canonical_custody)
			&& ["completed", "cancelled", "error"].includes(record.terminal_kind)
			&& Number.isFinite(Date.parse(record.updated_at))
			&& (!record.completion_id || isSafeVoiceIdentifier(record.completion_id))
			&& (!record.error_code || isSafeVoiceIdentifier(record.error_code));
	}
	if (record.kind === "presence") {
		try {
			validateVoiceOpen({
				version: "computer.voice-session.v1",
				identity: record.identity,
				audio: { encoding: "pcm_s16le", sample_rate: 16_000, channel_count: 1 },
				configuration: record.configuration,
			});
		} catch { return false; }
		return ["none", "admitted", "dispatching", "completed", "failed", "unknown"].includes(record.canonical_custody)
			&& Number.isFinite(Date.parse(record.updated_at))
			&& (!record.terminal_kind || ["completed", "cancelled", "error"].includes(record.terminal_kind))
			&& (!record.error_code || isSafeVoiceIdentifier(record.error_code));
	}
	if (record.kind !== "authorization" || !isVoiceIdentity(record.original_identity)
		|| !isVoiceIdentity(record.retry_identity) || record.original_identity.delivery_id !== record.retry_identity.delivery_id
		|| record.original_identity.subject_agent_id !== record.retry_identity.subject_agent_id
		|| !isSafeVoiceIdentifier(record.authorization_id) || !/^[a-f0-9]{64}$/.test(record.recording_digest)
		|| !["issued", "consumed"].includes(record.state) || !Number.isFinite(Date.parse(record.issued_at))
		|| !Array.isArray(record.frames) || record.frames.length < 1
		|| record.recording_digest !== voiceReplayRecordingDigest(record.frames)) return false;
	return record.frames.every((frame, index) => frame.sequence === index + 1
		&& /^[a-f0-9]{64}$/.test(frame.audio_sha256)
		&& /^[a-f0-9]{64}$/.test(frame.event_fingerprint)
		&& Number.isSafeInteger(frame.byte_count) && frame.byte_count > 0
		&& Number.isSafeInteger(frame.duration_milliseconds) && frame.duration_milliseconds > 0);
}
