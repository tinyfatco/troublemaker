import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	VOICE_LIMITS, VOICE_REPLAY_CACHE_TTL_MILLISECONDS, VOICE_REPLAY_VERSION,
	VOICE_SESSION_VERSION, VoiceInputLedger, VoiceSessionContractError,
	VoiceSpeechFlowLedger, isSafeVoiceIdentifier, sameVoiceIdentity, strictBase64,
	validateSpeechControl, validateVoiceClientEvent, validateVoiceOpen,
	validateVoiceRecordingUploadRequest, validateVoiceReplayRequest, validateVoiceServerEvent,
	voiceRecordingReplayRequest,
	type VoiceCanonicalCustody, type VoiceConfiguration, type VoiceIdentity, type VoiceOpen,
	type VoiceRecordingUploadRequest, type VoiceReplayAuthorization, type VoiceReplayFrameCommitment,
	type VoiceReplayInputProjection, type VoiceReplayReconciliation,
	type VoiceReplayReconciliationRequest,
	type VoiceServerEvent, type VoiceSpeechControlEvent,
} from "./voice-session-contract.js";
import {
	canonicalCustody, type VoiceReplayAuthorizationRecord, type VoiceReplayTombstone,
} from "./voice-session-replay.js";
import { VOICE_SESSION_PERSISTED_TEXT_BYTES, VoiceSessionDurabilityUncertainError, VoiceSessionStore, type StoredVoiceSession } from "./voice-session-store.js";
import {
	VOICE_SESSION_TIMING_MAXIMUM_RECORDS,
	VOICE_SESSION_TIMING_VERSION,
	safeVoiceTimingIdentity,
	validateVoiceSessionTiming,
	voiceSessionTimingCorrelation,
	type VoiceSessionTimingDiagnostic,
	type VoiceSessionTimingRecord,
	type VoiceSessionTimingStage,
} from "./voice-session-timing.js";
import {
	MAXIMUM_VOICE_RECEIPTS_PER_SESSION,
	VOICE_RECEIPT_RETENTION_MS,
	createStoredVoiceReceipt,
	isVoiceReceiptClaim,
	isVoiceReceiptLookup,
	pruneVoiceReceipts,
	publicVoiceReceipt,
	sameVoiceReceiptKey,
	type StoredVoiceReceipt,
	type VoiceReceiptClaim,
	type VoiceReceiptEvidence,
	type VoiceReceiptLookup,
} from "./voice-receipts.js";

export interface VoiceTranscriptionCallbacks {
	ready?(): void;
	speechStarted(): void;
	speechResumed(): void;
	partial(cumulativeText: string): void;
	segmentFinal(segmentText: string): void;
	thoughtCommitted(cumulativeText: string): void;
	error(code: string, retryable: boolean): void;
}
export interface VoiceTranscriptionSession {
	append(pcm16: Uint8Array): void;
	finish(): void;
	cancel(): void;
}
export interface VoiceTranscriptionProvider {
	open(identity: VoiceIdentity, callbacks: VoiceTranscriptionCallbacks): VoiceTranscriptionSession;
	/**
	 * Optional bounded prerecorded path for an already-complete immutable capture.
	 * Live foreground audio always uses `open`; complete-recording ingestion uses
	 * this path only when the provider explicitly implements it.
	 */
	openRecording?(
		identity: VoiceIdentity,
		callbacks: VoiceTranscriptionCallbacks,
	): VoiceTranscriptionSession;
}
export interface VoiceCanonicalReply {
	partials: AsyncIterable<{ text: string; speechEligible: boolean }>;
	final: Promise<{ text: string; speechEligible: boolean }>;
}
export interface VoiceCanonicalPrepared {
	completionID: string;
	dispatch(): Promise<VoiceCanonicalReply>;
}
export interface VoiceCanonicalSubmitter {
	prepare(input: {
		identity: VoiceIdentity;
		text: string;
		responsePolicy: VoiceConfiguration["response_policy"];
		relationshipId?: string;
	}): Promise<VoiceCanonicalPrepared>;
}
export interface VoiceSpeechProvider {
	stream(input: { identity: VoiceIdentity; completionID: string; text: string }, onSegment: (pcm16: Uint8Array, durationMilliseconds: number) => Promise<void>): Promise<void>;
	cancel(identity: VoiceIdentity, completionID: string): void;
}
export interface VoiceSessionRuntimeOptions {
	transcription: VoiceTranscriptionProvider;
	canonical: VoiceCanonicalSubmitter;
	speech?: VoiceSpeechProvider;
	store?: VoiceSessionStore;
	inputWindow?: number;
	receiptNow?: () => Date;
	receiptRetentionMs?: number;
	maximumReceiptsPerSession?: number;
	recordingPacingWait?: (durationMilliseconds: number, signal: AbortSignal) => Promise<void>;
	timingNow?: () => number;
	runtimeIdentity?: string;
	sourceIdentity?: string;
	onTimingDiagnostic?: (diagnostic: VoiceSessionTimingDiagnostic) => void;
}
export interface VoiceSessionPoll {
	identity: VoiceIdentity;
	configuration: VoiceConfiguration;
	events: VoiceServerEvent[];
	last_server_sequence: number;
	terminal: boolean;
	timing: VoiceSessionTimingRecord[];
}

interface RuntimeSession {
	open: VoiceOpen;
	relationshipId?: string;
	input: VoiceInputLedger;
	transcription: VoiceTranscriptionSession;
	events: VoiceServerEvent[];
	phase: "listening" | "speech" | "eou" | "transcript_final" | "accepted" | "assistant_final" | "terminal";
	completionID?: string;
	canonicalDispatch?: { status:"admitted"|"dispatching"|"completed"|"failed"; completion_id:string };
	streamID?: string;
	speechFlow?: VoiceSpeechFlowLedger;
	totalSpeechBytes: number;
	totalSpeechMilliseconds: number;
	partialText: string;
	finalSegments: string[];
	finalText?: string;
	terminal: boolean;
	voiceReceipts: StoredVoiceReceipt[];
	timing: VoiceSessionTimingRecord[];
	timingAnchorMilliseconds: number;
	timingBaseElapsedMilliseconds: number;
	publishedTimingOrdinal: number;
	pendingTerminal?: { code:string; retryable:boolean; cleanup:"none"|"transcription"|"speech" };
	recordingIngestionMode: "batch" | "paced_realtime";
	recordingPacingCancellations: Set<() => void>;
	work: Promise<void>;
}

/**
 * Transport-neutral server runtime for one authenticated agent route.
 * The caller owns authentication and binds `routeAgentID` before invoking it.
 * Raw microphone audio is forwarded to the provider and never retained here.
 */
export class VoiceSessionRuntime {
	private readonly sessions = new Map<string, RuntimeSession>();
	private readonly transactions = new Set<RuntimeSession>();
	private readonly canonicalRecoveries = new Set<string>();
	private readonly recordingIngestions = new Map<string, {
		commitment: string;
		identity: VoiceIdentity;
		configuration: VoiceConfiguration;
		work: Promise<VoiceReplayReconciliation>;
	}>();
	private readonly quarantinedSessionIDs = new Set<string>();
	private readonly inputWindow: number;
	private readonly receiptNow: () => Date;
	private readonly receiptRetentionMs: number;
	private readonly maximumReceiptsPerSession: number;
	private readonly recordingPacingWait: (durationMilliseconds: number, signal: AbortSignal) => Promise<void>;
	private readonly timingNow: () => number;
	private readonly runtimeIdentity: string;
	private readonly sourceIdentity: string;
	constructor(private readonly options: VoiceSessionRuntimeOptions) {
		this.inputWindow = options.inputWindow ?? VOICE_LIMITS.inputWindow;
		this.receiptNow = options.receiptNow ?? (() => new Date());
		this.receiptRetentionMs = options.receiptRetentionMs ?? VOICE_RECEIPT_RETENTION_MS;
		this.maximumReceiptsPerSession = options.maximumReceiptsPerSession
			?? MAXIMUM_VOICE_RECEIPTS_PER_SESSION;
		this.recordingPacingWait = options.recordingPacingWait ?? waitForRecordingDuration;
		this.timingNow = options.timingNow ?? (() => performance.now());
		this.runtimeIdentity = safeVoiceTimingIdentity(options.runtimeIdentity);
		this.sourceIdentity = safeVoiceTimingIdentity(options.sourceIdentity);
		// A one-event window would require 2,047 acknowledgement events and leave
		// no server-event slot for legal EOU. Two is the smallest safe window.
		if (!Number.isSafeInteger(this.inputWindow) || this.inputWindow < 2 || this.inputWindow > VOICE_LIMITS.inputWindow) throw new Error("Invalid voice input window");
		if (!Number.isSafeInteger(this.receiptRetentionMs) || this.receiptRetentionMs < 1
			|| !Number.isSafeInteger(this.maximumReceiptsPerSession)
			|| this.maximumReceiptsPerSession < 1
			|| this.maximumReceiptsPerSession > MAXIMUM_VOICE_RECEIPTS_PER_SESSION) {
			throw new Error("Invalid voice receipt retention bounds");
		}
		for (const record of options.store?.load() ?? []) {
			options.store?.replay.synchronize(record);
			const session = this.restore(record);
			this.sessions.set(record.open.identity.session_id, session);
			if (session.voiceReceipts.length !== (record.voice_receipts ?? []).length) {
				this.persist(session);
			}
			if (session.terminal) continue;
			if (session.canonicalDispatch?.status === "admitted") this.scheduleCanonicalRecovery(session);
			else if (session.canonicalDispatch?.status === "dispatching") this.transaction(session, () => this.emitTerminal(session, "error", { error_code:"canonical_delivery_unknown", retryable:false }));
			else this.transaction(session, () => this.emitTerminal(session, "error", { error_code: "session_interrupted", retryable: true }));
		}
		this.assertDurableDeliveryUniqueness();
	}

