import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VoiceSpeechProvider } from "../../console/voice-session-runtime.js";
import { textToSpeechStreaming, type TtsConfig } from "../../adapters/voice-tts.js";
import { readProtectedTokenFile } from "../../protected-token-file.js";

const BYTES_PER_MILLISECOND = 48;
const MAX_SEGMENT_BYTES = 48_000;

/** Server-owned progressive PCM speech. Provider identity and credentials never enter the wire contract. */
export class ElevenLabsVoiceSessionSpeechProvider implements VoiceSpeechProvider {
	private cancelled = new Set<string>();
	private controllers = new Map<string, AbortController>();
	constructor(private readonly config: TtsConfig, private readonly streamImplementation = textToSpeechStreaming) {
		if (!config.apiKey.trim() || !config.voiceId.trim()) throw new Error("Voice-session speech configuration is incomplete");
	}
	async stream(input: { identity: { session_id: string }; completionID: string; text: string }, onSegment: (pcm16: Uint8Array, durationMilliseconds: number) => Promise<void>): Promise<void> {
		const key = this.key(input.identity.session_id, input.completionID);
		this.cancelled.delete(key);
		const controller = new AbortController();
		this.controllers.set(key, controller);
		let buffered = Buffer.alloc(0);
		let chain = Promise.resolve();
		try {
			await this.streamImplementation(input.text, { ...this.config, outputFormat: "pcm_24000" }, (encoded) => {
				if (this.cancelled.has(key)) return;
				const bytes = strictBase64(encoded);
				if (!bytes) throw new Error("Speech provider returned invalid audio");
				buffered = Buffer.concat([buffered, bytes]);
				while (buffered.byteLength >= MAX_SEGMENT_BYTES) {
					const segment = buffered.subarray(0, MAX_SEGMENT_BYTES);
					buffered = buffered.subarray(MAX_SEGMENT_BYTES);
					chain = chain.then(() => onSegment(segment, MAX_SEGMENT_BYTES / BYTES_PER_MILLISECOND));
				}
			}, controller.signal, { requireFinal: true, timeoutMs: 125_000 });
			await chain;
			if (!this.cancelled.has(key) && buffered.byteLength > 0) {
				if (buffered.byteLength % 2 !== 0) throw new Error("Speech provider returned unaligned PCM");
				const duration = Math.max(1, Math.round(buffered.byteLength / BYTES_PER_MILLISECOND));
				await onSegment(buffered, duration);
			}
		} finally {
			this.controllers.delete(key);
		}
	}
	cancel(identity:{session_id:string},completionID:string):void {
		const key = this.key(identity.session_id, completionID);
		this.cancelled.add(key);
		this.controllers.get(key)?.abort();
	}
	private key(sessionID:string,completionID:string):string{return `${sessionID}\n${completionID}`;}
}
export function createElevenLabsVoiceSessionSpeechProvider(env:Record<string,string|undefined>):VoiceSpeechProvider|undefined {
	const sagDirectory = join(homedir(), ".config", "sag");
	const keyFile = env.MOM_ELEVENLABS_API_KEY_FILE || join(sagDirectory, "elevenlabs-api-key");
	const voiceFile = env.MOM_ELEVENLABS_VOICE_ID_FILE || join(sagDirectory, "voice-id");
	const key = env.MOM_ELEVENLABS_API_KEY?.trim() || readOptionalProtectedFile(keyFile);
	const voice = env.MOM_ELEVENLABS_VOICE_ID?.trim() || readOptionalProtectedFile(voiceFile);
	return key && voice
		? new ElevenLabsVoiceSessionSpeechProvider({ apiKey:key, voiceId:voice, modelId:env.MOM_ELEVENLABS_MODEL_ID })
		: undefined;
}
function readOptionalProtectedFile(path:string):string|undefined{return existsSync(path)?readProtectedTokenFile(path):undefined;}
function strictBase64(value:string):Buffer|null{if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))return null;const bytes=Buffer.from(value,"base64");return bytes.toString("base64")===value?bytes:null;}
