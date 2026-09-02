import {
	chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
	renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	VoiceSessionReplayStore,
	type VoiceReplayAuthorizationRecord,
	type VoiceReplayDurableRecord,
} from "./voice-session-replay.js";
import {
	isSafeVoiceIdentifier, sameVoiceIdentity, validateVoiceOpen, validateVoiceServerEvent,
	VOICE_LIMITS, VoiceInputLedger, VoiceSpeechFlowLedger, voiceFingerprint,
	type VoiceInputCheckpoint, type VoiceOpen, type VoiceServerEvent,
	type VoiceSpeechFlowCheckpoint,
} from "./voice-session-contract.js";
import {
	validateVoiceSessionTiming,
	type VoiceSessionTimingRecord,
} from "./voice-session-timing.js";
import {
	MAXIMUM_VOICE_RECEIPTS_PER_SESSION,
	isStoredVoiceReceipt,
	voiceReceiptCorrelation,
	type StoredVoiceReceipt,
} from "./voice-receipts.js";

export interface StoredVoiceSession {
	version: 1 | 2 | 3;
	open: VoiceOpen;
	input: VoiceInputCheckpoint;
	events: VoiceServerEvent[];
	phase: string;
	completion_id?: string;
	canonical_dispatch?: { status:"admitted"|"dispatching"|"completed"|"failed"; completion_id:string };
	speech_stream_id?: string;
	speech_flow?: VoiceSpeechFlowCheckpoint;
	total_speech_bytes: number;
	total_speech_milliseconds: number;
	partial_text: string;
	final_segments?: string[];
	final_text?: string;
	terminal: boolean;
	voice_receipts?: StoredVoiceReceipt[];
	timing?: VoiceSessionTimingRecord[];
	updated_at: string;
}

interface StoredEntry { name: string; path: string; size: number; mtime: number; terminal: boolean }

export const VOICE_SESSION_ACTIVE_RESERVATION_BYTES = 32 * 1024 * 1024;
export const VOICE_SESSION_PERSISTED_TEXT_BYTES = 2 * 1024 * 1024;
export interface VoiceSessionStoreFileOperations {
	write(path:string, body:string):void;
	chmod(path:string):void;
	rename(from:string,to:string):void;
	remove(path:string):void;
	read?(path:string):string;
	exists?(path:string):boolean;
}
export class VoiceSessionDurabilityUncertainError extends Error { readonly code="voice_session_durability_uncertain"; }
const DEFAULT_FILE_OPERATIONS:VoiceSessionStoreFileOperations={
	write:(path,body)=>writeFileSync(path,body,{encoding:"utf8",mode:0o600}),
	chmod:(path)=>chmodSync(path,0o600), rename:(from,to)=>renameSync(from,to),
	remove:(path)=>rmSync(path,{force:true}), read:(path)=>readFileSync(path,"utf8"), exists:(path)=>existsSync(path),
};

/** Owner-only bounded event outbox. Raw microphone audio is never stored. */
export class VoiceSessionStore {
	private replayStore?: VoiceSessionReplayStore;

	get replay(): VoiceSessionReplayStore {
		return this.replayStore ??= new VoiceSessionReplayStore(join(this.directory, "replay"));
	}

	replayRecords(): VoiceReplayDurableRecord[] {
		if (!this.replayStore && !existsSync(join(this.directory, "replay"))) return [];
		return this.replay.load();
	}

	findReplayAuthorizationForRetry(sessionID: string): VoiceReplayAuthorizationRecord | undefined {
		return this.replayRecords().find((record): record is VoiceReplayAuthorizationRecord =>
			record.kind === "authorization" && record.retry_identity.session_id === sessionID);
	}