	open(routeAgentID: string, raw: unknown, relationshipId?: string): VoiceSessionPoll {
		return this.openWithTranscriptionMode(routeAgentID, raw, false, relationshipId);
	}

	private openWithTranscriptionMode(
		routeAgentID: string,
		raw: unknown,
		preferBatchRecording: boolean,
		relationshipId?: string,
	): VoiceSessionPoll {
		const open = validateVoiceOpen(raw);
		if (open.identity.subject_agent_id !== routeAgentID) throw new VoiceSessionContractError("agent_identity_mismatch");
		const existing = this.sessions.get(open.identity.session_id);
		if (existing) {
			if (!sameVoiceIdentity(existing.open.identity, open.identity)
				|| JSON.stringify(existing.open.configuration) !== JSON.stringify(open.configuration)
				|| (existing.relationshipId !== undefined && existing.relationshipId !== relationshipId)) {
				throw new VoiceSessionContractError("session_identity_conflict");
			}
			existing.relationshipId = relationshipId;
			return this.poll(open.identity.session_id, open.resume_after_server_sequence ?? 0);
		}
		this.authorizeDeliveryOpen(open);
		if ((open.resume_after_server_sequence ?? 0) !== 0) throw new VoiceSessionContractError("resume_not_found");
		try { this.options.store?.replay.markPresent(open); }
		catch (error) { throw new VoiceSessionContractError(error instanceof Error ? error.message : "replay_presence_failed"); }
		let session!: RuntimeSession;
		const timingAnchorMilliseconds = this.timingNow();
		const callbacks: VoiceTranscriptionCallbacks = {
			ready: () => this.enqueue(session, () => this.transaction(session, () => this.markTiming(session, "provider_ready"))),
			speechStarted: () => this.enqueue(session, () => this.transaction(session, () => this.markSpeechStarted(session))),
			speechResumed: () => this.enqueue(session, () => this.transaction(session, () => this.markSpeechResumed(session))),
			partial: (text) => this.enqueue(session, () => this.transaction(session, () => this.markPartial(session, text))),
			segmentFinal: (text) => this.enqueue(session, () => this.transaction(session, () => this.markSegmentFinal(session, text))),
			thoughtCommitted: (text) => this.enqueue(session, () => this.markThoughtCommitted(session, text)),
			error: (code, retryable) => this.enqueue(session, () => this.transaction(session, () => this.fail(session, code, retryable))),
		};
		const batchRecording = preferBatchRecording
			? this.options.transcription.openRecording?.(open.identity, callbacks)
			: undefined;
		session = {
			open,
			relationshipId,
			input: new VoiceInputLedger(open.identity),
			transcription: batchRecording
				?? this.options.transcription.open(open.identity, callbacks),
			events: [], phase: "listening", totalSpeechBytes: 0, totalSpeechMilliseconds: 0,
			partialText: "", finalSegments: [], terminal: false, voiceReceipts: [],
			timing: [], timingAnchorMilliseconds, timingBaseElapsedMilliseconds: 0,
			publishedTimingOrdinal: 0,
			recordingIngestionMode: batchRecording ? "batch" : "paced_realtime",
			recordingPacingCancellations: new Set(), work: Promise.resolve(),
		};
		session.input.acknowledge(0, this.inputWindow);
		this.sessions.set(open.identity.session_id, session);
		try {
			this.transaction(session, () => {
				this.markTiming(session, "session_opened");
				this.emit(session, "ready", { acknowledged_client_sequence: 0, maximum_in_flight_audio_events: this.inputWindow });
			});
		} catch (error) {
			this.sessions.delete(open.identity.session_id);
			try { session.transcription.cancel(); } catch { /* best-effort provider cleanup */ }
			throw error;
		}
		return this.poll(open.identity.session_id, 0);
	}

	async applyRecording(
		routeAgentID: string,
		sessionID: string,
		raw: unknown,
		relationshipId?: string,
	): Promise<VoiceReplayReconciliation> {
		const recording = validateVoiceRecordingUploadRequest(raw);
		if (recording.identity.subject_agent_id !== routeAgentID
			|| recording.identity.session_id !== sessionID) {
			throw new VoiceSessionContractError("mismatched_identity");
		}
		const commitment = createHash("sha256").update(JSON.stringify([
			recording.version,
			recording.identity.session_id,
			recording.identity.capture_id,
			recording.identity.delivery_id,
			recording.identity.subject_agent_id,
			recording.configuration.response_policy,
			recording.configuration.speech_mode,
			recording.captured_at,
			recording.recording_sha256,
		])).digest("hex");
		const inFlight = this.recordingIngestions.get(sessionID);
		if (inFlight) {
			if (!sameVoiceIdentity(inFlight.identity, recording.identity)
				|| JSON.stringify(inFlight.configuration) !== JSON.stringify(recording.configuration)) {
				throw new VoiceSessionContractError("mismatched_identity");
			}
			if (inFlight.commitment !== commitment) {
				throw new VoiceSessionContractError("replay_commitment_mismatch");
			}
			return inFlight.work;
		}
		const work = this.ingestRecording(routeAgentID, sessionID, recording, relationshipId);
		const ownership = {
			commitment,
			identity: recording.identity,
			configuration: recording.configuration,
			work,
		};
		this.recordingIngestions.set(sessionID, ownership);
		try {
			return await work;
		} finally {
			if (this.recordingIngestions.get(sessionID) === ownership) {
				this.recordingIngestions.delete(sessionID);
			}
		}
	}

