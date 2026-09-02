import { createHash, randomUUID } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket from "ws";
import { VOICE_LIMITS, type VoiceIdentity } from "../../console/voice-session-contract.js";
import { ConsoleTranscriptionError } from "../../console/transcription.js";
import type { VoiceTranscriptionCallbacks, VoiceTranscriptionProvider, VoiceTranscriptionSession } from "../../console/voice-session-runtime.js";
import { DeepgramConsoleTranscriptionService, readDeepgramConsoleAPIKey } from "./deepgram-transcription.js";

export interface RealtimeSocket {
	readonly readyState: number;
	on(event: "open", listener: () => void): this;
	on(event: "message", listener: (data: WebSocket.RawData) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: (code: number, reason: Buffer) => void): this;
	on(event: "unexpected-response", listener: (request: ClientRequest, response: IncomingMessage) => void): this;
	send(data: string | Buffer): void;
	close(): void;
}
export type RealtimeSocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

export interface VoiceProviderTimerScheduler {
	interval(callback: () => void, milliseconds: number): () => void;
	timeout(callback: () => void, milliseconds: number): () => void;
}

export interface VoiceProviderHandshakeDiagnostic {
	provider: "deepgram";
	outcome: "accepted" | "rejected" | "transport_error" | "closed_before_ready" | "closed_after_ready" | "first_audio_timeout" | "timeout";
	http_status?: number;
	close_code?: number;
	response_category: string;
	response_excerpt?: string;
	request_correlation: string;
	session_correlation: string;
	runtime_identity: string;
	source_identity: string;
}

export interface DeepgramVoiceSessionOptions {
	onHandshakeDiagnostic?: (diagnostic: VoiceProviderHandshakeDiagnostic) => void;
	runtimeIdentity?: string;
	sourceIdentity?: string;
	requestID?: () => string;
	timerScheduler?: VoiceProviderTimerScheduler;
	batchFetchImplementation?: typeof fetch;
	batchTimeoutMilliseconds?: number;
}

const HANDSHAKE_RESPONSE_BYTES = 2_048;
const HANDSHAKE_EXCERPT_CHARACTERS = 512;
const PRE_AUDIO_KEEPALIVE_MILLISECONDS = 4_000;
const FIRST_AUDIO_TIMEOUT_MILLISECONDS = VOICE_LIMITS.captureMilliseconds;
export const DEEPGRAM_THOUGHT_CONTINUATION_MILLISECONDS = Object.freeze({
	segmentFinal: 1_800,
	speechFinal: 1_400,
	utteranceEnd: 900,
});

/** Server-owned Deepgram realtime STT. No credential or provider URL reaches the device. */
export class DeepgramVoiceTranscriptionProvider implements VoiceTranscriptionProvider {
	constructor(
		private readonly apiKey: string,
		private readonly socketFactory: RealtimeSocketFactory = defaultSocketFactory,
		private readonly options: DeepgramVoiceSessionOptions = {},
	) {
		if (!apiKey.trim()) throw new Error("Deepgram transcription key is empty");
	}

	openRecording(
		identity: VoiceIdentity,
		callbacks: VoiceTranscriptionCallbacks,
	): VoiceTranscriptionSession {
		const service = new DeepgramConsoleTranscriptionService(
			this.apiKey,
			this.options.batchFetchImplementation ?? fetch,
			this.options.batchTimeoutMilliseconds ?? 30_000,
		);
		const controller = new AbortController();
		let chunks: Buffer[] = [];
		let totalBytes = 0;
		let finishRequested = false;
		let closed = false;
		const fail = (code: string, retryable: boolean) => {
			if (closed) return;
			closed = true;
			chunks = [];
			totalBytes = 0;
			callbacks.error(code, retryable);
		};
		return {
			append: (bytes) => {
				if (closed || finishRequested || bytes.byteLength === 0) return;
				if (totalBytes + bytes.byteLength > VOICE_LIMITS.captureBytes) {
					fail("transcription_buffer_exceeded", false);
					return;
				}
				const copy = Buffer.from(bytes);
				chunks.push(copy);
				totalBytes += copy.byteLength;
			},
			finish: () => {
				if (closed || finishRequested) return;
				finishRequested = true;
				if (totalBytes === 0) {
					fail("no_speech_detected", false);
					return;
				}
				const audio = Buffer.concat(chunks, totalBytes);
				chunks = [];
				totalBytes = 0;
				void service.transcribe({
					id: `recording-${hashCorrelation(identity.session_id)}`,
					audio,
					encoding: "linear16",
					sampleRate: 16_000,
					channels: 1,
					signal: controller.signal,
				}).then(({ text }) => {
					if (closed) return;
					closed = true;
					callbacks.ready?.();
					callbacks.speechStarted();
					callbacks.segmentFinal(text);
					callbacks.thoughtCommitted(text);
				}).catch((error: unknown) => {
					if (closed) return;
					if (error instanceof ConsoleTranscriptionError) {
						const retryable = !["no_speech_detected", "transcription_invalid_response"]
							.includes(error.code);
						fail(error.code, retryable);
						return;
					}
					fail("transcription_provider_unavailable", true);
				});
			},
			cancel: () => {
				closed = true;
				chunks = [];
				totalBytes = 0;
				controller.abort();
			},
		};
	}

