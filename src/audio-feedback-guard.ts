import { randomUUID } from "node:crypto";

const DEFAULT_COOLDOWN_MS = 1600;
const DEFAULT_RECENT_WINDOW_MS = 45_000;
const DEFAULT_SIMILARITY_THRESHOLD = 0.72;
const ACTIVE_SIMILARITY_THRESHOLD = 0.45;
const COOLDOWN_SIMILARITY_THRESHOLD = 0.52;
const DEFAULT_MAX_ACTIVE_MS = 60_000;

interface AssistantSpeechRecord {
	id: string;
	text: string;
	normalized: string;
	startedAt: number;
	activeUntil: number;
	cooldownUntil: number;
	expiresAt: number;
}

export interface AssistantSpeechOptions {
	now?: number;
	cooldownMs?: number;
	recentWindowMs?: number;
	maxActiveMs?: number;
}

export interface AssistantSpeechSuppressOptions {
	now?: number;
	similarityThreshold?: number;
}

export interface AssistantSpeechSuppressDecision {
	suppress: boolean;
	reason?: "active_assistant_speech_echo" | "cooldown_assistant_speech_echo" | "recent_assistant_speech_echo" | "low_confidence_speech_fragment";
	similarity?: number;
	matchedText?: string;
	bargeInConfidence?: number;
}

export type AssistantSpeechGuardPhase = "idle" | "active" | "cooldown";

export interface AssistantSpeechGuardStateRecord {
	id: string;
	textPreview: string;
	startedAt: number;
	activeUntil: number;
	cooldownUntil: number;
	expiresAt: number;
	active: boolean;
	coolingDown: boolean;
}

export interface AssistantSpeechGuardState {
	active: boolean;
	phase: AssistantSpeechGuardPhase;
	now: number;
	activeUntil?: number;
	cooldownUntil?: number;
	recent: AssistantSpeechGuardStateRecord[];
}

const records: AssistantSpeechRecord[] = [];

function nowMs(options?: { now?: number }): number {
	return options?.now ?? Date.now();
}

function cooldownMs(options?: AssistantSpeechOptions): number {
	return options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
}

function recentWindowMs(options?: AssistantSpeechOptions): number {
	return options?.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
}

function maxActiveMs(options?: AssistantSpeechOptions): number {
	return options?.maxActiveMs ?? DEFAULT_MAX_ACTIVE_MS;
}

function normalizeSpeechText(text: string): string {
	return text
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function compact(text: string): string {
	return text.replace(/\s+/g, "");
}

function words(text: string): string[] {
	return text ? text.split(" ") : [];
}

function cleanup(now: number): void {
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (record.expiresAt < now && record.activeUntil < now && record.cooldownUntil < now) {
			records.splice(i, 1);
		}
	}
}

function levenshteinSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (!a || !b) return 0;
	if (Math.max(a.length, b.length) > 300) return 0;

	const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	const current = new Array<number>(b.length + 1);

	for (let i = 1; i <= a.length; i++) {
		current[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				current[j - 1] + 1,
				previous[j] + 1,
				previous[j - 1] + cost,
			);
		}
		for (let j = 0; j <= b.length; j++) previous[j] = current[j];
	}

	return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function wordLcsSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const previous = new Array<number>(b.length + 1).fill(0);
	const current = new Array<number>(b.length + 1).fill(0);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			current[j] = a[i - 1] === b[j - 1]
				? previous[j - 1] + 1
				: Math.max(previous[j], current[j - 1]);
		}
		for (let j = 0; j <= b.length; j++) previous[j] = current[j];
	}
	return previous[b.length] / Math.max(a.length, b.length);
}

function tokenJaccardSimilarity(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const left = new Set(a);
	const right = new Set(b);
	let intersection = 0;
	for (const word of left) {
		if (right.has(word)) intersection++;
	}
	const union = new Set([...left, ...right]).size;
	return union > 0 ? intersection / union : 0;
}

