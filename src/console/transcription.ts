export const CONSOLE_TRANSCRIPTION_SAMPLE_RATE = 16_000;
export const CONSOLE_TRANSCRIPTION_CHANNELS = 1;
export const CONSOLE_TRANSCRIPTION_MAX_BYTES = 1_920_000;

export interface ConsoleTranscriptionRequest {
	id: string;
	audio: Uint8Array;
	encoding: "linear16";
	sampleRate: typeof CONSOLE_TRANSCRIPTION_SAMPLE_RATE;
	channels: typeof CONSOLE_TRANSCRIPTION_CHANNELS;
}

export interface ConsoleTranscriptionResult {
	text: string;
}

export interface ConsoleTranscriptionService {
	transcribe(request: ConsoleTranscriptionRequest): Promise<ConsoleTranscriptionResult>;
}

export class ConsoleTranscriptionError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export function isSafeTranscriptionId(value: string): boolean {
	return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}