	open(identity: VoiceIdentity, callbacks: VoiceTranscriptionCallbacks): VoiceTranscriptionSession {
		const url = new URL("wss://api.deepgram.com/v1/listen");
		for (const [key,value] of Object.entries({ model:"nova-3",encoding:"linear16",sample_rate:"16000",channels:"1",interim_results:"true",vad_events:"true",endpointing:"800",utterance_end_ms:"1000",punctuate:"true",smart_format:"true" })) url.searchParams.set(key,value);
		const socket = this.socketFactory(url.toString(), { Authorization:`Token ${this.apiKey}` });
		const requestCorrelation = safeCorrelation(this.options.requestID?.() || `request-${randomUUID()}`);
		const diagnosticBase = {
			provider: "deepgram" as const,
			request_correlation: requestCorrelation,
			session_correlation: hashCorrelation(identity.session_id),
			runtime_identity: safeIdentity(this.options.runtimeIdentity),
			source_identity: safeIdentity(this.options.sourceIdentity),
		};
		let handshakeFinalized=false;
		const observe=(diagnostic:Omit<VoiceProviderHandshakeDiagnostic,keyof typeof diagnosticBase>)=>{
			try { this.options.onHandshakeDiagnostic?.({ ...diagnosticBase, ...diagnostic }); }
			catch { /* diagnostics must never change provider or session behavior */ }
		};
		const timerScheduler=this.options.timerScheduler??defaultTimerScheduler;
		const pending: Buffer[] = [];
		const finalSegments: string[] = [];
		const finalResults = new Map<string, string>();
		let pendingBytes = 0;
		let open = false;
		let closed = false;
		let finishRequested = false;
		let audioStarted = false;
		let speechStarted = false;
		let thoughtCommitted = false;
		let unresolvedSpeech = false;
		let continuationPending: "commit" | "unresolved" | undefined;
		let continuationGeneration = 0;
		let finishTimeout: ReturnType<typeof setTimeout> | undefined;
		let cancelKeepAlive: (() => void) | undefined;
		let cancelFirstAudioTimeout: (() => void) | undefined;
		let cancelContinuation: (() => void) | undefined;
		const connectTimeout=setTimeout(()=>{if(!handshakeFinalized){handshakeFinalized=true;observe({outcome:"timeout",response_category:"connect_timeout"});}fail("transcription_provider_unavailable",true);},15_000);
		const clearPreAudioTimers=()=>{cancelKeepAlive?.();cancelKeepAlive=undefined;cancelFirstAudioTimeout?.();cancelFirstAudioTimeout=undefined;};
		const clearContinuation = () => {
			continuationGeneration++;
			cancelContinuation?.();
			cancelContinuation = undefined;
			continuationPending = undefined;
		};
		const clearTimers = () => {
			clearTimeout(connectTimeout);
			if (finishTimeout) clearTimeout(finishTimeout);
			clearPreAudioTimers();
			clearContinuation();
		};
		const closeSocket=()=>{try{socket.close();}catch{/* best-effort transport cleanup */}};
		const fail=(code:string,retryable:boolean)=>{if(closed)return;closed=true;pending.length=0;pendingBytes=0;clearTimers();callbacks.error(code,retryable);closeSocket();};
		const send=(data:string|Buffer):boolean=>{try{socket.send(data);return true;}catch{fail("transcription_provider_unavailable",true);return false;}};
		const armPreAudioLifecycle=()=>{
			if(closed||finishRequested||audioStarted||cancelKeepAlive||cancelFirstAudioTimeout)return;
			cancelKeepAlive=timerScheduler.interval(()=>{
				if(!closed&&open&&!finishRequested&&!audioStarted)send(JSON.stringify({type:"KeepAlive"}));
			},PRE_AUDIO_KEEPALIVE_MILLISECONDS);
			cancelFirstAudioTimeout=timerScheduler.timeout(()=>{
				if(closed||finishRequested||audioStarted)return;
				observe({outcome:"first_audio_timeout",response_category:"first_audio_timeout"});
				fail("transcription_provider_timeout",true);
			},FIRST_AUDIO_TIMEOUT_MILLISECONDS);
		};
		const markAudioStarted=()=>{if(audioStarted)return;audioStarted=true;clearPreAudioTimers();};
		const cumulativeFinalText = () => finalSegments.join(" ").trim();
		const emitThoughtCommitted = () => {
			if (thoughtCommitted || unresolvedSpeech) return;
			const clean = cumulativeFinalText();
			if (!clean) return fail("no_speech_detected", false);
			thoughtCommitted = true;
			clearTimers();
			callbacks.thoughtCommitted(clean);
			closeSocket();
		};
		const markSpeechResumed = () => {
			const retractedCommit = continuationPending === "commit";
			if (continuationPending) clearContinuation();
			unresolvedSpeech = true;
			if (retractedCommit) callbacks.speechResumed();
		};
		const scheduleThoughtCommit = (milliseconds: number) => {
			if (closed || finishRequested || thoughtCommitted || unresolvedSpeech || !cumulativeFinalText()) return;
			clearContinuation();
			continuationPending = "commit";
			const generation = continuationGeneration;
			cancelContinuation = timerScheduler.timeout(() => {
				if (continuationPending !== "commit" || generation !== continuationGeneration) return;
				cancelContinuation = undefined;
				continuationPending = undefined;
				emitThoughtCommitted();
			}, milliseconds);
		};
		const scheduleUnresolvedFailure = (milliseconds: number) => {
			if (closed || finishRequested || thoughtCommitted || !unresolvedSpeech) return;
			clearContinuation();
			continuationPending = "unresolved";
			const generation = continuationGeneration;
			cancelContinuation = timerScheduler.timeout(() => {
				if (continuationPending !== "unresolved" || generation !== continuationGeneration || !unresolvedSpeech) return;
				cancelContinuation = undefined;
				continuationPending = undefined;
				fail("transcription_provider_timeout", true);
			}, milliseconds);
		};
		socket.on("open",()=>{if(closed){pending.length=0;pendingBytes=0;closeSocket();return;}clearTimeout(connectTimeout);if(!handshakeFinalized){handshakeFinalized=true;observe({outcome:"accepted",http_status:101,response_category:"switching_protocols"});}open=true;callbacks.ready?.();for(const chunk of pending){if(!send(chunk))return;}pending.length=0;pendingBytes=0;if(finishRequested)send(JSON.stringify({type:"Finalize"}));else armPreAudioLifecycle();});
		socket.on("message", (raw) => {
			if (closed) return;
			let event: Record<string, unknown>;
			try { event = JSON.parse(rawDataString(raw)) as Record<string, unknown>; }
			catch { return fail("transcription_invalid_response", false); }
			const type = String(event.type || "");
			if (type === "SpeechStarted") {
				if (!speechStarted) {
					speechStarted = true;
					unresolvedSpeech = true;
					callbacks.speechStarted();
				} else {
					markSpeechResumed();
				}
				return;
			}
			if (type === "UtteranceEnd") {
				if (unresolvedSpeech) scheduleUnresolvedFailure(DEEPGRAM_THOUGHT_CONTINUATION_MILLISECONDS.segmentFinal);
				else scheduleThoughtCommit(DEEPGRAM_THOUGHT_CONTINUATION_MILLISECONDS.utteranceEnd);
				return;
			}
			if (type === "Error") return fail("transcription_provider_failed", true);
			if (type !== "Results") return;

			const channel = asRecord(event.channel);
			const alternatives = Array.isArray(channel?.alternatives) ? channel!.alternatives : [];
			const alternative = asRecord(alternatives[0]);
			const fragment = typeof alternative?.transcript === "string"
				? alternative.transcript.trim() : "";
			const isFinal = event.is_final === true;
			const speechFinal = event.speech_final === true;
			if (fragment && isFinal) {
				const coordinate = providerFinalSegmentCoordinate(event);
				if (!coordinate) return fail("transcription_invalid_response", false);
				const priorTranscript = finalResults.get(coordinate);
				if (priorTranscript !== undefined) {
					if (priorTranscript !== fragment) return fail("transcription_invalid_response", false);
					// Exact replay cannot append text or establish/extend a deadline.
					// Finalize may consume it only when no newer speech is unresolved.
					if (finishRequested && !unresolvedSpeech) emitThoughtCommitted();
					return;
				}
				if (finalResults.size >= VOICE_LIMITS.serverEvents) return fail("transcription_invalid_response", false);
				markSpeechResumed();
				finalResults.set(coordinate, fragment);
				finalSegments.push(fragment);
				unresolvedSpeech = false;
				callbacks.segmentFinal(fragment);
			} else if (fragment) {
				// Interim resumed speech retracts the prior thought deadline. It is
				// visible preview only and cannot establish a new commit deadline.
				markSpeechResumed();
			}
			const cumulative = [
				...finalSegments,
				...(!isFinal && fragment ? [fragment] : []),
			].join(" ").trim();
			if (cumulative) callbacks.partial(cumulative);

			if (isFinal && unresolvedSpeech) {
				if (!finishRequested) scheduleUnresolvedFailure(DEEPGRAM_THOUGHT_CONTINUATION_MILLISECONDS.segmentFinal);
				return;
			}
			if (finishRequested && isFinal) {
				emitThoughtCommitted();
			} else if (speechFinal && isFinal) {
				scheduleThoughtCommit(DEEPGRAM_THOUGHT_CONTINUATION_MILLISECONDS.speechFinal);
			} else if (isFinal) {
				scheduleThoughtCommit(DEEPGRAM_THOUGHT_CONTINUATION_MILLISECONDS.segmentFinal);
			}
		});
		socket.on("unexpected-response",(_request,response)=>{
			if(handshakeFinalized)return;
			handshakeFinalized=true;
			observeRejectedHandshake(response,diagnosticBase,this.options.onHandshakeDiagnostic);
			fail("transcription_provider_unavailable",true);
		});
		socket.on("error",(error)=>{if(!handshakeFinalized){handshakeFinalized=true;const status=httpStatusFromError(error);observe({outcome:"transport_error",...(status?{http_status:status}:{}),response_category:status?`http_${status}`:"transport_error",response_excerpt:sanitizeHandshakeExcerpt(error.message)});}fail("transcription_provider_unavailable",true);});
		socket.on("close",(code,reason)=>{if(!closed&&!thoughtCommitted){if(!handshakeFinalized){handshakeFinalized=true;observe({outcome:"closed_before_ready",response_category:"closed_before_ready"});}else{const excerpt=sanitizeHandshakeExcerpt(reason?.toString("utf8")||"");observe({outcome:"closed_after_ready",...(Number.isSafeInteger(code)?{close_code:code}:{}),response_category:providerCloseCategory(code,excerpt),...(excerpt?{response_excerpt:excerpt}:{})});}return fail("transcription_provider_unavailable",true);}clearTimers();closed=true;});
		return {
			append(bytes){if(closed||finishRequested)return;const chunk=Buffer.from(bytes);if(chunk.byteLength===0)return;markAudioStarted();if(open){send(chunk);return;}if(pendingBytes+chunk.byteLength>VOICE_LIMITS.captureBytes)return fail("transcription_buffer_exceeded",false);pending.push(chunk);pendingBytes+=chunk.byteLength;},
			finish(){if(closed||finishRequested)return;finishRequested=true;clearPreAudioTimers();clearContinuation();finishTimeout=setTimeout(()=>fail("transcription_provider_timeout",true),30_000);if(open)send(JSON.stringify({type:"Finalize"}));},
			cancel(){if(closed)return;closed=true;pending.length=0;pendingBytes=0;clearTimers();if(open){try{socket.send(JSON.stringify({type:"CloseStream"}));}catch{/* best-effort transport cleanup */}}closeSocket();},
		};
	}
}