function bestMatch(text: string, now: number): { record: AssistantSpeechRecord; similarity: number } | null {
	let best: { record: AssistantSpeechRecord; similarity: number } | null = null;
	for (const record of records) {
		if (record.expiresAt < now) continue;
		const similarity = assistantSpeechSimilarity(text, record.normalized);
		if (!best || similarity > best.similarity) {
			best = { record, similarity };
		}
	}
	return best;
}

function activeOrCoolingRecord(now: number): { record: AssistantSpeechRecord; phase: "active" | "cooldown" } | null {
	const active = records.find((record) => record.activeUntil > now);
	if (active) return { record: active, phase: "active" };
	const cooling = records.find((record) => record.cooldownUntil > now);
	if (cooling) return { record: cooling, phase: "cooldown" };
	return null;
}

function bargeInConfidence(normalized: string, similarity: number): number {
	const parts = words(normalized);
	const first = parts[0] ?? "";
	const phrase = normalized;
	let score = 0;

	const interruptionWords = new Set(["stop", "wait", "pause", "cancel", "interrupt", "no", "actually", "hold"]);
	const commandWords = new Set(["open", "play", "set", "make", "create", "find", "search", "look", "click", "type", "show", "go", "send", "email"]);
	const questionWords = new Set(["what", "when", "where", "why", "how", "who", "can", "could", "would", "will", "do", "does", "did"]);

	if (interruptionWords.has(first)) score += 0.55;
	if (commandWords.has(first)) score += 0.35;
	if (questionWords.has(first)) score += 0.30;
	if (phrase.includes("noodle") || phrase.includes("troublemaker") || phrase.includes("clicky")) score += 0.20;
	if (parts.length >= 4) score += 0.12;
	if (parts.length >= 8) score += 0.12;

	// Clear acoustic difference from the assistant's last text is weak but real evidence
	// that the user is trying to barge in with a new intent.
	score += Math.max(0, 0.55 - similarity) * 0.45;
	if (similarity >= 0.55) score -= 0.30;
	if (similarity >= 0.72) score -= 0.40;

	return Math.max(0, Math.min(1, score));
}

function isLowConfidenceFragment(normalized: string, confidence: number): boolean {
	const parts = words(normalized);
	if (parts.length === 0) return false;
	if (confidence >= 0.45) return false;
	return parts.length <= 2;
}

function containedSimilarity(a: string, b: string): number {
	const left = compact(a);
	const right = compact(b);
	if (!left || !right) return 0;
	if (left.includes(right) || right.includes(left)) {
		return Math.min(left.length, right.length) / Math.max(left.length, right.length);
	}
	return 0;
}

export function assistantSpeechSimilarity(aText: string, bText: string): number {
	const a = normalizeSpeechText(aText);
	const b = normalizeSpeechText(bText);
	if (!a || !b) return 0;
	if (a === b) return 1;

	const aWords = words(a);
	const bWords = words(b);
	return Math.max(
		levenshteinSimilarity(compact(a), compact(b)),
		wordLcsSimilarity(aWords, bWords),
		tokenJaccardSimilarity(aWords, bWords),
		containedSimilarity(a, b),
	);
}

export function estimateSpeechActiveMs(text: string): number {
	const wordCount = Math.max(1, words(normalizeSpeechText(text)).length);
	const byWords = Math.ceil((wordCount / 2.6) * 1000) + 700;
	return Math.min(Math.max(byWords, 1200), 30_000);
}

export function beginAssistantSpeech(text: string, options: AssistantSpeechOptions = {}): string {
	const now = nowMs(options);
	cleanup(now);
	const id = randomUUID();
	const activeUntil = now + maxActiveMs(options);
	records.push({
		id,
		text,
		normalized: normalizeSpeechText(text),
		startedAt: now,
		activeUntil,
		cooldownUntil: activeUntil + cooldownMs(options),
		expiresAt: now + recentWindowMs(options),
	});
	return id;
}