	constructor(
		private readonly directory: string,
		private readonly maximumBytes = 64 * 1024 * 1024,
		private readonly maximumSessions = 32,
		private readonly fileOperations: VoiceSessionStoreFileOperations = DEFAULT_FILE_OPERATIONS,
	) {
		if (!directory.startsWith("/")) throw new Error("Voice session store path must be absolute");
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
			|| !Number.isSafeInteger(maximumSessions) || maximumSessions < 1) {
			throw new Error("Voice session store bounds are invalid");
		}
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	}

	load(): StoredVoiceSession[] {
		return this.entries().map((entry) => this.readRecord(entry.path))
			.sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
	}

	write(record: StoredVoiceSession): string[] {
		if (!validRecord(record)) throw new Error("Invalid voice session record");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const name = fileName(record.open.identity.session_id);
		const path = join(this.directory, name);
		const body = `${JSON.stringify(record)}\n`;
		const bodyBytes = Buffer.byteLength(body);
		if (bodyBytes > VOICE_SESSION_ACTIVE_RESERVATION_BYTES) throw new Error("Voice session record exceeds its durable reservation");
		const entries = this.entries().filter((entry) => entry.name !== name);
		const removals: StoredEntry[] = [];
		let projectedCount = entries.length + 1;
		let projectedBytes = entries.reduce((sum, entry) => sum + (entry.terminal ? entry.size : VOICE_SESSION_ACTIVE_RESERVATION_BYTES), 0)
			+ (record.terminal ? bodyBytes : VOICE_SESSION_ACTIVE_RESERVATION_BYTES);
		for (const entry of entries.filter((candidate) => candidate.terminal).sort((a, b) => a.mtime - b.mtime)) {
			if (projectedCount <= this.maximumSessions && projectedBytes <= this.maximumBytes) break;
			removals.push(entry);
			projectedCount--;
			projectedBytes -= entry.size;
		}
		if (projectedCount > this.maximumSessions || projectedBytes > this.maximumBytes) {
			throw new Error("Voice session store capacity is exhausted by active sessions");
		}

		// A compact, owner-only tombstone is committed before any terminal record
		// may be evicted. Failure preserves the full session and fails capacity
		// closed rather than turning `session_not_found` into ambiguous custody.
		for (const entry of removals) this.replay.preserve(this.readRecord(entry.path));

		const readDurable = this.fileOperations.read ?? ((target:string) => readFileSync(target,"utf8"));
		const durableExists = this.fileOperations.exists ?? ((target:string) => existsSync(target));
		const previousBody = durableExists(path) ? readDurable(path) : undefined;
		const temporary = `${path}.${process.pid}.tmp`;
		try {
			this.fileOperations.write(temporary, body);
			this.fileOperations.chmod(temporary);
			this.fileOperations.rename(temporary, path);
		} catch (error) {
			let destination: string | undefined;
			try { destination = readDurable(path); } catch { /* classify below */ }
			try { this.fileOperations.remove(temporary); } catch { /* best-effort temporary cleanup */ }
			if (destination !== body) {
				try {
					if (previousBody === undefined) this.fileOperations.remove(path);
					else {
						const recovery = `${path}.${process.pid}.recovery`;
						this.fileOperations.write(recovery, previousBody);
						this.fileOperations.chmod(recovery); this.fileOperations.rename(recovery, path);
					}
					const restored = previousBody === undefined ? !durableExists(path) : readDurable(path) === previousBody;
					if (!restored) throw new Error("prior durable bytes did not verify");
				} catch (recoveryError) {
					throw new VoiceSessionDurabilityUncertainError(`Voice session durable recovery failed: ${recoveryError instanceof Error ? recoveryError.message : "unknown error"}`);
				}
				throw error;
			}
		}
		const evicted: string[] = [];
		for (const entry of removals) {
			try { this.fileOperations.remove(entry.path); evicted.push(entry.name.slice(0, -".json".length)); }
			catch { /* retain the same terminal session in both live and durable projections */ }
		}
		return evicted;
	}

	private entries(): StoredEntry[] {
		const entries: StoredEntry[] = [];
		for (const name of readdirSync(this.directory)) {
			if (!name.endsWith(".json")) continue;
			const path = join(this.directory, name);
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
				throw new Error("Voice session store is unsafe");
			}
			const record = this.readRecord(path);
			if (fileName(record.open.identity.session_id) !== name) throw new Error("Voice session store is unreadable");
			entries.push({ name, path, size: stat.size, mtime: stat.mtimeMs, terminal: record.terminal });
		}
		return entries;
	}

	private readRecord(path: string): StoredVoiceSession {
		let record: StoredVoiceSession;
		try { record = JSON.parse(readFileSync(path, "utf8")) as StoredVoiceSession; }
		catch { throw new Error("Voice session store is unreadable"); }
		if (!validRecord(record)) throw new Error("Voice session store is unreadable");
		return record;
	}
}

