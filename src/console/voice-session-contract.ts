import { createHash } from "node:crypto";
import type { VoiceSessionTimingRecord } from "./voice-session-timing.js";

export const VOICE_SESSION_VERSION = "computer.voice-session.v1" as const;
export const VOICE_RECORDING_VERSION = "computer.voice-recording.v1" as const;
export const VOICE_REPLAY_VERSION = "computer.voice-replay.v1" as const;
export const VOICE_REPLAY_CACHE_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const VOICE_LIMITS = {
	serverEvents: 2_048,
	clientEvents: 2_048,
	audioEvents: 2_047,
	captureMilliseconds: 60_000,
	captureBytes: 1_920_000,
	audioChunkMilliseconds: 250,
	audioChunkBytes: 8_000,
	inputWindow: 64,
	textBytes: 65_536,
	speechSegments: 512,
	speechSegmentMilliseconds: 1_000,
	speechSegmentBytes: 48_000,
	speechMilliseconds: 120_000,
	speechBytes: 5_760_000,
	speechWindow: 8,
	speechAcknowledgements: 512,
	speechControls: 513,
} as const;

export type VoiceResponsePolicy = "standard" | "concise_watch";
export type VoiceSpeechMode = "silent" | "progressive_audio";
export type VoiceClientEventKind = "audio" | "end_of_utterance" | "cancel";
export type VoiceServerEventKind =
	| "ready" | "audio_accepted" | "speech_started" | "end_of_utterance"
	| "transcript_partial" | "transcript_final" | "send_accepted"
	| "assistant_partial" | "assistant_final" | "assistant_speech_started"
	| "assistant_speech_segment" | "assistant_speech_completed"
	| "assistant_speech_cancelled" | "completed" | "cancelled" | "error";
export type VoiceSpeechControlKind = "audio_accepted" | "cancel";

export interface VoiceIdentity {
	session_id: string;
	capture_id: string;
	delivery_id: string;
	subject_agent_id: string;
}
export interface VoiceConfiguration {
	response_policy: VoiceResponsePolicy;
	speech_mode: VoiceSpeechMode;
}
export interface VoiceRetryOpenAuthorization {
	original_session_id: string;
	authorization_id: string;
	recording_digest: string;
}
export interface VoiceOpen {
	version: typeof VOICE_SESSION_VERSION;
	identity: VoiceIdentity;
	audio: { encoding: "pcm_s16le"; sample_rate: 16_000; channel_count: 1 };
	configuration: VoiceConfiguration;
	resume_after_server_sequence?: number;
	retry_authorization?: VoiceRetryOpenAuthorization;
}
export interface VoiceRecordingUploadRequest {
	version: typeof VOICE_RECORDING_VERSION;
	identity: VoiceIdentity;
	configuration: VoiceConfiguration;
	captured_at: string;
	recording_sha256: string;
	audio: string;
}
export interface VoiceReplayFrameCommitment {
	sequence: number;
	audio_sha256: string;
	event_fingerprint: string;
	byte_count: number;
	duration_milliseconds: number;
}
export interface VoiceReplayReconciliationRequest {
	version: typeof VOICE_REPLAY_VERSION;
	identity: VoiceIdentity;
	configuration: VoiceConfiguration;
	captured_at: string;
	recording_digest: string;
	frames: VoiceReplayFrameCommitment[];
}
export type VoiceCanonicalCustody = "none" | "admitted" | "dispatching" | "completed" | "failed" | "unknown";
export type VoiceReplayDisposition =
	| "resume_original" | "processing" | "completed" | "retry_authorized"
	| "retry_in_progress" | "terminal_without_delivery" | "never_admitted" | "expired" | "unknown";