	private async ingestRecording(
		routeAgentID: string,
		sessionID: string,
		recording: VoiceRecordingUploadRequest,
		relationshipId?: string,
	): Promise<VoiceReplayReconciliation> {
		const replay = voiceRecordingReplayRequest(recording);
		validateVoiceReplayRequest(replay);
		const age = Date.now() - Date.parse(recording.captured_at);
		if (age < -5 * 60 * 1_000 || age >= VOICE_REPLAY_CACHE_TTL_MILLISECONDS) {
			return this.replayResponse(recording.identity, recording.configuration, "expired", "unknown", true);
		}
		if (!this.options.store || this.quarantinedSessionIDs.has(sessionID)) {
			return this.replayResponse(recording.identity, recording.configuration, "unknown", "unknown", false);
		}

		let session = this.sessions.get(sessionID);
		if (!session) {
			const tombstone = this.options.store.replay.findTombstone(sessionID);
			if (tombstone) {
				if (!sameVoiceIdentity(tombstone.identity, recording.identity)
					|| JSON.stringify(tombstone.configuration) !== JSON.stringify(recording.configuration)) {
					throw new VoiceSessionContractError("mismatched_identity");
				}
				this.assertReplayPrefix(tombstone.input, replay.frames, false);
				const input = this.inputProjection(tombstone.input);
				if (tombstone.terminal_kind === "completed" || tombstone.canonical_custody === "completed") {
					return this.replayResponse(tombstone.identity, tombstone.configuration, "completed", "completed", true, input);
				}
				return this.replayResponse(
					tombstone.identity, tombstone.configuration,
					["admitted", "dispatching", "unknown"].includes(tombstone.canonical_custody)
						? "unknown" : "terminal_without_delivery",
					tombstone.canonical_custody, true, input, undefined, undefined, tombstone.error_code,
				);
			}
			const presence = this.options.store.replay.findPresence(sessionID);
			if (presence) {
				if (!sameVoiceIdentity(presence.identity, recording.identity)
					|| JSON.stringify(presence.configuration) !== JSON.stringify(recording.configuration)) {
					throw new VoiceSessionContractError("mismatched_identity");
				}
				return this.replayResponse(
					presence.identity, presence.configuration,
					presence.canonical_custody === "completed" ? "completed" : "unknown",
					presence.canonical_custody, presence.terminal_kind !== undefined,
					undefined, undefined, undefined, presence.error_code,
				);
			}
			this.openWithTranscriptionMode(routeAgentID, {
				version: VOICE_SESSION_VERSION,
				identity: recording.identity,
				audio: { encoding: "pcm_s16le", sample_rate: 16_000, channel_count: 1 },
				configuration: recording.configuration,
			}, true, relationshipId);
			session = this.sessions.get(sessionID)!;
		}
		if (!sameVoiceIdentity(session.open.identity, recording.identity)
			|| JSON.stringify(session.open.configuration) !== JSON.stringify(recording.configuration)
			|| session.relationshipId !== relationshipId) {
			throw new VoiceSessionContractError("mismatched_identity");
		}
		this.assertReplayPrefix(session.input.checkpoint(), replay.frames, false);
		const totalDurationMilliseconds = replay.frames.reduce(
			(total, frame) => total + frame.duration_milliseconds,
			0,
		);
		if (totalDurationMilliseconds > VOICE_LIMITS.captureMilliseconds) {
			throw new VoiceSessionContractError("invalid_replay_commitment");
		}
		this.transaction(session, () => this.markTiming(session, "recording_custody_accepted"));
		const pcm = strictBase64(recording.audio)!;
		let offset = 0;
		for (const frame of replay.frames) {
			const bytes = pcm.subarray(offset, offset + frame.byte_count);
			offset += frame.byte_count;
			if (!this.recordingIngestionCanContinue(session)) break;
			const newlyApplied = frame.sequence > session.input.highestClientSequence;
			await this.applyClientEventInternal(routeAgentID, sessionID, {
				version: VOICE_SESSION_VERSION,
				identity: recording.identity,
				sequence: frame.sequence,
				kind: "audio",
				audio: bytes.toString("base64"),
				duration_milliseconds: frame.duration_milliseconds,
			}, undefined, true);
			await session.work;
			if (!this.recordingIngestionCanContinue(session)) break;
			if (newlyApplied && frame.sequence === replay.frames.length) {
				this.transaction(session, () => this.markTiming(session, "recording_last_frame_committed"));
			}
			if (newlyApplied
				&& session.recordingIngestionMode === "paced_realtime"
				&& !await this.waitForRecordingFrameDuration(session, frame.duration_milliseconds)) break;
		}
		await session.work;
		if (this.recordingIngestionCanContinue(session)
			&& session.input.highestClientSequence === replay.frames.length) {
			await this.applyClientEvent(routeAgentID, sessionID, {
				version: VOICE_SESSION_VERSION,
				identity: recording.identity,
				sequence: replay.frames.length + 1,
				kind: "end_of_utterance",
			});
		}
		const result = this.evaluateReplaySource(session, replay, false);
		return result.disposition === "retry_authorized"
			? this.replayResponse(
				result.identity, result.configuration, "terminal_without_delivery",
				result.canonical_custody, result.terminal, result.input, result.poll,
				undefined, result.error_code,
			)
			: result;
	}


	async applyClientEvent(
		routeAgentID: string,
		sessionID: string,
		raw: unknown,
		receiptClaim?: VoiceReceiptClaim,
	): Promise<VoiceSessionPoll> {
		return this.applyClientEventInternal(routeAgentID, sessionID, raw, receiptClaim);
	}

	private async applyClientEventInternal(
		routeAgentID: string,
		sessionID: string,
		raw: unknown,
		receiptClaim?: VoiceReceiptClaim,
		validatedRecordingIngestion = false,
	): Promise<VoiceSessionPoll> {
		const session = this.require(routeAgentID, sessionID);
		const event = validateVoiceClientEvent(raw, session.open.identity);
		this.validateReceiptClaim(routeAgentID, session, event.kind, receiptClaim);
		this.assertAuthorizedRetryEvent(session, event);
		if (session.pendingTerminal) {
			session.input.assertExactReplay(event);
			if (receiptClaim) this.transaction(session, () => this.recordVoiceReceipt(session, event.sequence, receiptClaim));
			this.reconcilePendingTerminal(session);
			return this.poll(sessionID, 0);
		}
		if (session.terminal && event.sequence > session.input.highestClientSequence) throw new VoiceSessionContractError("event_after_terminal");
		if (session.phase === "transcript_final"
			&& event.sequence > session.input.highestClientSequence
			&& event.kind !== "cancel") throw new VoiceSessionContractError("event_after_terminal");
		let applied = false;
		try {
			this.transaction(session, () => {
				applied = session.input.apply(event);
				if (applied) {
					if (event.kind === "audio") this.markTiming(session, "input_first_audio_committed");
					if (event.kind === "audio" && session.input.availableAudioSlots === 0) {
						session.input.acknowledge(event.sequence, this.inputWindow);
						this.emit(session, "audio_accepted", { acknowledged_client_sequence: event.sequence, maximum_in_flight_audio_events: this.inputWindow });
					} else if (event.kind === "end_of_utterance") {
						this.markTiming(session, "input_finalized");
						if (session.input.acknowledgedClientSequence < event.sequence) {
							session.input.acknowledge(event.sequence, this.inputWindow);
							this.emit(session, "audio_accepted", { acknowledged_client_sequence: event.sequence, maximum_in_flight_audio_events: this.inputWindow });
						}
						this.markEOU(session);
					} else if (event.kind === "cancel") this.emitTerminal(session, "cancelled", {});
				}
				if (receiptClaim) this.recordVoiceReceipt(session, event.sequence, receiptClaim);
			});
		} catch (error) {
			if (error instanceof VoiceSessionContractError && error.code === "bounds_exceeded") {
				this.commitFailureTerminal(session, "bounds_exceeded", false, "transcription");
				return this.poll(sessionID, 0);
			}
			throw error;
		}
		if (!applied) return this.poll(sessionID, 0);
		if (event.kind === "audio") {
			const pcm = strictBase64(event.audio!)!;
			try { session.transcription.append(pcm); }
			catch {
				this.commitFailureTerminal(session, "transcription_provider_failed", true, "transcription");
				return this.poll(sessionID, 0);
			}
			if (!validatedRecordingIngestion
				&& (session.input.totalAudioBytes >= VOICE_LIMITS.captureBytes
					|| session.input.totalAudioMilliseconds >= VOICE_LIMITS.captureMilliseconds)) {
				this.commitFailureTerminal(session, "bounds_exceeded", false, "transcription");
				return this.poll(sessionID, 0);
			}
		} else if (event.kind === "end_of_utterance") {
			try { session.transcription.finish(); }
			catch {
				this.commitFailureTerminal(session, "transcription_provider_failed", true, "transcription");
			}
		} else {
			try { session.transcription.cancel(); } catch { /* best-effort provider cleanup */ }
			try { this.options.speech?.cancel(session.open.identity, session.completionID ?? "cancelled-before-completion"); } catch { /* best-effort provider cleanup */ }
		}
		// Provider callbacks continue on the session's serialized work chain. The
		// request returns immediately so the client can poll events and release
		// progressive-speech backpressure rather than deadlocking behind it.
		return this.poll(sessionID, 0);
	}

	lookupVoiceReceipt(
		routeAgentID: string,
		lookup: VoiceReceiptLookup,
		agentCorrelation: string,
	): VoiceReceiptEvidence | null {
		if (!isVoiceReceiptLookup(lookup)
			|| !isVoiceReceiptClaim({
				agent_correlation: agentCorrelation,
				request_correlation: lookup.request_correlation,
			})) throw new VoiceSessionContractError("invalid_receipt_lookup");
		for (const session of this.sessions.values()) {
			if (session.open.identity.subject_agent_id !== routeAgentID) continue;
			this.pruneSessionReceipts(session);
			const receipt = session.voiceReceipts.find((candidate) =>
				sameVoiceReceiptKey(candidate, lookup, agentCorrelation));
			if (receipt) return publicVoiceReceipt(receipt);
		}
		return null;
	}