export function holdAssistantSpeech(text: string, activeMs: number, options: AssistantSpeechOptions = {}): string {
	const now = nowMs(options);
	cleanup(now);
	const id = randomUUID();
	const activeUntil = now + Math.max(0, activeMs);
	records.push({
		id,
		text,
		normalized: normalizeSpeechText(text),
		startedAt: now,
		activeUntil,
		cooldownUntil: activeUntil + cooldownMs(options),
		expiresAt: now + recentWindowMs(options),
	});
	return id;
}

export function finishAssistantSpeech(id: string, options: AssistantSpeechOptions & { activeHoldMs?: number } = {}): void {
	const now = nowMs(options);
	cleanup(now);
	const record = records.find((candidate) => candidate.id === id);
	if (!record) return;
	const activeUntil = now + Math.max(0, options.activeHoldMs ?? 0);
	record.activeUntil = activeUntil;
	record.cooldownUntil = activeUntil + cooldownMs(options);
	record.expiresAt = Math.max(record.expiresAt, now + recentWindowMs(options));
}

export function shouldSuppressAssistantSpeechEcho(
	text: string,
	options: AssistantSpeechSuppressOptions = {},
): AssistantSpeechSuppressDecision {
	const now = nowMs(options);
	cleanup(now);
	const normalized = normalizeSpeechText(text);
	if (!normalized) return { suppress: false };

	const best = bestMatch(normalized, now);
	const phase = activeOrCoolingRecord(now);
	const similarity = best?.similarity ?? 0;
	const confidence = bargeInConfidence(normalized, similarity);

	if (phase) {
		const threshold = phase.phase === "active" ? ACTIVE_SIMILARITY_THRESHOLD : COOLDOWN_SIMILARITY_THRESHOLD;
		if (best && similarity >= threshold) {
			return {
				suppress: true,
				reason: phase.phase === "active" ? "active_assistant_speech_echo" : "cooldown_assistant_speech_echo",
				similarity,
				matchedText: best.record.text,
				bargeInConfidence: confidence,
			};
		}

		if (isLowConfidenceFragment(normalized, confidence)) {
			return {
				suppress: true,
				reason: "low_confidence_speech_fragment",
				similarity,
				matchedText: phase.record.text,
				bargeInConfidence: confidence,
			};
		}
	}

	const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
	if (best && best.similarity >= threshold) {
		return {
			suppress: true,
			reason: "recent_assistant_speech_echo",
			similarity: best.similarity,
			matchedText: best.record.text,
			bargeInConfidence: confidence,
		};
	}

	return { suppress: false, similarity, matchedText: best?.record.text, bargeInConfidence: confidence };
}

export function getAssistantSpeechGuardState(options: { now?: number } = {}): AssistantSpeechGuardState {
	const now = nowMs(options);
	cleanup(now);

	let phase: AssistantSpeechGuardPhase = "idle";
	const activeUntilValues: number[] = [];
	const cooldownUntilValues: number[] = [];
	const recent = records
		.filter((record) => record.expiresAt >= now || record.activeUntil >= now || record.cooldownUntil >= now)
		.map((record): AssistantSpeechGuardStateRecord => {
			const active = record.activeUntil > now;
			const coolingDown = !active && record.cooldownUntil > now;
			if (active) {
				phase = "active";
				activeUntilValues.push(record.activeUntil);
			}
			if (record.cooldownUntil > now) {
				cooldownUntilValues.push(record.cooldownUntil);
				if (phase === "idle") phase = "cooldown";
			}
			return {
				id: record.id,
				textPreview: record.text.length > 180 ? `${record.text.slice(0, 177)}...` : record.text,
				startedAt: record.startedAt,
				activeUntil: record.activeUntil,
				cooldownUntil: record.cooldownUntil,
				expiresAt: record.expiresAt,
				active,
				coolingDown,
			};
		});

	return {
		active: phase !== "idle",
		phase,
		now,
		activeUntil: activeUntilValues.length > 0 ? Math.max(...activeUntilValues) : undefined,
		cooldownUntil: cooldownUntilValues.length > 0 ? Math.max(...cooldownUntilValues) : undefined,
		recent,
	};
}

export function resetAssistantSpeechGuardForTests(): void {
	records.splice(0, records.length);
}