export interface VoiceReplayInputProjection {
	highest_client_sequence: number;
	acknowledged_client_sequence: number;
	audio_event_count: number;
	input_closed: boolean;
	accepted_event_fingerprints: Array<{ sequence: number; fingerprint: string }>;
}
export interface VoiceReplayAuthorization {
	authorization_id: string;
	original_session_id: string;
	retry_identity: VoiceIdentity;
	recording_digest: string;
	expires_at: string;
}
export interface VoiceReplayReconciliation {
	version: typeof VOICE_REPLAY_VERSION;
	identity: VoiceIdentity;
	configuration: VoiceConfiguration;
	disposition: VoiceReplayDisposition;
	canonical_custody: VoiceCanonicalCustody;
	terminal: boolean;
	input?: VoiceReplayInputProjection;
	poll?: {
		identity: VoiceIdentity;
		configuration: VoiceConfiguration;
		events: VoiceServerEvent[];
		last_server_sequence: number;
		terminal: boolean;
		timing: VoiceSessionTimingRecord[];
	};
	retry_authorization?: VoiceReplayAuthorization;
	error_code?: string;
}
export interface VoiceClientEvent {
	version: typeof VOICE_SESSION_VERSION;
	identity: VoiceIdentity;
	sequence: number;
	kind: VoiceClientEventKind;
	audio?: string;
	duration_milliseconds?: number;
}
export interface VoiceServerEvent {
	version: typeof VOICE_SESSION_VERSION;
	identity: VoiceIdentity;
	sequence: number;
	event_id: string;
	kind: VoiceServerEventKind;
	text?: string;
	completion_id?: string;
	is_speech_eligible?: boolean;
	error_code?: string;
	retryable?: boolean;
	acknowledged_client_sequence?: number;
	maximum_in_flight_audio_events?: number;
	speech_stream_id?: string;
	speech_segment_id?: string;
	speech_segment_sequence?: number;
	speech_audio_format?: { encoding: "pcm_s16le"; sample_rate: 24_000; channel_count: 1 };
	speech_audio?: string;
	speech_duration_milliseconds?: number;
	final_speech_segment_sequence?: number;
}
export interface VoiceSpeechControlEvent {
	version: typeof VOICE_SESSION_VERSION;
	identity: VoiceIdentity;
	sequence: number;
	kind: VoiceSpeechControlKind;
	completion_id: string;
	speech_stream_id: string;
	acknowledged_speech_segment_sequence: number;
}

export class VoiceSessionContractError extends Error {
	constructor(readonly code: string, message = code) { super(message); }
}

export function isSafeVoiceIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
export function isVoiceIdentity(value: unknown): value is VoiceIdentity {
	const record = asRecord(value);
	return Boolean(record)
		&& isSafeVoiceIdentifier(record!.session_id)
		&& isSafeVoiceIdentifier(record!.capture_id)
		&& isSafeVoiceIdentifier(record!.delivery_id)
		&& isSafeVoiceIdentifier(record!.subject_agent_id);
}
export function sameVoiceIdentity(a: VoiceIdentity, b: VoiceIdentity): boolean {
	return a.session_id === b.session_id && a.capture_id === b.capture_id
		&& a.delivery_id === b.delivery_id && a.subject_agent_id === b.subject_agent_id;
}

export function validateVoiceOpen(value: unknown): VoiceOpen {
	const open = asRecord(value);
	if (!open || open.version !== VOICE_SESSION_VERSION || !isVoiceIdentity(open.identity)) fail("invalid_open");
	const audio = asRecord(open.audio);
	const configuration = asRecord(open.configuration);
	if (!audio || audio.encoding !== "pcm_s16le" || audio.sample_rate !== 16_000 || audio.channel_count !== 1) fail("invalid_audio_format");
	if (!configuration || !["standard", "concise_watch"].includes(String(configuration.response_policy))
		|| !["silent", "progressive_audio"].includes(String(configuration.speech_mode))) fail("invalid_configuration");
	if (open.resume_after_server_sequence !== undefined && !boundedInt(open.resume_after_server_sequence, 0, VOICE_LIMITS.serverEvents)) fail("invalid_sequence");
	if (open.retry_authorization !== undefined) {
		const retry = asRecord(open.retry_authorization);
		if (!retry || !isSafeVoiceIdentifier(retry.original_session_id)
			|| !isSafeVoiceIdentifier(retry.authorization_id)
			|| !isSHA256(retry.recording_digest)
			|| (open.resume_after_server_sequence ?? 0) !== 0) fail("invalid_retry_authorization");
	}
	return value as VoiceOpen;
}

export function validateVoiceRecordingUploadRequest(value: unknown): VoiceRecordingUploadRequest {
	const request = asRecord(value);
	const configuration = asRecord(request?.configuration);
	if (!request || request.version !== VOICE_RECORDING_VERSION
		|| !isVoiceIdentity(request.identity) || !configuration
		|| !["standard", "concise_watch"].includes(String(configuration.response_policy))
		|| !["silent", "progressive_audio"].includes(String(configuration.speech_mode))
		|| typeof request.captured_at !== "string" || !Number.isFinite(Date.parse(request.captured_at))
		|| !isSHA256(request.recording_sha256) || typeof request.audio !== "string") {
		fail("invalid_voice_recording");
	}
	const pcm = strictBase64(request.audio as string);
	if (!pcm || pcm.byteLength < 2 || pcm.byteLength > VOICE_LIMITS.captureBytes
		|| pcm.byteLength % 2 !== 0
		|| createHash("sha256").update(pcm).digest("hex") !== request.recording_sha256) {
		fail("invalid_voice_recording");
	}
	return value as VoiceRecordingUploadRequest;
}