	applySpeechControl(routeAgentID: string, sessionID: string, raw: unknown): VoiceSessionPoll {
		const session = this.require(routeAgentID, sessionID);
		const control = validateSpeechControl(raw, session.open.identity);
		if (session.pendingTerminal) { session.speechFlow?.assertExactControlReplay(control); if (!session.speechFlow) throw new VoiceSessionContractError("speech_stream_unavailable"); this.reconcilePendingTerminal(session); return this.poll(sessionID, 0); }
		if (!session.speechFlow) throw new VoiceSessionContractError("speech_stream_unavailable");
		if (session.terminal && control.sequence > session.speechFlow.lastControlSequence) throw new VoiceSessionContractError("event_after_terminal");
		const applied = this.transaction(session, () => {
			const accepted = session.speechFlow!.applyControl(control);
			if (!accepted) return false;
			if (control.kind === "cancel" && !session.terminal) this.emit(session, "assistant_speech_cancelled", {
				completion_id: session.completionID, speech_stream_id: session.streamID,
				final_speech_segment_sequence: session.speechFlow!.highestSegmentSequence,
			});
			return true;
		});
		if (!applied) return this.poll(sessionID, 0);
		if (control.kind === "cancel") {
			try { this.options.speech?.cancel(session.open.identity, session.completionID!); } catch { /* best-effort provider cleanup */ }
		}
		return this.poll(sessionID, 0);
	}

	poll(sessionID: string, after: number): VoiceSessionPoll {
		const session = this.sessions.get(sessionID);
		if (!session) throw new VoiceSessionContractError("session_not_found");
		if (!Number.isSafeInteger(after) || after < 0 || after > VOICE_LIMITS.serverEvents) throw new VoiceSessionContractError("invalid_sequence");
		this.reconcilePendingTerminal(session);
		if (session.canonicalDispatch?.status === "admitted") this.scheduleCanonicalRecovery(session);
		return { identity: session.open.identity, configuration: session.open.configuration,
			events: session.events.filter((event) => event.sequence > after),
			last_server_sequence: session.events.length, terminal: session.terminal,
			timing: [...session.timing] };
	}

	private validateReceiptClaim(
		routeAgentID: string,
		session: RuntimeSession,
		eventKind: string,
		claim?: VoiceReceiptClaim,
	): void {
		if (!claim) return;
		if (eventKind !== "audio"
			|| session.open.identity.subject_agent_id !== routeAgentID
			|| !isVoiceReceiptClaim(claim)) {
			throw new VoiceSessionContractError("invalid_receipt_claim");
		}
	}

	private recordVoiceReceipt(
		session: RuntimeSession,
		clientSequence: number,
		claim: VoiceReceiptClaim,
	): void {
		const now = this.receiptNow();
		session.voiceReceipts = pruneVoiceReceipts(
			session.voiceReceipts,
			now,
			this.maximumReceiptsPerSession,
		);
		const sameRequest = session.voiceReceipts.find((receipt) =>
			receipt.agent_correlation === claim.agent_correlation
				&& receipt.request_correlation === claim.request_correlation);
		if (sameRequest) {
			if (sameRequest.client_sequence !== clientSequence) {
				throw new VoiceSessionContractError("invalid_receipt_claim");
			}
			return;
		}
		const receipt = createStoredVoiceReceipt({
			claim,
			sessionID: session.open.identity.session_id,
			clientSequence,
			serverSequence: session.events.length,
			recordedAt: now,
			retentionMs: this.receiptRetentionMs,
		});
		session.voiceReceipts = pruneVoiceReceipts(
			[...session.voiceReceipts, receipt],
			now,
			this.maximumReceiptsPerSession,
		);
	}

	private pruneSessionReceipts(session: RuntimeSession): void {
		const retained = pruneVoiceReceipts(
			session.voiceReceipts,
			this.receiptNow(),
			this.maximumReceiptsPerSession,
		);
		if (retained.length === session.voiceReceipts.length) return;
		this.transaction(session, () => { session.voiceReceipts = retained; });
	}

	reconcile(routeAgentID: string, sessionID: string, raw: unknown): VoiceReplayReconciliation {
		const request = validateVoiceReplayRequest(raw);
		if (request.identity.subject_agent_id !== routeAgentID) throw new VoiceSessionContractError("agent_identity_mismatch");
		if (request.identity.session_id !== sessionID) throw new VoiceSessionContractError("mismatched_identity");
		const capturedAt = Date.parse(request.captured_at);
		const age = Date.now() - capturedAt;
		if (age < -5 * 60 * 1_000) throw new VoiceSessionContractError("invalid_replay_request");
		if (age >= VOICE_REPLAY_CACHE_TTL_MILLISECONDS) {
			return this.replayResponse(request.identity, request.configuration, "expired", "unknown", true);
		}
		if (!this.options.store || this.quarantinedSessionIDs.has(sessionID)) {
			return this.replayResponse(request.identity, request.configuration, "unknown", "unknown", false);
		}

		const replayStore = this.options.store.replay;
		const priorAuthorization = replayStore.findAuthorizationForOriginal(sessionID);
		if (priorAuthorization) {
			this.assertSameReplayRequest(priorAuthorization, request);
			const authorization = replayStore.wireAuthorization(priorAuthorization);
			if (priorAuthorization.state === "issued") {
				return this.replayResponse(
					request.identity, request.configuration, "retry_authorized", "none", true,
					undefined, undefined, authorization,
				);
			}
			const retrySession = this.sessions.get(priorAuthorization.retry_identity.session_id);
			const retryTombstone = replayStore.findTombstone(priorAuthorization.retry_identity.session_id);
			if (retrySession) return this.evaluateReplaySource(retrySession, request, true, authorization);
			if (retryTombstone) return this.evaluateReplayTombstone(retryTombstone, request, true, authorization);
			return this.replayResponse(
				priorAuthorization.retry_identity, request.configuration, "retry_in_progress", "none", false,
				undefined, undefined, authorization,
			);
		}

		const session = this.sessions.get(sessionID);
		if (session) return this.evaluateReplaySource(session, request, false);
		const tombstone = replayStore.findTombstone(sessionID);
		if (tombstone) return this.evaluateReplayTombstone(tombstone, request, false);
		const presence = replayStore.findPresence(sessionID);
		if (presence) {
			if (!sameVoiceIdentity(presence.identity, request.identity)
				|| JSON.stringify(presence.configuration) !== JSON.stringify(request.configuration)) {
				throw new VoiceSessionContractError("mismatched_identity");
			}
			return this.replayResponse(
				presence.identity,
				presence.configuration,
				presence.canonical_custody === "completed" ? "completed" : "unknown",
				presence.canonical_custody,
				presence.terminal_kind !== undefined,
				undefined,
				undefined,
				undefined,
				presence.error_code,
			);
		}

		// Absence is affirmative only while the signed recording remains inside
		// the same retention horizon guaranteed by the durable replay store.
		const authorization = this.issueReplayAuthorization(request);
		return this.replayResponse(
			request.identity, request.configuration, "never_admitted", "none", true,
			undefined, undefined, authorization,
		);
	}

	private require(routeAgentID: string, sessionID: string): RuntimeSession {
		if (!isSafeVoiceIdentifier(sessionID)) throw new VoiceSessionContractError("invalid_session_id");
		const session = this.sessions.get(sessionID);
		if (!session) throw new VoiceSessionContractError("session_not_found");
		if (session.open.identity.subject_agent_id !== routeAgentID) throw new VoiceSessionContractError("agent_identity_mismatch");
		return session;
	}

	private authorizeDeliveryOpen(open: VoiceOpen): void {
		const known = this.knownDeliveryIdentities(open.identity.delivery_id);
		if (!open.retry_authorization) {
			if (known.some((identity) => !sameVoiceIdentity(identity, open.identity))) {
				throw new VoiceSessionContractError("delivery_identity_conflict");
			}
			return;
		}
		if (!this.options.store) throw new VoiceSessionContractError("replay_unavailable");
		let authorization: VoiceReplayAuthorizationRecord;
		try {
			authorization = this.options.store.replay.consume(
				open.retry_authorization.original_session_id,
				open.retry_authorization.authorization_id,
				open.retry_authorization.recording_digest,
				open.identity,
				open.configuration,
			);
		} catch (error) {
			throw new VoiceSessionContractError(error instanceof Error ? error.message : "invalid_retry_authorization");
		}
		if (known.some((identity) => !sameVoiceIdentity(identity, authorization.original_identity)
			&& !sameVoiceIdentity(identity, authorization.retry_identity))) {
			throw new VoiceSessionContractError("delivery_identity_conflict");
		}
	}

