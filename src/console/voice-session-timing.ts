import { createHash } from "node:crypto";

export const VOICE_SESSION_TIMING_VERSION = "computer.voice-timing.v1" as const;
export const VOICE_SESSION_TIMING_MAXIMUM_RECORDS = 16;

export const VOICE_SESSION_TIMING_STAGES = [
	"session_opened",
	"provider_ready",
	"recording_custody_accepted",
	"input_first_audio_committed",
	"recording_last_frame_committed",
	"input_finalized",
	"transcription_final",
	"canonical_admitted",
	"canonical_dispatch_started",
	"assistant_first_output",
	"assistant_final",
	"speech_started",
	"speech_first_segment",
	"speech_completed",
	"terminal_persisted",
] as const;

export type VoiceSessionTimingStage = typeof VOICE_SESSION_TIMING_STAGES[number];

/**
 * One content-free, per-session monotonic boundary. It cannot represent audio,
 * transcript or response text, routes, credentials, provider payloads, or full
 * voice identities.
 */
export interface VoiceSessionTimingRecord {
	version: typeof VOICE_SESSION_TIMING_VERSION;
	stage: VoiceSessionTimingStage;
	ordinal: number;
	elapsed_milliseconds: number;
}

export interface VoiceSessionTimingDiagnostic extends VoiceSessionTimingRecord {
	session_correlation: string;
	runtime_identity: string;
	source_identity: string;
}

export function validateVoiceSessionTiming(
	value: unknown,
): VoiceSessionTimingRecord[] {
	if (!Array.isArray(value) || value.length > VOICE_SESSION_TIMING_MAXIMUM_RECORDS) {
		throw new Error("invalid_voice_timing");
	}
	const accepted: VoiceSessionTimingRecord[] = [];
	const stages = new Set<VoiceSessionTimingStage>();
	let elapsed = -1;
	for (let index = 0; index < value.length; index++) {
		const record = value[index] as Partial<VoiceSessionTimingRecord> | null;
		if (!record || typeof record !== "object" || Array.isArray(record)
			|| Object.keys(record).sort().join(",") !== "elapsed_milliseconds,ordinal,stage,version"
			|| record.version !== VOICE_SESSION_TIMING_VERSION
			|| !VOICE_SESSION_TIMING_STAGES.includes(record.stage as VoiceSessionTimingStage)
			|| record.ordinal !== index + 1
			|| !Number.isSafeInteger(record.elapsed_milliseconds)
			|| (record.elapsed_milliseconds as number) < elapsed
			|| stages.has(record.stage as VoiceSessionTimingStage)) {
			throw new Error("invalid_voice_timing");
		}
		elapsed = record.elapsed_milliseconds as number;
		stages.add(record.stage as VoiceSessionTimingStage);
		accepted.push(record as VoiceSessionTimingRecord);
	}
	return accepted;
}

export function voiceSessionTimingCorrelation(sessionID: string): string {
	return `sha256:${createHash("sha256").update(sessionID).digest("hex").slice(0, 24)}`;
}

export function safeVoiceTimingIdentity(value: string | undefined): string {
	const clean = value?.trim() || "unknown";
	return /^[A-Za-z0-9._:-]{1,128}$/.test(clean) ? clean : "unknown";
}