export function voiceRecordingReplayRequest(
	request: VoiceRecordingUploadRequest,
): VoiceReplayReconciliationRequest {
	const pcm = strictBase64(request.audio)!;
	const frames: VoiceReplayFrameCommitment[] = [];
	for (let offset = 0, sequence = 1; offset < pcm.byteLength; offset += VOICE_LIMITS.audioChunkBytes, sequence++) {
		const frame = pcm.subarray(offset, Math.min(offset + VOICE_LIMITS.audioChunkBytes, pcm.byteLength));
		const duration = Math.max(1, Math.round(frame.byteLength * 1_000 / (16_000 * 2)));
		const event: VoiceClientEvent = {
			version: VOICE_SESSION_VERSION,
			identity: request.identity,
			sequence,
			kind: "audio",
			audio: frame.toString("base64"),
			duration_milliseconds: duration,
		};
		frames.push({
			sequence,
			audio_sha256: createHash("sha256").update(frame).digest("hex"),
			event_fingerprint: voiceFingerprint(event),
			byte_count: frame.byteLength,
			duration_milliseconds: duration,
		});
	}
	return {
		version: VOICE_REPLAY_VERSION,
		identity: request.identity,
		configuration: request.configuration,
		captured_at: request.captured_at,
		recording_digest: voiceReplayRecordingDigest(frames),
		frames,
	};
}

export function voiceReplayRecordingDigest(frames: VoiceReplayFrameCommitment[]): string {
	return createHash("sha256").update(canonicalJSON(frames.map((frame) => ({
		sequence: frame.sequence,
		audio_sha256: frame.audio_sha256,
		byte_count: frame.byte_count,
		duration_milliseconds: frame.duration_milliseconds,
	})))).digest("hex");
}

export function validateVoiceReplayRequest(value: unknown): VoiceReplayReconciliationRequest {
	const request = asRecord(value);
	if (!request || request.version !== VOICE_REPLAY_VERSION || !isVoiceIdentity(request.identity)) fail("invalid_replay_request");
	const configuration = asRecord(request.configuration);
	if (!configuration || !["standard", "concise_watch"].includes(String(configuration.response_policy))
		|| !["silent", "progressive_audio"].includes(String(configuration.speech_mode))) fail("invalid_configuration");
	if (typeof request.captured_at !== "string" || !Number.isFinite(Date.parse(request.captured_at))
		|| !isSHA256(request.recording_digest) || !Array.isArray(request.frames)
		|| request.frames.length < 1 || request.frames.length > VOICE_LIMITS.audioEvents) fail("invalid_replay_request");
	let totalBytes = 0;
	let totalMilliseconds = 0;
	for (let index = 0; index < request.frames.length; index++) {
		const frame = asRecord(request.frames[index]);
		if (!frame || frame.sequence !== index + 1 || !isSHA256(frame.audio_sha256)
			|| !isSHA256(frame.event_fingerprint)
			|| !boundedInt(frame.byte_count, 2, VOICE_LIMITS.audioChunkBytes)
			|| (frame.byte_count as number) % 2 !== 0
			|| !boundedInt(frame.duration_milliseconds, 1, VOICE_LIMITS.audioChunkMilliseconds)) fail("invalid_replay_commitment");
		const expected = (frame.duration_milliseconds as number) * 16_000 * 2 / 1_000;
		if (Math.abs((frame.byte_count as number) - expected) > 32) fail("invalid_replay_commitment");
		totalBytes += frame.byte_count as number;
		totalMilliseconds += frame.duration_milliseconds as number;
	}
	if (totalBytes > VOICE_LIMITS.captureBytes || totalMilliseconds > VOICE_LIMITS.captureMilliseconds
		|| request.recording_digest !== voiceReplayRecordingDigest(request.frames as VoiceReplayFrameCommitment[])) fail("invalid_replay_commitment");
	return value as VoiceReplayReconciliationRequest;
}