	private knownDeliveryIdentities(deliveryID: string): VoiceIdentity[] {
		const identities = [...this.sessions.values()].map((session) => session.open.identity)
			.filter((identity) => identity.delivery_id === deliveryID);
		for (const record of this.options.store?.replayRecords() ?? []) {
			if ((record.kind === "tombstone" || record.kind === "presence")
				&& record.identity.delivery_id === deliveryID) identities.push(record.identity);
			if (record.kind === "authorization" && record.original_identity.delivery_id === deliveryID) {
				identities.push(record.original_identity, record.retry_identity);
			}
		}
		return identities.filter((identity, index) => identities.findIndex((candidate) => sameVoiceIdentity(candidate, identity)) === index);
	}

	private assertDurableDeliveryUniqueness(): void {
		const deliveries = new Set([
			...[...this.sessions.values()].map((session) => session.open.identity.delivery_id),
			...(this.options.store?.replayRecords() ?? []).map((record) => record.kind === "authorization"
				? record.original_identity.delivery_id
				: record.identity.delivery_id),
		]);
		for (const deliveryID of deliveries) {
			const identities = this.knownDeliveryIdentities(deliveryID);
			if (identities.length <= 1) continue;
			const authorization = (this.options.store?.replayRecords() ?? []).find((record): record is VoiceReplayAuthorizationRecord =>
				record.kind === "authorization" && record.original_identity.delivery_id === deliveryID);
			if (!authorization || identities.some((identity) => !sameVoiceIdentity(identity, authorization.original_identity)
				&& !sameVoiceIdentity(identity, authorization.retry_identity))) {
				throw new Error("Voice delivery replay ownership is ambiguous");
			}
		}
	}

	private assertAuthorizedRetryEvent(session: RuntimeSession, event: ReturnType<typeof validateVoiceClientEvent>): void {
		const authorization = this.options.store?.findReplayAuthorizationForRetry(session.open.identity.session_id);
		if (!authorization) return;
		if (authorization.state !== "consumed" || !sameVoiceIdentity(authorization.retry_identity, session.open.identity)) {
			throw new VoiceSessionContractError("invalid_retry_authorization");
		}
		if (event.kind === "cancel") return;
		if (event.kind === "end_of_utterance") {
			if (event.sequence !== authorization.frames.length + 1) throw new VoiceSessionContractError("replay_commitment_mismatch");
			return;
		}
		const frame = authorization.frames[event.sequence - 1];
		const audio = strictBase64(event.audio!);
		if (!frame || !audio || frame.byte_count !== audio.byteLength
			|| frame.duration_milliseconds !== event.duration_milliseconds
			|| frame.audio_sha256 !== createHash("sha256").update(audio).digest("hex")) {
			throw new VoiceSessionContractError("replay_commitment_mismatch");
		}
	}

	private evaluateReplaySource(
		session: RuntimeSession,
		request: VoiceReplayReconciliationRequest,
		isRetry: boolean,
		authorization?: VoiceReplayAuthorization,
	): VoiceReplayReconciliation {
		if (JSON.stringify(session.open.configuration) !== JSON.stringify(request.configuration)) {
			throw new VoiceSessionContractError("invalid_configuration");
		}
		this.assertReplayPrefix(session.input.checkpoint(), request.frames, isRetry);
		const custody = this.sessionCanonicalCustody(session);
		const input = this.inputProjection(session.input.checkpoint());
		const poll = this.poll(session.open.identity.session_id, 0);
		const errorCode = session.events.at(-1)?.kind === "error" ? session.events.at(-1)?.error_code : undefined;
		if (session.events.at(-1)?.kind === "completed" || custody === "completed") {
			return this.replayResponse(session.open.identity, session.open.configuration, "completed", "completed", true, input, poll, authorization);
		}
		if (custody === "admitted" || custody === "dispatching") {
			return this.replayResponse(
				session.open.identity,
				session.open.configuration,
				custody === "dispatching" && session.terminal ? "unknown" : "processing",
				custody,
				session.terminal,
				input,
				poll,
				authorization,
				errorCode,
			);
		}
		if (custody === "unknown") {
			return this.replayResponse(session.open.identity, session.open.configuration, "unknown", custody, session.terminal, input, poll, authorization, errorCode);
		}
		if (!session.terminal) {
			return this.replayResponse(
				session.open.identity, session.open.configuration,
				session.input.inputClosed ? "processing" : "resume_original",
				custody, false, input, poll, authorization,
			);
		}
		if (isRetry) {
			return this.replayResponse(session.open.identity, session.open.configuration, "terminal_without_delivery", custody, true, input, poll, authorization, errorCode);
		}
		if (custody === "failed" && errorCode !== "canonical_completion_mismatch") {
			return this.replayResponse(session.open.identity, session.open.configuration, "unknown", custody, true, input, poll, undefined, errorCode);
		}
		const issued = this.issueReplayAuthorization(request);
		return this.replayResponse(session.open.identity, session.open.configuration, "retry_authorized", custody, true, input, poll, issued, errorCode);
	}

	private evaluateReplayTombstone(
		tombstone: VoiceReplayTombstone,
		request: VoiceReplayReconciliationRequest,
		isRetry: boolean,
		authorization?: VoiceReplayAuthorization,
	): VoiceReplayReconciliation {
		if (!sameVoiceIdentity(tombstone.identity, isRetry ? tombstone.identity : request.identity)
			|| JSON.stringify(tombstone.configuration) !== JSON.stringify(request.configuration)) {
			throw new VoiceSessionContractError("mismatched_identity");
		}
		this.assertReplayPrefix(tombstone.input, request.frames, isRetry);
		const input = this.inputProjection(tombstone.input);
		if (tombstone.terminal_kind === "completed" || tombstone.canonical_custody === "completed") {
			return this.replayResponse(tombstone.identity, tombstone.configuration, "completed", "completed", true, input, undefined, authorization);
		}
		if (["admitted", "dispatching", "unknown"].includes(tombstone.canonical_custody)) {
			return this.replayResponse(tombstone.identity, tombstone.configuration, "unknown", tombstone.canonical_custody, true, input, undefined, authorization, tombstone.error_code);
		}
		if (isRetry) {
			return this.replayResponse(tombstone.identity, tombstone.configuration, "terminal_without_delivery", tombstone.canonical_custody, true, input, undefined, authorization, tombstone.error_code);
		}
		if (tombstone.canonical_custody === "failed" && tombstone.error_code !== "canonical_completion_mismatch") {
			return this.replayResponse(tombstone.identity, tombstone.configuration, "unknown", "failed", true, input, undefined, undefined, tombstone.error_code);
		}
		const issued = this.issueReplayAuthorization(request);
		return this.replayResponse(tombstone.identity, tombstone.configuration, "retry_authorized", tombstone.canonical_custody, true, input, undefined, issued, tombstone.error_code);
	}

	private issueReplayAuthorization(request: VoiceReplayReconciliationRequest): VoiceReplayAuthorization {
		if (!this.options.store) throw new VoiceSessionContractError("replay_unavailable");
		try {
			return this.options.store.replay.wireAuthorization(this.options.store.replay.issue(
				request.identity, request.configuration, request.recording_digest, request.frames,
			));
		} catch (error) {
			throw new VoiceSessionContractError(error instanceof Error ? error.message : "replay_authorization_failed");
		}
	}

	private assertSameReplayRequest(record: VoiceReplayAuthorizationRecord, request: VoiceReplayReconciliationRequest): void {
		if (!sameVoiceIdentity(record.original_identity, request.identity)
			|| JSON.stringify(record.configuration) !== JSON.stringify(request.configuration)
			|| record.recording_digest !== request.recording_digest
			|| JSON.stringify(record.frames) !== JSON.stringify(request.frames)) {
			throw new VoiceSessionContractError("voice_replay_authorization_conflict");
		}
	}

	private assertReplayPrefix(
		checkpoint: ReturnType<VoiceInputLedger["checkpoint"]>,
		frames: VoiceReplayFrameCommitment[],
		isRetry: boolean,
	): void {
		const audioEventCount = checkpoint.highest_client_sequence
			- (checkpoint.closure_reason === "client_terminal" ? 1 : 0);
		if (audioEventCount > frames.length) throw new VoiceSessionContractError("replay_commitment_mismatch");
		if (isRetry) return;
		for (let sequence = 1; sequence <= audioEventCount; sequence++) {
			if (checkpoint.fingerprints[String(sequence)] !== frames[sequence - 1]?.event_fingerprint) {
				throw new VoiceSessionContractError("replay_commitment_mismatch");
			}
		}
	}