function fileName(sessionID: string): string { return `${sessionID}.json`; }
function validRecord(record: StoredVoiceSession): boolean {
	try {
		validateVoiceOpen(record.open);
		new VoiceInputLedger(record.open.identity, record.input);
		if (record.speech_flow) {
			if (!record.completion_id || !record.speech_stream_id) return false;
			new VoiceSpeechFlowLedger(record.open.identity, record.completion_id, record.speech_stream_id, record.speech_flow);
		}
		validateVoiceSessionTiming(record.timing ?? []);
	} catch { return false; }
	const identity = record.open.identity;
	const basic = (record?.version === 1 || record?.version === 2 || record?.version === 3)
		&& isSafeVoiceIdentifier(identity.session_id)
		&& !!record.input?.identity && sameVoiceIdentity(record.input.identity, identity)
		&& (!record.speech_flow || (!!record.speech_flow.identity && sameVoiceIdentity(record.speech_flow.identity, identity)))
		&& Array.isArray(record.events) && record.events.length <= 2_048
		&& record.events.every((event, index) => event.sequence === index + 1
			&& !!event.identity && sameVoiceIdentity(event.identity, identity))
		&& typeof record.phase === "string"
		&& Number.isSafeInteger(record.total_speech_bytes) && record.total_speech_bytes >= 0
		&& Number.isSafeInteger(record.total_speech_milliseconds) && record.total_speech_milliseconds >= 0
		&& typeof record.partial_text === "string"
		&& (record.version === 1 || record.final_segments !== undefined)
		&& (record.final_segments === undefined || (Array.isArray(record.final_segments)
			&& record.final_segments.length <= VOICE_LIMITS.clientEvents
			&& record.final_segments.every((segment) => typeof segment === "string"
				&& segment === segment.trim() && Buffer.byteLength(segment) > 0)
			&& Buffer.byteLength(record.final_segments.join(" ")) <= VOICE_LIMITS.textBytes))
		&& (record.final_text === undefined || (typeof record.final_text === "string"
			&& Buffer.byteLength(record.final_text) <= VOICE_LIMITS.textBytes))
		&& typeof record.terminal === "boolean"
		&& (record.version !== 3 || record.timing !== undefined)
		&& Number.isFinite(Date.parse(record.updated_at));
	if (record.voice_receipts !== undefined && !Array.isArray(record.voice_receipts)) return false;
	const receipts = record.voice_receipts ?? [];
	if (!receipts.every((receipt) => isStoredVoiceReceipt(receipt))) return false;
	const receiptKeys = new Set(receipts.map((receipt) => [
		receipt.agent_correlation,
		receipt.request_correlation,
	].join("\n")));
	const validReceipts = receipts.length <= MAXIMUM_VOICE_RECEIPTS_PER_SESSION
		&& receiptKeys.size === receipts.length
		&& receipts.every((receipt) =>
			receipt.session_correlation === voiceReceiptCorrelation(identity.session_id)
				&& receipt.client_sequence <= record.input.highest_client_sequence
				&& receipt.server_sequence <= record.events.length);
	return basic && validReceipts && validStoredEventSequence(record)
		&& validStoredTiming(record);
}

function validStoredTiming(record: StoredVoiceSession): boolean {
	const timing = record.timing ?? [];
	if (record.version === 3 && timing[0]?.stage !== "session_opened") return false;
	const stages = new Set(timing.map((entry) => entry.stage));
	const hasEvent = (kind: VoiceServerEvent["kind"]): boolean =>
		record.events.some((event) => event.kind === kind);
	if (stages.has("input_first_audio_committed") && record.input.total_audio_bytes < 1) return false;
	if (stages.has("recording_last_frame_committed") && !stages.has("recording_custody_accepted")) return false;
	if (stages.has("input_finalized") && !record.input.input_closed) return false;
	if (stages.has("transcription_final") && !hasEvent("transcript_final")) return false;
	if (stages.has("canonical_admitted") && !hasEvent("send_accepted")) return false;
	if (stages.has("canonical_dispatch_started") && !record.canonical_dispatch) return false;
	if (stages.has("assistant_first_output")
		&& !hasEvent("assistant_partial") && !hasEvent("assistant_final")) return false;
	if (stages.has("assistant_final") && !hasEvent("assistant_final")) return false;
	if (stages.has("speech_started") && !hasEvent("assistant_speech_started")) return false;
	if (stages.has("speech_first_segment") && !hasEvent("assistant_speech_segment")) return false;
	if (stages.has("speech_completed") && !hasEvent("assistant_speech_completed")) return false;
	if (stages.has("terminal_persisted") && !record.terminal) return false;
	return true;
}