export function createDeepgramVoiceTranscriptionProvider(
	env:Record<string,string|undefined>,
	options:DeepgramVoiceSessionOptions={},
):VoiceTranscriptionProvider|undefined {
	const key=readDeepgramConsoleAPIKey(env); return key?new DeepgramVoiceTranscriptionProvider(key,defaultSocketFactory,options):undefined;
}
function defaultSocketFactory(url:string,headers:Record<string,string>):RealtimeSocket{return new WebSocket(url,{headers});}
const defaultTimerScheduler:VoiceProviderTimerScheduler={
	interval(callback,milliseconds){const timer=setInterval(callback,milliseconds);timer.unref();return()=>clearInterval(timer);},
	timeout(callback,milliseconds){const timer=setTimeout(callback,milliseconds);timer.unref();return()=>clearTimeout(timer);},
};
function rawDataString(data:WebSocket.RawData):string{if(typeof data==="string")return data;if(data instanceof Buffer)return data.toString("utf8");if(Array.isArray(data))return Buffer.concat(data).toString("utf8");return Buffer.from(data as ArrayBuffer).toString("utf8");}
function asRecord(value:unknown):Record<string,unknown>|null{return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;}
function providerFinalSegmentCoordinate(event:Record<string,unknown>):string|undefined{
	const start=event.start;const duration=event.duration;const channelIndex=event.channel_index;
	if(typeof start!=="number"||!Number.isFinite(start)||start<0||typeof duration!=="number"||!Number.isFinite(duration)||duration<0)return undefined;
	if(!Array.isArray(channelIndex)||channelIndex.length===0||channelIndex.some((value)=>!Number.isSafeInteger(value)))return undefined;
	return createHash("sha256").update(JSON.stringify({start,duration,channel_index:channelIndex})).digest("hex");
}