export function validateVoiceClientEvent(value: unknown, identity?: VoiceIdentity): VoiceClientEvent {
	const event = asRecord(value);
	if (!event || event.version !== VOICE_SESSION_VERSION || !isVoiceIdentity(event.identity)) fail("invalid_client_event");
	if (identity && !sameVoiceIdentity(event.identity as VoiceIdentity, identity)) fail("mismatched_identity");
	if (!boundedInt(event.sequence, 1, VOICE_LIMITS.clientEvents)) fail("invalid_sequence");
	if (!(["audio", "end_of_utterance", "cancel"] as unknown[]).includes(event.kind)) fail("invalid_client_event");
	if (event.kind === "audio") {
		if (typeof event.audio !== "string" || !event.audio || !boundedInt(event.duration_milliseconds, 1, VOICE_LIMITS.audioChunkMilliseconds)) fail("invalid_audio");
		const audio = strictBase64(event.audio);
		if (!audio || audio.byteLength > VOICE_LIMITS.audioChunkBytes || audio.byteLength % 2 !== 0) fail("invalid_audio");
		const expected = (event.duration_milliseconds as number) * 16_000 * 2 / 1_000;
		if (Math.abs(audio.byteLength - expected) > 32) fail("invalid_audio");
	} else if (event.audio !== undefined || event.duration_milliseconds !== undefined) fail("invalid_client_event");
	return value as VoiceClientEvent;
}

export function validateSpeechControl(value: unknown, identity?: VoiceIdentity): VoiceSpeechControlEvent {
	const event = asRecord(value);
	if (!event || event.version !== VOICE_SESSION_VERSION || !isVoiceIdentity(event.identity)) fail("invalid_speech_control");
	if (identity && !sameVoiceIdentity(event.identity as VoiceIdentity, identity)) fail("mismatched_identity");
	if (!isSafeVoiceIdentifier(event.completion_id) || !isSafeVoiceIdentifier(event.speech_stream_id)
		|| !boundedInt(event.acknowledged_speech_segment_sequence, 0, VOICE_LIMITS.speechSegments)) fail("invalid_speech_control");
	if (event.kind === "audio_accepted") {
		if (!boundedInt(event.sequence, 1, VOICE_LIMITS.speechAcknowledgements) || (event.acknowledged_speech_segment_sequence as number) < 1) fail("invalid_speech_control");
	} else if (event.kind === "cancel") {
		if (!boundedInt(event.sequence, 1, VOICE_LIMITS.speechControls)) fail("invalid_speech_control");
	} else fail("invalid_speech_control");
	return value as VoiceSpeechControlEvent;
}

export function voiceFingerprint(value: unknown): string {
	return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

export function strictBase64(value: string): Buffer | null {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
	const decoded = Buffer.from(value, "base64");
	return decoded.toString("base64") === value ? decoded : null;
}

function canonicalJSON(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined)
			.sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJSON(child)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function boundedInt(value: unknown, minimum: number, maximum: number): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}
function isSHA256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function fail(code: string): never { throw new VoiceSessionContractError(code); }

export interface VoiceInputCheckpoint {
	identity: VoiceIdentity;
	highest_client_sequence: number;
	acknowledged_client_sequence: number;
	maximum_in_flight_audio_events: number;
	pending_audio_sequences: number[];
	total_audio_bytes: number;
	total_audio_milliseconds: number;
	input_closed: boolean;
	closure_reason?: "client_terminal" | "canonical_admission";
	fingerprints: Record<string, string>;
}

/** Server projection of ordered microphone input. Raw audio is intentionally absent. */
export class VoiceInputLedger {
	readonly identity: VoiceIdentity;
	private fingerprints = new Map<number, string>();
	private pendingAudio = new Set<number>();
	highestClientSequence = 0;
	acknowledgedClientSequence = 0;
	maximumInFlightAudioEvents = 0;
	totalAudioBytes = 0;
	totalAudioMilliseconds = 0;
	inputClosed = false;
	closureReason?: "client_terminal" | "canonical_admission";

