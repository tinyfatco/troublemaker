import type { AssistantSpeechGuardPhase } from "./audio-feedback-guard.js";

export interface AssistantAudioGateInput {
	phase: AssistantSpeechGuardPhase;
	audioLevel: number;
	now?: number;
}

export interface AssistantAudioGateDecision {
	sendToStt: boolean;
	reason?: "assistant_speech_gate" | "barge_in_candidate";
	phase: AssistantSpeechGuardPhase;
	audioLevel: number;
}

export interface AssistantAudioGateOptions {
	activeBargeInLevel?: number;
	cooldownBargeInLevel?: number;
	sustainMs?: number;
	bargeInOpenMs?: number;
}

const DEFAULT_ACTIVE_BARGE_IN_LEVEL = 0.08;
const DEFAULT_COOLDOWN_BARGE_IN_LEVEL = 0.055;
const DEFAULT_SUSTAIN_MS = 240;
const DEFAULT_BARGE_IN_OPEN_MS = 2500;

export class AssistantAudioGate {
	private loudAudioStartedAt: number | null = null;
	private bargeInOpenUntil = 0;
	private readonly activeBargeInLevel: number;
	private readonly cooldownBargeInLevel: number;
	private readonly sustainMs: number;
	private readonly bargeInOpenMs: number;

	constructor(options: AssistantAudioGateOptions = {}) {
		this.activeBargeInLevel = options.activeBargeInLevel ?? DEFAULT_ACTIVE_BARGE_IN_LEVEL;
		this.cooldownBargeInLevel = options.cooldownBargeInLevel ?? DEFAULT_COOLDOWN_BARGE_IN_LEVEL;
		this.sustainMs = options.sustainMs ?? DEFAULT_SUSTAIN_MS;
		this.bargeInOpenMs = options.bargeInOpenMs ?? DEFAULT_BARGE_IN_OPEN_MS;
	}

	decide(input: AssistantAudioGateInput): AssistantAudioGateDecision {
		const now = input.now ?? Date.now();
		const audioLevel = Number.isFinite(input.audioLevel) ? Math.max(0, input.audioLevel) : 0;

		if (input.phase === "idle") {
			this.reset();
			return { sendToStt: true, phase: input.phase, audioLevel };
		}

		if (now < this.bargeInOpenUntil) {
			return { sendToStt: true, reason: "barge_in_candidate", phase: input.phase, audioLevel };
		}

		const threshold = input.phase === "active" ? this.activeBargeInLevel : this.cooldownBargeInLevel;
		if (audioLevel >= threshold) {
			if (this.loudAudioStartedAt === null) {
				this.loudAudioStartedAt = now;
			}
			if (now - this.loudAudioStartedAt >= this.sustainMs) {
				this.bargeInOpenUntil = now + this.bargeInOpenMs;
				this.loudAudioStartedAt = null;
				return { sendToStt: true, reason: "barge_in_candidate", phase: input.phase, audioLevel };
			}
		} else if (audioLevel < threshold * 0.65) {
			this.loudAudioStartedAt = null;
		}

		return { sendToStt: false, reason: "assistant_speech_gate", phase: input.phase, audioLevel };
	}

	reset(): void {
		this.loudAudioStartedAt = null;
		this.bargeInOpenUntil = 0;
	}
}

export function pcm16RmsLevel(buffer: Buffer): number {
	if (buffer.length < 2) return 0;
	const samples = Math.floor(buffer.length / 2);
	let sumSquares = 0;
	for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
		const sample = buffer.readInt16LE(offset) / 32768;
		sumSquares += sample * sample;
	}
	const rms = Math.sqrt(sumSquares / samples);
	return Number.isFinite(rms) ? rms : 0;
}
