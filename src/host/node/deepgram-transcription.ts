import { readProtectedTokenFile } from "../../protected-token-file.js";
import { readProtectedPlistString } from "./protected-plist-string.js";
import {
	ConsoleTranscriptionError,
	type ConsoleTranscriptionRequest,
	type ConsoleTranscriptionResult,
	type ConsoleTranscriptionService,
} from "../../console/transcription.js";

type FetchImplementation = typeof fetch;

interface DeepgramResponse {
	results?: {
		channels?: Array<{
			alternatives?: Array<{ transcript?: unknown }>;
		}>;
	};
}

export class DeepgramConsoleTranscriptionService implements ConsoleTranscriptionService {
	constructor(
		private readonly apiKey: string,
		private readonly fetchImplementation: FetchImplementation = fetch,
		private readonly timeoutMs = 30_000,
	) {
		if (!apiKey.trim()) throw new Error("Deepgram transcription key is empty");
	}

	async transcribe(request: ConsoleTranscriptionRequest): Promise<ConsoleTranscriptionResult> {
		const url = new URL("https://api.deepgram.com/v1/listen");
		url.searchParams.set("model", "nova-3");
		url.searchParams.set("punctuate", "true");
		url.searchParams.set("smart_format", "true");
		url.searchParams.set("encoding", request.encoding);
		url.searchParams.set("sample_rate", String(request.sampleRate));
		url.searchParams.set("channels", String(request.channels));

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			let response: Response;
			try {
				response = await this.fetchImplementation(url, {
					method: "POST",
					headers: {
						Authorization: `Token ${this.apiKey}`,
						"Content-Type": "audio/l16",
					},
					body: Buffer.from(request.audio),
					signal: controller.signal,
				});
			} catch (error) {
				if (controller.signal.aborted) {
					throw new ConsoleTranscriptionError(504, "transcription_timeout", "Transcription timed out");
				}
				throw new ConsoleTranscriptionError(502, "transcription_provider_unavailable", "Transcription provider unavailable");
			}

			if (!response.ok) {
				if (response.status === 429) {
					throw new ConsoleTranscriptionError(429, "transcription_rate_limited", "Transcription is temporarily rate limited");
				}
				throw new ConsoleTranscriptionError(502, "transcription_provider_failed", "Transcription provider failed");
			}

			const length = Number.parseInt(response.headers.get("content-length") || "0", 10);
			if (Number.isFinite(length) && length > 1_048_576) {
				throw new ConsoleTranscriptionError(502, "transcription_invalid_response", "Transcription provider returned an invalid response");
			}
			let payload: DeepgramResponse;
			try {
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.byteLength > 1_048_576) throw new Error("response too large");
				payload = JSON.parse(new TextDecoder().decode(bytes)) as DeepgramResponse;
			} catch {
				throw new ConsoleTranscriptionError(502, "transcription_invalid_response", "Transcription provider returned an invalid response");
			}
			const raw = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript;
			const text = typeof raw === "string" ? raw.trim() : "";
			if (!text) {
				throw new ConsoleTranscriptionError(422, "no_speech_detected", "No speech was detected");
			}
			return { text };
		} finally {
			clearTimeout(timeout);
		}
	}
}

export function createDeepgramConsoleTranscriptionService(
	env: Record<string, string | undefined>,
	fetchImplementation: FetchImplementation = fetch,
	plistReader = readProtectedPlistString,
): ConsoleTranscriptionService | undefined {
	const apiKey = env.MOM_DEEPGRAM_API_KEY?.trim()
		|| readProtectedTokenFile(env.MOM_DEEPGRAM_API_KEY_FILE)
		|| plistReader(
			env.MOM_DEEPGRAM_API_KEY_PLIST_FILE,
			env.MOM_DEEPGRAM_API_KEY_PLIST_KEY,
		);
	return apiKey ? new DeepgramConsoleTranscriptionService(apiKey, fetchImplementation) : undefined;
}