	constructor(identity: VoiceIdentity, checkpoint?: VoiceInputCheckpoint) {
		this.identity = identity;
		if (!checkpoint) return;
		if (!sameVoiceIdentity(identity, checkpoint.identity)) fail("mismatched_identity");
		if (!boundedInt(checkpoint.highest_client_sequence, 0, VOICE_LIMITS.clientEvents)
			|| !boundedInt(checkpoint.acknowledged_client_sequence, 0, checkpoint.highest_client_sequence)
			|| !boundedInt(checkpoint.maximum_in_flight_audio_events, 0, VOICE_LIMITS.inputWindow)
			|| !boundedInt(checkpoint.total_audio_bytes, 0, VOICE_LIMITS.captureBytes)
			|| !boundedInt(checkpoint.total_audio_milliseconds, 0, VOICE_LIMITS.captureMilliseconds)
			|| !Array.isArray(checkpoint.pending_audio_sequences)) fail("invalid_checkpoint");
		if (checkpoint.input_closed === true) {
			if (checkpoint.closure_reason !== "client_terminal" && checkpoint.closure_reason !== "canonical_admission") fail("invalid_checkpoint");
		} else if (checkpoint.closure_reason !== undefined) fail("invalid_checkpoint");
		const pending = checkpoint.pending_audio_sequences;
		if (new Set(pending).size !== pending.length || pending.some((sequence) => !boundedInt(sequence, checkpoint.acknowledged_client_sequence + 1, checkpoint.highest_client_sequence))
			|| pending.length > checkpoint.maximum_in_flight_audio_events) fail("invalid_checkpoint");
		const fingerprintEntries = Object.entries(checkpoint.fingerprints ?? {});
		if (fingerprintEntries.length !== checkpoint.highest_client_sequence) fail("invalid_checkpoint");
		for (let sequence = 1; sequence <= checkpoint.highest_client_sequence; sequence++) {
			const fingerprint = checkpoint.fingerprints[String(sequence)];
			if (!/^[a-f0-9]{64}$/.test(fingerprint ?? "")) fail("invalid_checkpoint");
			this.fingerprints.set(sequence, fingerprint);
		}
		this.highestClientSequence = checkpoint.highest_client_sequence;
		this.acknowledgedClientSequence = checkpoint.acknowledged_client_sequence;
		this.maximumInFlightAudioEvents = checkpoint.maximum_in_flight_audio_events;
		this.pendingAudio = new Set(pending);
		this.totalAudioBytes = checkpoint.total_audio_bytes;
		this.totalAudioMilliseconds = checkpoint.total_audio_milliseconds;
		this.inputClosed = checkpoint.input_closed === true;
		this.closureReason = checkpoint.closure_reason;
	}

	get availableAudioSlots(): number { return Math.max(0, this.maximumInFlightAudioEvents - this.pendingAudio.size); }

	assertExactReplay(eventValue: unknown): void {
		const event = validateVoiceClientEvent(eventValue, this.identity);
		if (event.sequence > this.highestClientSequence) fail("event_after_terminal");
		if (this.fingerprints.get(event.sequence) !== voiceFingerprint(event)) fail("replay_mismatch");
	}

	apply(eventValue: unknown): boolean {
		const event = validateVoiceClientEvent(eventValue, this.identity);
		const fingerprint = voiceFingerprint(event);
		if (event.sequence <= this.highestClientSequence) {
			if (this.fingerprints.get(event.sequence) !== fingerprint) fail("replay_mismatch");
			return false;
		}
		if (this.inputClosed) fail("event_after_terminal");
		if (event.sequence !== this.highestClientSequence + 1) fail("sequence_gap");
		if (event.kind === "audio") {
			if (this.highestClientSequence >= VOICE_LIMITS.audioEvents) fail("bounds_exceeded");
			if (this.availableAudioSlots < 1) fail("backpressure_exceeded");
			const audio = strictBase64(event.audio!)!;
			if (audio.byteLength > VOICE_LIMITS.captureBytes - this.totalAudioBytes
				|| event.duration_milliseconds! > VOICE_LIMITS.captureMilliseconds - this.totalAudioMilliseconds) fail("bounds_exceeded");
			this.pendingAudio.add(event.sequence);
			this.totalAudioBytes += audio.byteLength;
			this.totalAudioMilliseconds += event.duration_milliseconds!;
		} else {
			this.inputClosed = true;
			this.closureReason = "client_terminal";
		}
		this.fingerprints.set(event.sequence, fingerprint);
		this.highestClientSequence = event.sequence;
		return true;
	}

	closeForCanonicalAdmission(): void {
		if (!this.inputClosed) { this.inputClosed = true; this.closureReason = "canonical_admission"; }
	}

	acknowledge(sequence: number, window: number): void {
		if (!boundedInt(window, 1, VOICE_LIMITS.inputWindow)) fail("invalid_window");
		if (!boundedInt(sequence, this.acknowledgedClientSequence, this.highestClientSequence)) fail(sequence < this.acknowledgedClientSequence ? "acknowledgement_regression" : "acknowledgement_overshoot");
		const pending = [...this.pendingAudio].filter((candidate) => candidate > sequence);
		if (pending.length > window) fail("backpressure_exceeded");
		this.acknowledgedClientSequence = sequence;
		this.maximumInFlightAudioEvents = window;
		this.pendingAudio = new Set(pending);
	}

	checkpoint(): VoiceInputCheckpoint {
		return {
			identity: this.identity,
			highest_client_sequence: this.highestClientSequence,
			acknowledged_client_sequence: this.acknowledgedClientSequence,
			maximum_in_flight_audio_events: this.maximumInFlightAudioEvents,
			pending_audio_sequences: [...this.pendingAudio].sort((a, b) => a - b),
			total_audio_bytes: this.totalAudioBytes,
			total_audio_milliseconds: this.totalAudioMilliseconds,
			input_closed: this.inputClosed,
			...(this.closureReason ? { closure_reason:this.closureReason } : {}),
			fingerprints: Object.fromEntries([...this.fingerprints].map(([key, value]) => [String(key), value])),
		};
	}
}