	private inputProjection(checkpoint: ReturnType<VoiceInputLedger["checkpoint"]>): VoiceReplayInputProjection {
		const audioEventCount = checkpoint.highest_client_sequence
			- (checkpoint.closure_reason === "client_terminal" ? 1 : 0);
		return {
			highest_client_sequence: checkpoint.highest_client_sequence,
			acknowledged_client_sequence: checkpoint.acknowledged_client_sequence,
			audio_event_count: audioEventCount,
			input_closed: checkpoint.input_closed,
			accepted_event_fingerprints: Array.from({ length: audioEventCount }, (_, index) => ({
				sequence: index + 1,
				fingerprint: checkpoint.fingerprints[String(index + 1)]!,
			})),
		};
	}

	private sessionCanonicalCustody(session: RuntimeSession): VoiceCanonicalCustody {
		if (session.canonicalDispatch) return session.canonicalDispatch.status;
		return session.events.some((event) => event.kind === "send_accepted") ? "unknown" : "none";
	}

	private replayResponse(
		identity: VoiceIdentity,
		configuration: VoiceConfiguration,
		disposition: VoiceReplayReconciliation["disposition"],
		canonicalCustodyValue: VoiceCanonicalCustody,
		terminal: boolean,
		input?: VoiceReplayInputProjection,
		poll?: VoiceSessionPoll,
		retryAuthorization?: VoiceReplayAuthorization,
		errorCode?: string,
	): VoiceReplayReconciliation {
		return {
			version: VOICE_REPLAY_VERSION,
			identity,
			configuration,
			disposition,
			canonical_custody: canonicalCustodyValue,
			terminal,
			...(input ? { input } : {}),
			...(poll ? { poll } : {}),
			...(retryAuthorization ? { retry_authorization: retryAuthorization } : {}),
			...(errorCode ? { error_code: errorCode } : {}),
		};
	}

	private recordingIngestionCanContinue(session: RuntimeSession): boolean {
		return this.sessions.get(session.open.identity.session_id) === session
			&& !this.quarantinedSessionIDs.has(session.open.identity.session_id)
			&& !session.pendingTerminal
			&& !session.terminal
			&& !session.input.inputClosed;
	}