function observeRejectedHandshake(
	response: IncomingMessage,
	base: Omit<VoiceProviderHandshakeDiagnostic,"outcome"|"http_status"|"response_category"|"response_excerpt">,
	observer: DeepgramVoiceSessionOptions["onHandshakeDiagnostic"],
): void {
	const status=response.statusCode;
	let captured=Buffer.alloc(0);let finished=false;
	const complete=()=>{
		if(finished)return;finished=true;
		const raw=captured.toString("utf8");
		const excerpt=sanitizeHandshakeExcerpt(raw);
		const diagnostic:VoiceProviderHandshakeDiagnostic={
			...base,outcome:"rejected",...(status?{http_status:status}:{}),
			response_category:handshakeCategory(raw,status,response.statusMessage),
			...(excerpt?{response_excerpt:excerpt}:{}),
		};
		try{observer?.(diagnostic);}catch{/* diagnostics must never change provider behavior */}
	};
	response.on("data",(chunk:Buffer|string)=>{
		if(captured.byteLength>=HANDSHAKE_RESPONSE_BYTES)return;
		const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
		captured=Buffer.concat([captured,bytes.subarray(0,HANDSHAKE_RESPONSE_BYTES-captured.byteLength)]);
	});
	response.on("end",complete);
	response.on("error",complete);
	response.on("aborted",complete);
	const timeout=setTimeout(complete,1_000);timeout.unref();
}