export interface VoiceSpeechFlowCheckpoint {
	identity: VoiceIdentity;
	completion_id: string;
	speech_stream_id: string;
	highest_segment_sequence: number;
	last_server_sequence: number;
	acknowledged_segment_sequence: number;
	last_control_sequence: number;
	cancelled: boolean;
	segment_ids: Record<string, string>;
	segment_fingerprints: Record<string, string>;
	control_fingerprints: Record<string, string>;
}

/** Bounded server-side progressive speech outbox projection. Audio is hashed, never checkpointed. */
export class VoiceSpeechFlowLedger {
	private segmentIDs = new Map<number, string>();
	private segmentFingerprints = new Map<number, string>();
	private controlFingerprints = new Map<number, string>();
	highestSegmentSequence = 0;
	lastServerSequence = 0;
	acknowledgedSegmentSequence = 0;
	lastControlSequence = 0;
	cancelled = false;
	constructor(readonly identity: VoiceIdentity, readonly completionID: string, readonly streamID: string, checkpoint?: VoiceSpeechFlowCheckpoint) {
		if (!isSafeVoiceIdentifier(completionID) || !isSafeVoiceIdentifier(streamID)) fail("invalid_speech_identity");
		if (checkpoint) this.restore(checkpoint);
	}
	get availableSegmentSlots(): number { return Math.max(0, VOICE_LIMITS.speechWindow - (this.highestSegmentSequence - this.acknowledgedSegmentSequence)); }
	claim(eventValue: unknown): boolean {
		const event = validateVoiceServerEvent(eventValue, this.identity);
		if (event.kind !== "assistant_speech_segment" || event.completion_id !== this.completionID || event.speech_stream_id !== this.streamID) fail("invalid_speech_segment");
		const sequence = event.speech_segment_sequence!;
		const fingerprint = voiceFingerprint(event);
		if (sequence <= this.highestSegmentSequence) {
			if (this.segmentIDs.get(sequence) !== event.speech_segment_id || this.segmentFingerprints.get(sequence) !== fingerprint) fail("replay_mismatch");
			return false;
		}
		if (this.cancelled) fail("event_after_terminal");
		if (sequence !== this.highestSegmentSequence + 1) fail("sequence_gap");
		if (event.sequence <= this.lastServerSequence) fail("invalid_sequence");
		if ([...this.segmentIDs.values()].includes(event.speech_segment_id!)) fail("duplicate_segment_id");
		if (this.availableSegmentSlots < 1) fail("backpressure_exceeded");
		this.segmentIDs.set(sequence, event.speech_segment_id!);
		this.segmentFingerprints.set(sequence, fingerprint);
		this.highestSegmentSequence = sequence;
		this.lastServerSequence = event.sequence;
		return true;
	}
	assertExactControlReplay(value: unknown): void {
		const event = validateSpeechControl(value, this.identity);
		if (event.completion_id !== this.completionID || event.speech_stream_id !== this.streamID) fail("invalid_speech_control");
		if (event.sequence > this.lastControlSequence) fail("event_after_terminal");
		if (this.controlFingerprints.get(event.sequence) !== voiceFingerprint(event)) fail("replay_mismatch");
	}
	applyControl(value: unknown): boolean {
		const event = validateSpeechControl(value, this.identity);
		if (event.completion_id !== this.completionID || event.speech_stream_id !== this.streamID) fail("invalid_speech_control");
		const fingerprint = voiceFingerprint(event);
		if (event.sequence <= this.lastControlSequence) {
			if (this.controlFingerprints.get(event.sequence) !== fingerprint) fail("replay_mismatch");
			return false;
		}
		if (this.cancelled) fail("event_after_terminal");
		if (event.sequence !== this.lastControlSequence + 1) fail("sequence_gap");
		if (event.kind === "audio_accepted" && event.acknowledged_speech_segment_sequence <= this.acknowledgedSegmentSequence) fail("acknowledgement_regression");
		if (event.kind === "cancel" && event.acknowledged_speech_segment_sequence < this.acknowledgedSegmentSequence) fail("acknowledgement_regression");
		if (event.acknowledged_speech_segment_sequence > this.highestSegmentSequence) fail("acknowledgement_overshoot");
		this.controlFingerprints.set(event.sequence, fingerprint);
		this.lastControlSequence = event.sequence;
		this.acknowledgedSegmentSequence = event.acknowledged_speech_segment_sequence;
		if (event.kind === "cancel") this.cancelled = true;
		return true;
	}
	checkpoint(): VoiceSpeechFlowCheckpoint {
		return {
			identity: this.identity, completion_id: this.completionID, speech_stream_id: this.streamID,
			highest_segment_sequence: this.highestSegmentSequence, last_server_sequence: this.lastServerSequence,
			acknowledged_segment_sequence: this.acknowledgedSegmentSequence, last_control_sequence: this.lastControlSequence,
			cancelled: this.cancelled,
			segment_ids: mapRecord(this.segmentIDs), segment_fingerprints: mapRecord(this.segmentFingerprints),
			control_fingerprints: mapRecord(this.controlFingerprints),
		};
	}
	private restore(checkpoint: VoiceSpeechFlowCheckpoint): void {
		if (!sameVoiceIdentity(this.identity, checkpoint.identity) || checkpoint.completion_id !== this.completionID || checkpoint.speech_stream_id !== this.streamID) fail("invalid_checkpoint");
		if (!boundedInt(checkpoint.highest_segment_sequence, 0, VOICE_LIMITS.speechSegments)
			|| !boundedInt(checkpoint.last_server_sequence, checkpoint.highest_segment_sequence === 0 ? 0 : 1, VOICE_LIMITS.serverEvents)
			|| !boundedInt(checkpoint.acknowledged_segment_sequence, 0, checkpoint.highest_segment_sequence)
			|| checkpoint.highest_segment_sequence - checkpoint.acknowledged_segment_sequence > VOICE_LIMITS.speechWindow
			|| !boundedInt(checkpoint.last_control_sequence, 0, VOICE_LIMITS.speechControls)) fail("invalid_checkpoint");
		this.segmentIDs = restoreMap(checkpoint.segment_ids, checkpoint.highest_segment_sequence, true);
		this.segmentFingerprints = restoreMap(checkpoint.segment_fingerprints, checkpoint.highest_segment_sequence, false);
		this.controlFingerprints = restoreMap(checkpoint.control_fingerprints, checkpoint.last_control_sequence, false);
		if (new Set(this.segmentIDs.values()).size !== this.segmentIDs.size) fail("invalid_checkpoint");
		if (![...this.segmentIDs.values()].every(isSafeVoiceIdentifier) || ![...this.segmentFingerprints.values(), ...this.controlFingerprints.values()].every((value) => /^[a-f0-9]{64}$/.test(value))) fail("invalid_checkpoint");
		if (!checkpoint.cancelled && checkpoint.last_control_sequence > VOICE_LIMITS.speechAcknowledgements) fail("invalid_checkpoint");
		if (checkpoint.last_control_sequence === VOICE_LIMITS.speechControls && !checkpoint.cancelled) fail("invalid_checkpoint");
		this.highestSegmentSequence = checkpoint.highest_segment_sequence;
		this.lastServerSequence = checkpoint.last_server_sequence;
		this.acknowledgedSegmentSequence = checkpoint.acknowledged_segment_sequence;
		this.lastControlSequence = checkpoint.last_control_sequence;
		this.cancelled = checkpoint.cancelled === true;
	}
}