	private async waitForRecordingFrameDuration(
		session: RuntimeSession,
		durationMilliseconds: number,
	): Promise<boolean> {
		if (!this.recordingIngestionCanContinue(session)) return false;
		const controller = new AbortController();
		const cancel = () => controller.abort();
		session.recordingPacingCancellations.add(cancel);
		if (!this.recordingIngestionCanContinue(session)) cancel();
		try {
			await this.recordingPacingWait(durationMilliseconds, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		} finally {
			session.recordingPacingCancellations.delete(cancel);
		}
		await session.work;
		return !controller.signal.aborted && this.recordingIngestionCanContinue(session);
	}

	private cancelRecordingPacing(session: RuntimeSession): void {
		for (const cancel of session.recordingPacingCancellations) cancel();
		session.recordingPacingCancellations.clear();
	}

	private enqueue(session: RuntimeSession, work: () => void | Promise<void>): Promise<void> {
		session.work = session.work.then(async () => {
			if (session.pendingTerminal || session.terminal) return;
			await work();
		}).catch((error: unknown) => {
			const code = error instanceof VoiceSessionContractError ? error.code : "voice_session_failed";
			const speechFailure = code === "speech_backpressure_timeout" || code === "speech_provider_failed" || code === "speech_bounds_exceeded" || code === "speech_empty";
			try { this.commitFailureTerminal(session, code, speechFailure, speechFailure ? "speech" : "transcription"); }
			catch { /* pending terminal is retried without replaying the failed provider side effect */ }
		});
		return session.work;
	}
	private scheduleCanonicalRecovery(session:RuntimeSession):void {
		const sessionID=session.open.identity.session_id;
		if (session.terminal || session.pendingTerminal || session.canonicalDispatch?.status !== "admitted" || this.canonicalRecoveries.has(sessionID)) return;
		this.canonicalRecoveries.add(sessionID);
		void this.enqueue(session, () => this.recoverCanonicalDispatch(session)).finally(() => this.canonicalRecoveries.delete(sessionID));
	}
	private markSpeechStarted(session: RuntimeSession): void {
		if (session.terminal || session.phase !== "listening") return;
		session.phase = "speech"; this.emit(session, "speech_started", {});
	}
	private markSpeechResumed(session: RuntimeSession): void {
		// Resumed provider speech retracts the adapter's pending continuation
		// deadline. It does not create a second utterance or authorize delivery.
		if (session.terminal || session.phase !== "speech") return;
	}
	private markPartial(session: RuntimeSession, text: string): void {
		const clean = text.trim(); if (!clean || session.terminal || !["speech","eou"].includes(session.phase)) return;
		if (Buffer.byteLength(clean) > VOICE_LIMITS.textBytes) throw new VoiceSessionContractError("transcript_too_large");
		if (clean === session.partialText) return;
		session.partialText = clean;
		if (this.canEmitStreamingSnapshot(session, Buffer.byteLength(clean))) this.emit(session,"transcript_partial",{ text:clean });
	}
	private markSegmentFinal(session: RuntimeSession, text: string): void {
		const clean = text.trim();
		if (!clean || session.terminal || !["listening","speech","eou"].includes(session.phase)) return;
		if (session.phase === "listening") this.markSpeechStarted(session);
		const cumulative = [...session.finalSegments, clean].join(" ").trim();
		if (Buffer.byteLength(cumulative) > VOICE_LIMITS.textBytes) throw new VoiceSessionContractError("transcript_too_large");
		session.finalSegments.push(clean);
		this.markPartial(session, cumulative);
	}
	private markEOU(session: RuntimeSession): void {
		if (session.terminal || ["eou","transcript_final","accepted","assistant_final"].includes(session.phase)) return;
		if (!["listening","speech"].includes(session.phase)) return;
		// Client manual finalization may freeze input before provider commitment.
		// Natural provider boundaries remain inside the adapter until thought commit.
		if (session.phase === "listening") this.markSpeechStarted(session);
		session.phase = "eou"; this.emit(session,"end_of_utterance",{});
	}
	private async markThoughtCommitted(session: RuntimeSession, text: string): Promise<void> {
		const clean = text.trim();
		if (session.pendingTerminal || session.terminal || ["transcript_final","accepted","assistant_final"].includes(session.phase)) return;
		const exactFinalSegments = session.finalSegments.join(" ").trim();
		if (!clean || clean !== exactFinalSegments || Buffer.byteLength(clean) > VOICE_LIMITS.textBytes) {
			throw new VoiceSessionContractError("invalid_transcript");
		}
		this.transaction(session, () => {
			this.markEOU(session);
			this.markTiming(session, "transcription_final");
			session.phase = "transcript_final"; session.finalText = clean;
			this.emit(session,"transcript_final",{ text:clean });
		});
		const prepared = await this.options.canonical.prepare({
			identity: session.open.identity,
			text: clean,
			responsePolicy: session.open.configuration.response_policy,
			relationshipId: session.relationshipId,
		});
		if (session.pendingTerminal || session.terminal) return;
		if (!isSafeVoiceIdentifier(prepared.completionID)) return this.transaction(session, () => this.fail(session,"invalid_completion",false));
		this.transaction(session, () => {
			session.input.closeForCanonicalAdmission();
			this.markTiming(session, "canonical_admitted");
			session.completionID = prepared.completionID; session.phase = "accepted";
			session.canonicalDispatch = { status:"admitted", completion_id:prepared.completionID };
			this.emit(session,"send_accepted",{ completion_id:prepared.completionID });
		});
		await this.runPreparedDispatch(session, prepared);
	}
	private async recoverCanonicalDispatch(session:RuntimeSession):Promise<void> {
		if (session.terminal || session.pendingTerminal || session.canonicalDispatch?.status !== "admitted" || !session.finalText) return;
		let prepared:VoiceCanonicalPrepared;
		try {
			prepared = await this.options.canonical.prepare({
				identity: session.open.identity,
				text: session.finalText,
				responsePolicy: session.open.configuration.response_policy,
				relationshipId: session.relationshipId,
			});
		}
		catch { return; /* transient side-effect-free prepare failure remains admitted and retryable */ }
		if (prepared.completionID !== session.canonicalDispatch.completion_id) {
			try {
				this.transaction(session, () => {
					session.canonicalDispatch = { status:"failed", completion_id:session.completionID! };
					this.emitTerminal(session,"error",{error_code:"canonical_completion_mismatch",retryable:false});
				});
			} catch { return; /* exact mismatch transition remains admitted and retryable */ }
			return;
		}
		await this.runPreparedDispatch(session, prepared);
	}
	private async runPreparedDispatch(session:RuntimeSession, prepared:VoiceCanonicalPrepared):Promise<void> {
		if (session.terminal || session.pendingTerminal || session.canonicalDispatch?.status !== "admitted") return;
		try { this.transaction(session, () => {
			this.markTiming(session, "canonical_dispatch_started");
			session.canonicalDispatch = { status:"dispatching", completion_id:prepared.completionID };
		}); }
		catch { return; /* durable admission remains replayable; no canonical side effect began */ }
		const reply = await prepared.dispatch();
		if (session.pendingTerminal || session.terminal) return;
		for await (const partial of reply.partials) {
			if (session.pendingTerminal || session.terminal) return;
			if (this.canEmitStreamingSnapshot(session, Buffer.byteLength(partial.text))) this.transaction(session, () => {
				this.markTiming(session, "assistant_first_output");
				this.emit(session,"assistant_partial",{ text:partial.text, completion_id:prepared.completionID, is_speech_eligible:partial.speechEligible });
			});
		}
		const final = await reply.final;
		if (session.pendingTerminal || session.terminal) return;
		this.transaction(session, () => {
			this.markTiming(session, "assistant_first_output");
			this.markTiming(session, "assistant_final");
			session.phase = "assistant_final";
			this.emit(session,"assistant_final",{ text:final.text, completion_id:prepared.completionID, is_speech_eligible:final.speechEligible });
		});
		if (session.open.configuration.speech_mode === "progressive_audio" && final.speechEligible) {
			if (!this.options.speech) return this.transaction(session, () => this.fail(session, "speech_unavailable", true));
			await this.streamSpeech(session, final.text);
		}
		if (session.pendingTerminal || session.terminal) return;
		this.transaction(session, () => {
			session.canonicalDispatch = { status:"completed", completion_id:prepared.completionID };
			this.emitTerminal(session,"completed",{ completion_id:prepared.completionID });
		});
	}

	private async streamSpeech(session: RuntimeSession, text: string): Promise<void> {
		if (session.pendingTerminal || session.terminal) return;
		const completionID = session.completionID!; const streamID = `speech-${randomUUID()}`;
		this.transaction(session, () => {
			this.markTiming(session, "speech_started");
			session.streamID = streamID;
			session.speechFlow = new VoiceSpeechFlowLedger(session.open.identity,completionID,streamID);
			this.emit(session,"assistant_speech_started",{ completion_id:completionID, speech_stream_id:streamID, speech_audio_format:{ encoding:"pcm_s16le",sample_rate:24_000,channel_count:1 } });
		});
		try {
			await this.options.speech!.stream({ identity:session.open.identity,completionID,text }, async (pcm,duration) => {
			if (session.pendingTerminal || session.terminal || session.speechFlow!.cancelled) return;
			if (pcm.byteLength > VOICE_LIMITS.speechSegmentBytes || duration > VOICE_LIMITS.speechSegmentMilliseconds
				|| session.totalSpeechBytes + pcm.byteLength > VOICE_LIMITS.speechBytes || session.totalSpeechMilliseconds + duration > VOICE_LIMITS.speechMilliseconds) throw new VoiceSessionContractError("speech_bounds_exceeded");
			const deadline = Date.now() + 30_000;
			while (session.speechFlow!.availableSegmentSlots < 1 && !session.speechFlow!.cancelled) {
				if (Date.now() >= deadline) throw new VoiceSessionContractError("speech_backpressure_timeout");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			if (session.pendingTerminal || session.terminal || session.speechFlow!.cancelled) return;
			this.transaction(session, () => {
				if (session.pendingTerminal || session.terminal || session.speechFlow!.cancelled) return;
				const segment = session.speechFlow!.highestSegmentSequence + 1;
				if (segment === 1) this.markTiming(session, "speech_first_segment");
				if (session.events.length >= VOICE_LIMITS.serverEvents - 2) throw new VoiceSessionContractError("server_event_bounds_exceeded");
				const event = validateVoiceServerEvent(this.makeEvent(session,"assistant_speech_segment",{ completion_id:completionID,speech_stream_id:streamID,speech_segment_id:`${streamID}-${segment}`,speech_segment_sequence:segment,speech_audio:Buffer.from(pcm).toString("base64"),speech_duration_milliseconds:duration }), session.open.identity);
				session.speechFlow!.claim(event); session.events.push(event); session.totalSpeechBytes += pcm.byteLength; session.totalSpeechMilliseconds += duration;
			});
			});
		} catch (error) {
			if (error instanceof VoiceSessionContractError) throw error;
			throw new VoiceSessionContractError("speech_provider_failed");
		}
		if (session.pendingTerminal || session.terminal || session.speechFlow!.cancelled) return;
		if (session.speechFlow!.highestSegmentSequence < 1) throw new VoiceSessionContractError("speech_empty");
		this.transaction(session, () => {
			this.markTiming(session, "speech_completed");
			this.emit(session,"assistant_speech_completed",{ completion_id:completionID,speech_stream_id:streamID,final_speech_segment_sequence:session.speechFlow!.highestSegmentSequence });
		});
	}
	private canEmitStreamingSnapshot(session: RuntimeSession, candidateTextBytes: number): boolean {
		const persistedTextBytes = session.events.reduce((sum, event) => sum + (event.text ? Buffer.byteLength(event.text) : 0), 0);
		if (persistedTextBytes + candidateTextBytes + 2 * VOICE_LIMITS.textBytes > VOICE_SESSION_PERSISTED_TEXT_BYTES) return false;
		const remainingClientSequences = VOICE_LIMITS.clientEvents - session.input.acknowledgedClientSequence;
		const futureInputAcknowledgements = Math.ceil(remainingClientSequences / this.inputWindow);
		const futureSpeechEvents = session.open.configuration.speech_mode === "progressive_audio"
			? VOICE_LIMITS.speechSegments : 0;
		const reservedLifecycleEvents = 16;
		return session.events.length + futureInputAcknowledgements + futureSpeechEvents + reservedLifecycleEvents
			< VOICE_LIMITS.serverEvents;
	}
	private restore(record: StoredVoiceSession): RuntimeSession {
		return {
			open: record.open,
			input: new VoiceInputLedger(record.open.identity, record.input),
			transcription: { append() {}, finish() {}, cancel() {} },
			events: record.events,
			phase: record.phase as RuntimeSession["phase"],
			completionID: record.completion_id,
			canonicalDispatch: record.canonical_dispatch,
			streamID: record.speech_stream_id,
			speechFlow: record.speech_flow && record.completion_id && record.speech_stream_id
				? new VoiceSpeechFlowLedger(record.open.identity, record.completion_id, record.speech_stream_id, record.speech_flow)
				: undefined,
			totalSpeechBytes: record.total_speech_bytes,
			totalSpeechMilliseconds: record.total_speech_milliseconds,
			partialText: record.partial_text,
			finalSegments: [...(record.final_segments ?? [])],
			finalText: record.final_text,
			terminal: record.terminal,
			voiceReceipts: pruneVoiceReceipts(
				record.voice_receipts ?? [],
				this.receiptNow(),
				this.maximumReceiptsPerSession,
			),
			timing: validateVoiceSessionTiming(record.timing ?? []),
			timingAnchorMilliseconds: this.timingNow(),
			timingBaseElapsedMilliseconds: record.timing?.at(-1)?.elapsed_milliseconds ?? 0,
			publishedTimingOrdinal: record.timing?.length ?? 0,
			recordingIngestionMode: "paced_realtime",
			recordingPacingCancellations: new Set(),
			work: Promise.resolve(),
		};
	}
	private recordFor(session: RuntimeSession): StoredVoiceSession {
		return {
			version: 3, open: session.open, input: session.input.checkpoint(), events: [...session.events],
			phase: session.phase, completion_id: session.completionID, canonical_dispatch:session.canonicalDispatch, speech_stream_id: session.streamID,
			speech_flow: session.speechFlow?.checkpoint(), total_speech_bytes: session.totalSpeechBytes,
			total_speech_milliseconds: session.totalSpeechMilliseconds, partial_text: session.partialText,
			final_segments: [...session.finalSegments], final_text: session.finalText, terminal: session.terminal,
			voice_receipts: [...session.voiceReceipts], timing: [...session.timing],
			updated_at: new Date().toISOString(),
		};
	}
	private restoreRecord(session: RuntimeSession, record: StoredVoiceSession): void {
		session.input = new VoiceInputLedger(record.open.identity, record.input);
		session.events = [...record.events]; session.phase = record.phase as RuntimeSession["phase"];
		session.completionID = record.completion_id; session.canonicalDispatch = record.canonical_dispatch; session.streamID = record.speech_stream_id;
		session.speechFlow = record.speech_flow && record.completion_id && record.speech_stream_id
			? new VoiceSpeechFlowLedger(record.open.identity, record.completion_id, record.speech_stream_id, record.speech_flow) : undefined;
		session.totalSpeechBytes = record.total_speech_bytes; session.totalSpeechMilliseconds = record.total_speech_milliseconds;
		session.partialText = record.partial_text; session.finalSegments = [...(record.final_segments ?? [])]; session.finalText = record.final_text; session.terminal = record.terminal;
		session.voiceReceipts = [...(record.voice_receipts ?? [])];
		session.timing = validateVoiceSessionTiming(record.timing ?? []);
		session.timingBaseElapsedMilliseconds = session.timing.at(-1)?.elapsed_milliseconds ?? 0;
		session.timingAnchorMilliseconds = this.timingNow();
		session.publishedTimingOrdinal = Math.min(session.publishedTimingOrdinal, session.timing.length);
	}
	private stateToken(record: StoredVoiceSession): string {
		return JSON.stringify({ input:record.input,event_count:record.events.length,phase:record.phase,completion_id:record.completion_id,canonical_dispatch:record.canonical_dispatch,speech_stream_id:record.speech_stream_id,speech_flow:record.speech_flow,total_speech_bytes:record.total_speech_bytes,total_speech_milliseconds:record.total_speech_milliseconds,partial_text:record.partial_text,final_segments:record.final_segments,final_text:record.final_text,terminal:record.terminal,voice_receipts:record.voice_receipts,timing:record.timing });
	}
	private transaction<T>(session: RuntimeSession, work: () => T): T {
		if (this.transactions.has(session)) return work();
		const snapshot = this.recordFor(session);
		this.transactions.add(session);
		try {
			const result = work();
			const current = this.recordFor(session);
			const before = this.stateToken(snapshot);
			const after = this.stateToken(current);
			if (result !== false && before !== after) this.persist(session);
			return result;
		} catch (error) {
			if (error instanceof VoiceSessionDurabilityUncertainError) {
				this.quarantinedSessionIDs.add(session.open.identity.session_id);
				this.sessions.delete(session.open.identity.session_id);
				this.cancelRecordingPacing(session);
				try { session.transcription.cancel(); } catch { /* fail-closed cleanup */ }
				try { this.options.speech?.cancel(session.open.identity, session.completionID ?? "durability-uncertain"); } catch { /* fail-closed cleanup */ }
				throw error;
			}
			this.restoreRecord(session, snapshot);
			throw error;
		} finally { this.transactions.delete(session); }
	}
	private markTiming(session: RuntimeSession, stage: VoiceSessionTimingStage): void {
		if (session.terminal && stage !== "terminal_persisted") return;
		if (session.timing.some((record) => record.stage === stage)
			|| session.timing.length >= VOICE_SESSION_TIMING_MAXIMUM_RECORDS) return;
		const now = this.timingNow();
		const prior = session.timing.at(-1)?.elapsed_milliseconds ?? 0;
		const elapsed = Math.max(
			prior,
			Math.floor(session.timingBaseElapsedMilliseconds
				+ Math.max(0, now - session.timingAnchorMilliseconds)),
		);
		session.timing.push({
			version: VOICE_SESSION_TIMING_VERSION,
			stage,
			ordinal: session.timing.length + 1,
			elapsed_milliseconds: elapsed,
		});
		if (!this.transactions.has(session)) this.persist(session);
	}
	private publishTimingDiagnostics(session: RuntimeSession): void {
		const pending = session.timing.filter((record) => record.ordinal > session.publishedTimingOrdinal);
		for (const record of pending) {
			const diagnostic: VoiceSessionTimingDiagnostic = {
				...record,
				session_correlation: voiceSessionTimingCorrelation(session.open.identity.session_id),
				runtime_identity: this.runtimeIdentity,
				source_identity: this.sourceIdentity,
			};
			try { this.options.onTimingDiagnostic?.(diagnostic); }
			catch { /* diagnostics never change voice custody or canonical work */ }
			session.publishedTimingOrdinal = record.ordinal;
		}
	}
	private persist(session: RuntimeSession): void {
		const record = this.recordFor(session);
		const evicted = this.options.store?.write(record);
		if (this.options.store && (record.canonical_dispatch || record.terminal)) {
			try { this.options.store.replay.synchronize(record); }
			catch (error) {
				throw new VoiceSessionDurabilityUncertainError(
					`Voice replay custody synchronization failed: ${error instanceof Error ? error.message : "unknown error"}`
				);
			}
		}
		this.publishTimingDiagnostics(session);
		for (const sessionID of evicted ?? []) {
			const candidate = this.sessions.get(sessionID);
			if (candidate?.terminal) this.sessions.delete(sessionID);
		}
	}
	private runDeferredCleanup(session:RuntimeSession, cleanup:"none"|"transcription"|"speech"):void {
		if (cleanup === "transcription") { try { session.transcription.cancel(); } catch { /* best-effort after terminal commit */ } }
		if (cleanup === "speech") { try { this.options.speech?.cancel(session.open.identity, session.completionID ?? "failed-before-completion"); } catch { /* best-effort after terminal commit */ } }
	}
	private commitFailureTerminal(session: RuntimeSession, code:string, retryable:boolean, cleanup:"none"|"transcription"|"speech"="none"): void {
		try { this.transaction(session, () => this.fail(session, code, retryable)); session.pendingTerminal = undefined; }
		catch (error) {
			session.pendingTerminal = { code, retryable, cleanup };
			this.cancelRecordingPacing(session);
			throw error;
		}
		this.runDeferredCleanup(session, cleanup);
	}
	private reconcilePendingTerminal(session: RuntimeSession): void {
		const pending = session.pendingTerminal; if (!pending) return;
		if (session.terminal) { session.pendingTerminal = undefined; this.runDeferredCleanup(session, pending.cleanup); return; }
		this.commitFailureTerminal(session, pending.code, pending.retryable, pending.cleanup);
	}
	private fail(session: RuntimeSession, code: string, retryable: boolean): void { if (!session.terminal) this.emitTerminal(session,"error",{ error_code:isSafeVoiceIdentifier(code)?code:"voice_session_failed",retryable }); }
	private emitTerminal(session: RuntimeSession, kind: "completed"|"cancelled"|"error", fields: Partial<VoiceServerEvent>): void {
		if (session.terminal) return;
		this.markTiming(session, "terminal_persisted");
		session.terminal = true;
		session.phase = "terminal";
		this.emit(session, kind, fields);
		// Defer cancellation until the enclosing durable transaction has either
		// committed or restored its snapshot. A rolled-back terminal must not
		// irreversibly stop an otherwise resumable recording ingestion.
		queueMicrotask(() => {
			if (session.terminal) this.cancelRecordingPacing(session);
		});
	}
	private emit(session: RuntimeSession, kind: VoiceServerEvent["kind"], fields: Partial<VoiceServerEvent>): VoiceServerEvent {
		if (session.events.length >= VOICE_LIMITS.serverEvents) throw new VoiceSessionContractError("server_event_bounds_exceeded");
		if (typeof fields.text === "string") {
			const existingTextBytes = session.events.reduce((sum, event) => sum + (event.text ? Buffer.byteLength(event.text) : 0), 0);
			if (existingTextBytes + Buffer.byteLength(fields.text) > VOICE_SESSION_PERSISTED_TEXT_BYTES) throw new VoiceSessionContractError("text_event_bounds_exceeded");
		}
		const event = validateVoiceServerEvent(this.makeEvent(session,kind,fields), session.open.identity);
		session.events.push(event);
		if (!this.transactions.has(session)) this.persist(session);
		return event;
	}
	private makeEvent(session: RuntimeSession, kind: VoiceServerEvent["kind"], fields: Partial<VoiceServerEvent>): VoiceServerEvent { return { version:VOICE_SESSION_VERSION,identity:session.open.identity,sequence:session.events.length+1,event_id:`voice-event-${session.events.length+1}-${randomUUID()}`,kind,...fields }; }
}

function waitForRecordingDuration(durationMilliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		timer = setTimeout(finish, durationMilliseconds);
		signal.addEventListener("abort", finish, { once: true });
	});
}