type ReplayPhase = "start" | "listening" | "speech" | "eou" | "transcript_final" | "accepted" | "assistant_final" | "assistant_speech" | "speech_terminal";
function validStoredEventSequence(record: StoredVoiceSession): boolean {
	const dispatch = record.canonical_dispatch;
	if (dispatch !== undefined) {
		if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)
			|| Object.keys(dispatch).sort().join(",") !== "completion_id,status"
			|| !["admitted","dispatching","completed","failed"].includes(dispatch.status)
			|| !isSafeVoiceIdentifier(dispatch.completion_id)) return false;
	}
	let phase: ReplayPhase = "start";
	let terminal = false;
	let speechSegments = 0;
	let assistantSpeechEligible = false;
	let canonicalOutputStarted = false;
	let completionID: string | undefined;
	let streamID: string | undefined;
	let lastAudioAcknowledgement = 0;
	let lastAudioWindow = 0;
	let lastSpeechServerSequence = 0;
	let speechCancelled = false;
	let speechBytes = 0;
	let speechMilliseconds = 0;
	const segmentIDs: Record<string,string> = {};
	const segmentFingerprints: Record<string,string> = {};
	for (const raw of record.events) {
		let event: VoiceServerEvent;
		try { event = validateVoiceServerEvent(raw, record.open.identity); }
		catch { return false; }
		if (terminal) return false;
		switch (event.kind) {
			case "ready":
				if (phase !== "start") return false;
				lastAudioAcknowledgement = event.acknowledged_client_sequence!;
				lastAudioWindow = event.maximum_in_flight_audio_events!;
				phase = "listening";
				break;
			case "audio_accepted":
				if (phase !== "listening" && phase !== "speech") return false;
				if (event.acknowledged_client_sequence! <= lastAudioAcknowledgement) return false;
				lastAudioAcknowledgement = event.acknowledged_client_sequence!;
				lastAudioWindow = event.maximum_in_flight_audio_events!;
				break;
			case "speech_started": if (phase !== "listening") return false; phase = "speech"; break;
			case "transcript_partial": if (phase !== "speech" && phase !== "eou") return false; break;
			case "end_of_utterance": if (phase !== "speech") return false; phase = "eou"; break;
			case "transcript_final": if (phase !== "eou") return false; phase = "transcript_final"; break;
			case "send_accepted":
				if (phase !== "transcript_final") return false;
				completionID = event.completion_id;
				phase = "accepted";
				break;
			case "assistant_partial":
				if (phase !== "accepted" || event.completion_id !== completionID) return false;
				canonicalOutputStarted = true;
				break;
			case "assistant_final":
				if (phase !== "accepted" || event.completion_id !== completionID) return false;
				assistantSpeechEligible = event.is_speech_eligible === true;
				canonicalOutputStarted = true;
				phase = "assistant_final";
				break;
			case "assistant_speech_started":
				if (phase !== "assistant_final" || !assistantSpeechEligible
					|| record.open.configuration.speech_mode !== "progressive_audio"
					|| event.completion_id !== completionID) return false;
				streamID = event.speech_stream_id;
				phase = "assistant_speech";
				break;
			case "assistant_speech_segment":
				if (phase !== "assistant_speech" || event.completion_id !== completionID
					|| event.speech_stream_id !== streamID || event.speech_segment_sequence !== speechSegments + 1) return false;
				speechSegments++;
				lastSpeechServerSequence = event.sequence;
				speechBytes += Buffer.from(event.speech_audio!, "base64").byteLength;
				speechMilliseconds += event.speech_duration_milliseconds!;
				segmentIDs[String(speechSegments)] = event.speech_segment_id!;
				segmentFingerprints[String(speechSegments)] = voiceFingerprint(event);
				break;
			case "assistant_speech_completed":
				if (phase !== "assistant_speech" || event.completion_id !== completionID
					|| event.speech_stream_id !== streamID || speechSegments < 1
					|| event.final_speech_segment_sequence !== speechSegments) return false;
				phase = "speech_terminal";
				break;
			case "assistant_speech_cancelled":
				if (phase !== "assistant_speech" || event.completion_id !== completionID
					|| event.speech_stream_id !== streamID
					|| event.final_speech_segment_sequence !== speechSegments) return false;
				speechCancelled = true;
				phase = "speech_terminal";
				break;
			case "completed": {
				const completionPhaseValid = phase === "speech_terminal"
					|| (phase === "assistant_final" && (!assistantSpeechEligible
						|| record.open.configuration.speech_mode === "silent"));
				if (event.completion_id !== completionID || !completionPhaseValid) return false;
				terminal = true;
				break;
			}
			case "cancelled":
			case "error": terminal = true; break;
			default: return false;
		}
	}
	const transcriptFinal = record.events.find((event) => event.kind === "transcript_final")?.text;
	if (record.final_text !== transcriptFinal) return false;
	if (record.final_segments !== undefined && transcriptFinal !== undefined
		&& record.final_segments.join(" ") !== transcriptFinal) return false;
	const audioEventCount = record.input.highest_client_sequence - (record.input.closure_reason === "client_terminal" ? 1 : 0);
	const expectedPending: number[] = [];
	for (let sequence = record.input.acknowledged_client_sequence + 1; sequence <= audioEventCount; sequence++) expectedPending.push(sequence);
	if (JSON.stringify(record.input.pending_audio_sequences) !== JSON.stringify(expectedPending)
		|| audioEventCount < 0 || audioEventCount > VOICE_LIMITS.audioEvents
		|| (audioEventCount === 0 && (record.input.total_audio_bytes !== 0 || record.input.total_audio_milliseconds !== 0))
		|| (audioEventCount > 0 && (record.input.total_audio_bytes === 0 || record.input.total_audio_milliseconds === 0))
		|| Math.abs(record.input.total_audio_bytes - record.input.total_audio_milliseconds * 32) > audioEventCount * 32
		|| record.input.acknowledged_client_sequence !== lastAudioAcknowledgement
		|| record.input.maximum_in_flight_audio_events !== lastAudioWindow
		|| record.completion_id !== completionID || record.speech_stream_id !== streamID
		|| record.total_speech_bytes !== speechBytes
		|| record.total_speech_milliseconds !== speechMilliseconds) return false;
	if (streamID) {
		const flow = record.speech_flow;
		if (!flow || flow.completion_id !== completionID || flow.speech_stream_id !== streamID
			|| flow.highest_segment_sequence !== speechSegments
			|| flow.last_server_sequence !== lastSpeechServerSequence
			|| flow.cancelled !== speechCancelled
			|| JSON.stringify(flow.segment_ids) !== JSON.stringify(segmentIDs)
			|| JSON.stringify(flow.segment_fingerprints) !== JSON.stringify(segmentFingerprints)) return false;
	} else if (record.speech_flow) return false;
	if (completionID) {
		if (!record.canonical_dispatch || record.canonical_dispatch.completion_id !== completionID) return false;
		const completedNormally = record.events.at(-1)?.kind === "completed";
		if (record.canonical_dispatch.status === "admitted" && (terminal || phase !== "accepted" || canonicalOutputStarted)) return false;
		if (record.canonical_dispatch.status === "dispatching" && completedNormally) return false;
		if (record.canonical_dispatch.status === "completed" && !completedNormally) return false;
		const terminalEvent = record.events.at(-1);
		if (record.canonical_dispatch.status === "failed" && (!terminal || phase !== "accepted" || canonicalOutputStarted
			|| terminalEvent?.kind !== "error" || terminalEvent.error_code !== "canonical_completion_mismatch" || terminalEvent.retryable !== false)) return false;
	} else if (record.canonical_dispatch) return false;
	const runtimePhase = terminal ? "terminal"
		: phase === "assistant_speech" || phase === "speech_terminal" ? "assistant_final" : phase;
	return phase !== "start" && record.phase === runtimePhase && record.terminal === terminal;
}