export function validateVoiceServerEvent(value: unknown, identity?: VoiceIdentity): VoiceServerEvent {
	const event = asRecord(value);
	if (!event || event.version !== VOICE_SESSION_VERSION || !isVoiceIdentity(event.identity) || !boundedInt(event.sequence, 1, VOICE_LIMITS.serverEvents) || !isSafeVoiceIdentifier(event.event_id)) fail("invalid_server_event");
	if (identity && !sameVoiceIdentity(event.identity as VoiceIdentity, identity)) fail("mismatched_identity");
	if (!SERVER_KINDS.has(event.kind as VoiceServerEventKind)) fail("invalid_server_event");
	const kind = event.kind as VoiceServerEventKind;
	const allowed = SERVER_FIELDS[kind];
	for (const [key, child] of Object.entries(event)) if (child !== undefined && !BASE_SERVER_FIELDS.has(key) && !allowed.has(key)) fail("invalid_server_event");
	if (["transcript_partial", "transcript_final", "assistant_partial", "assistant_final"].includes(kind)) {
		if (typeof event.text !== "string" || !event.text || Buffer.byteLength(event.text) > VOICE_LIMITS.textBytes) fail("invalid_server_event");
	}
	if (["send_accepted", "assistant_partial", "assistant_final", "assistant_speech_started", "assistant_speech_segment", "assistant_speech_completed", "assistant_speech_cancelled", "completed"].includes(kind)
		&& !isSafeVoiceIdentifier(event.completion_id)) fail("invalid_server_event");
	if (["assistant_partial", "assistant_final"].includes(kind) && typeof event.is_speech_eligible !== "boolean") fail("invalid_server_event");
	if (["ready", "audio_accepted"].includes(kind)) {
		if (!boundedInt(event.acknowledged_client_sequence, 0, VOICE_LIMITS.clientEvents) || !boundedInt(event.maximum_in_flight_audio_events, 1, VOICE_LIMITS.inputWindow)) fail("invalid_server_event");
	}
	if (kind === "error" && (!isSafeVoiceIdentifier(event.error_code) || typeof event.retryable !== "boolean")) fail("invalid_server_event");
	if (kind.startsWith("assistant_speech_")) validateSpeechServerShape(event, kind);
	return value as VoiceServerEvent;
}