function handshakeCategory(excerpt:string,status?:number,statusMessage?:string):string {
	try {
		const value=JSON.parse(excerpt) as Record<string,unknown>;
		for(const key of ["err_code","error_code","code","category","type"]){
			const candidate=safeCategory(value[key]);if(candidate)return candidate;
		}
	}catch{/* non-JSON responses use the safe status fallback */}
	return safeCategory(statusMessage)|| (status?`http_${status}`:"rejected");
}
function safeCategory(value:unknown):string|undefined{const text=typeof value==="string"?value.trim():"";return /^[A-Za-z0-9_.:-]{1,64}$/.test(text)?text:undefined;}
function providerCloseCategory(code:number|undefined,excerpt:string):string{const providerCode=excerpt.match(/\b(?:NET|DATA)-\d{4}\b/i)?.[0].toUpperCase();return providerCode||((Number.isSafeInteger(code)&&code)?`websocket_${code}`:"closed_after_ready");}
function safeCorrelation(value:string):string{return /^[A-Za-z0-9_.:-]{1,96}$/.test(value)?value:hashCorrelation(value);}
function hashCorrelation(value:string):string{return `sha256:${createHash("sha256").update(value).digest("hex").slice(0,24)}`;}
function safeIdentity(value:string|undefined):string{const text=value?.trim()||"unknown";return /^[A-Za-z0-9_.:-]{1,128}$/.test(text)?text:"unknown";}
function httpStatusFromError(error:Error):number|undefined{const match=error.message.match(/(?:response|status)(?::|\s)+(\d{3})\b/i);const value=match?Number(match[1]):0;return value>=100&&value<=599?value:undefined;}
function sanitizeHandshakeExcerpt(value:string):string {
	return value
		.replace(/[\u0000-\u001f\u007f]+/g," ")
		.replace(/\b(?:Bearer|Token)\s+[^\s,;"']+/gi,"[redacted-authorization]")
		.replace(/\b(?:api[_-]?key|authorization|token|secret)\b\s*[:=]\s*["']?[^\s,;"'}]+/gi,"$1=[redacted]")
		.replace(/https?:\/\/\S+/gi,"[redacted-url]")
		.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,"[redacted-email]")
		.replace(/\b[A-Za-z0-9_+\/=.-]{32,}\b/g,"[redacted-value]")
		.replace(/\s+/g," ")
		.trim()
		.slice(0,HANDSHAKE_EXCERPT_CHARACTERS);
}