const SERVER_KINDS = new Set<VoiceServerEventKind>(["ready","audio_accepted","speech_started","end_of_utterance","transcript_partial","transcript_final","send_accepted","assistant_partial","assistant_final","assistant_speech_started","assistant_speech_segment","assistant_speech_completed","assistant_speech_cancelled","completed","cancelled","error"]);
const BASE_SERVER_FIELDS = new Set(["version","identity","sequence","event_id","kind"]);
const SERVER_FIELDS: Record<VoiceServerEventKind, Set<string>> = {
	ready: new Set(["acknowledged_client_sequence","maximum_in_flight_audio_events"]), audio_accepted: new Set(["acknowledged_client_sequence","maximum_in_flight_audio_events"]),
	speech_started: new Set(), end_of_utterance: new Set(), transcript_partial: new Set(["text"]), transcript_final: new Set(["text"]),
	send_accepted: new Set(["completion_id"]), assistant_partial: new Set(["text","completion_id","is_speech_eligible"]), assistant_final: new Set(["text","completion_id","is_speech_eligible"]),
	assistant_speech_started: new Set(["completion_id","speech_stream_id","speech_audio_format"]), assistant_speech_segment: new Set(["completion_id","speech_stream_id","speech_segment_id","speech_segment_sequence","speech_audio","speech_duration_milliseconds"]),
	assistant_speech_completed: new Set(["completion_id","speech_stream_id","final_speech_segment_sequence"]), assistant_speech_cancelled: new Set(["completion_id","speech_stream_id","final_speech_segment_sequence"]),
	completed: new Set(["completion_id"]), cancelled: new Set(), error: new Set(["error_code","retryable"]),
};
function validateSpeechServerShape(event: Record<string, unknown>, kind: VoiceServerEventKind): void {
	if (!isSafeVoiceIdentifier(event.speech_stream_id)) fail("invalid_server_event");
	if (kind === "assistant_speech_started") {
		const format = asRecord(event.speech_audio_format);
		if (!format || format.encoding !== "pcm_s16le" || format.sample_rate !== 24_000 || format.channel_count !== 1) fail("invalid_server_event");
	} else if (kind === "assistant_speech_segment") {
		if (!isSafeVoiceIdentifier(event.speech_segment_id) || !boundedInt(event.speech_segment_sequence, 1, VOICE_LIMITS.speechSegments)
			|| typeof event.speech_audio !== "string" || !boundedInt(event.speech_duration_milliseconds, 1, VOICE_LIMITS.speechSegmentMilliseconds)) fail("invalid_server_event");
		const audio = strictBase64(event.speech_audio);
		if (!audio || audio.byteLength > VOICE_LIMITS.speechSegmentBytes || audio.byteLength % 2 !== 0) fail("invalid_server_event");
		const expected = (event.speech_duration_milliseconds as number) * 24_000 * 2 / 1_000;
		if (Math.abs(audio.byteLength - expected) > 48) fail("invalid_server_event");
	} else {
		const minimum = kind === "assistant_speech_completed" ? 1 : 0;
		if (!boundedInt(event.final_speech_segment_sequence, minimum, VOICE_LIMITS.speechSegments)) fail("invalid_server_event");
	}
}
function mapRecord(map: Map<number, string>): Record<string, string> { return Object.fromEntries([...map].map(([key, value]) => [String(key), value])); }
function restoreMap(record: Record<string, string>, count: number, safeValues: boolean): Map<number, string> {
	if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== count) fail("invalid_checkpoint");
	const map = new Map<number, string>();
	for (let sequence = 1; sequence <= count; sequence++) {
		const value = record[String(sequence)];
		if (typeof value !== "string" || (safeValues ? !isSafeVoiceIdentifier(value) : !/^[a-f0-9]{64}$/.test(value))) fail("invalid_checkpoint");
		map.set(sequence, value);
	}
	return map;
}
