import type {
	MomEvent,
	PlatformAdapter,
	RunResult,
	VoiceSessionNotice,
} from "./adapters/types.js";
import { normalizeRealtimeVoiceName } from "./realtime-voices.js";
import type { WorkspaceStore } from "./storage/workspace.js";

const IDENTITY_FILE = "IDENTITY.md";
const SETTINGS_FILE = "settings.json";
const MAX_WAKE_ALIASES = 8;
const MAX_WAKE_NAME_CHARS = 64;

export interface VoiceWakeConfiguration {
	primaryName: string | null;
	wakeNames: string[];
}

export interface WakePrefixMatch {
	wakeName: string;
	text: string;
}

export type SpokenVoiceControl =
	| { type: "close" }
	| { type: "voice_change"; requested?: string; voice: string | null; reason?: "unsupported" | "ambiguous" };

export type VoiceCommitDisposition =
	| "ignored"
	| "control"
	| "pending_input"
	| "stop"
	| "queued";

export interface FirstClassVoiceContractOptions {
	workspace: WorkspaceStore;
	isCanonicalBusy: () => boolean;
	runCanonicalTurn: (event: MomEvent, adapter: PlatformAdapter) => Promise<RunResult | void>;
	resolvePendingInput: (channelId: string, text: string) => boolean;
	handleStop: (channelId: string, adapter: PlatformAdapter, event?: MomEvent) => Promise<void>;
	onError?: (message: string, error: unknown) => void;
}

interface ExplicitVoiceSessionState {
	open: boolean;
	wake: VoiceWakeConfiguration;
}

interface QueuedVoiceTurn {
	key: string;
	event: MomEvent;
	adapter: PlatformAdapter;
}

interface AttentionDecision {
	deliver?: string;
	notices: VoiceSessionNotice[];
	control?: SpokenVoiceControl;
}

/**
 * One resident, workspace-scoped contract for all explicit voice transports.
 * It owns attention state and the global FIFO; adapters own only audio I/O.
 */
export class FirstClassVoiceContract {
	private readonly options: FirstClassVoiceContractOptions;
	private readonly sessions = new Map<string, ExplicitVoiceSessionState>();
	private readonly queue: QueuedVoiceTurn[] = [];
	private draining = false;

	constructor(options: FirstClassVoiceContractOptions) {
		this.options = options;
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	get hasPendingWork(): boolean {
		return this.draining || this.queue.length > 0;
	}

	commit(event: MomEvent, adapter: PlatformAdapter): VoiceCommitDisposition {
		this.interruptOutput(adapter, event);

		const rawText = event.text.trim();
		if (this.options.resolvePendingInput(event.channel, rawText)) {
			return "pending_input";
		}
		if (rawText.toLowerCase() === "stop") {
			this.clearPendingTurns();
			void this.options.handleStop(event.channel, adapter, event).catch((error) => {
				this.reportError("Voice stop command failed", error);
			});
			return "stop";
		}

		const key = voiceSessionKey(event, adapter);
		const state = this.sessionState(key);
		const decision = decideVoiceAttention(state, event.text);
		for (const notice of decision.notices) this.notify(adapter, event, notice);

		if (decision.control?.type === "close") {
			state.open = false;
			this.dropQueuedSession(key);
			this.notify(adapter, event, { type: "session_closed" });
			return "control";
		}

		if (decision.control?.type === "voice_change") {
			this.handleVoiceChange(event, adapter, decision.control);
			return "control";
		}

		if (decision.deliver === undefined) {
			return decision.notices.some((notice) => notice.type === "session_opened") ? "control" : "ignored";
		}

		const canonicalEvent: MomEvent = {
			...event,
			text: decision.deliver,
			rawText: decision.deliver,
			directlyAddressed: true,
		};

		if (this.options.resolvePendingInput(canonicalEvent.channel, canonicalEvent.text)) {
			return "pending_input";
		}

		if (canonicalEvent.text.toLowerCase().trim() === "stop") {
			this.clearPendingTurns();
			void this.options.handleStop(canonicalEvent.channel, adapter, canonicalEvent).catch((error) => {
				this.reportError("Voice stop command failed", error);
			});
			return "stop";
		}

		this.queue.push({ key, event: canonicalEvent, adapter });
		this.notify(adapter, canonicalEvent, { type: "turn_queued", position: this.queue.length });
		this.drainAtSafeBoundary();
		return "queued";
	}

	/** Called when any canonical run slot has fully released. */
	notifyCanonicalBoundary(): void {
		this.drainAtSafeBoundary();
	}

	/** Transport disconnect: forget attention state and discard that session's queued turns. */
	closeTransportSession(sessionId: string, adapter: PlatformAdapter): number {
		const key = voiceSessionKey({ channel: "", sessionId }, adapter);
		this.sessions.delete(key);
		return this.dropQueuedSession(key);
	}

	/** Stop is global control-plane work, so its queue cancellation is global too. */
	clearPendingTurns(): number {
		const count = this.queue.length;
		this.queue.splice(0);
		return count;
	}

	private sessionState(key: string): ExplicitVoiceSessionState {
		let state = this.sessions.get(key);
		if (!state) {
			state = {
				open: false,
				wake: readVoiceWakeConfiguration(this.options.workspace),
			};
			this.sessions.set(key, state);
		}
		return state;
	}

	private drainAtSafeBoundary(): void {
		if (this.draining || this.queue.length === 0 || this.options.isCanonicalBusy()) return;
		const next = this.queue.shift()!;
		this.draining = true;
		void this.options.runCanonicalTurn(next.event, next.adapter)
			.catch((error) => this.reportError("Queued voice turn failed", error))
			.finally(() => {
				this.draining = false;
				this.drainAtSafeBoundary();
			});
	}

	private handleVoiceChange(
		event: MomEvent,
		adapter: PlatformAdapter,
		control: Extract<SpokenVoiceControl, { type: "voice_change" }>,
	): void {
		if (!control.voice) {
			this.notify(adapter, event, {
				type: "voice_change_rejected",
				...(control.requested ? { requested: control.requested } : {}),
				reason: control.reason ?? "unsupported",
			});
			return;
		}

		try {
			writeConfiguredRealtimeVoice(this.options.workspace, control.voice);
			adapter.applyRealtimeVoice?.(event, control.voice);
			this.notify(adapter, event, { type: "voice_changed", voice: control.voice });
		} catch (error) {
			this.reportError("Could not persist spoken Realtime voice change", error);
			this.notify(adapter, event, {
				type: "voice_change_rejected",
				requested: control.requested,
				reason: "settings_write_failed",
			});
		}
	}

	private interruptOutput(adapter: PlatformAdapter, event: MomEvent): void {
		try {
			adapter.interruptOutputAudio?.(event);
		} catch (error) {
			this.reportError("Voice audio interruption hook failed", error);
		}
	}

	private notify(adapter: PlatformAdapter, event: MomEvent, notice: VoiceSessionNotice): void {
		try {
			adapter.handleVoiceSessionNotice?.(event, notice);
		} catch (error) {
			this.reportError("Voice session notice hook failed", error);
		}
	}

	private dropQueuedSession(key: string): number {
		let dropped = 0;
		for (let index = this.queue.length - 1; index >= 0; index--) {
			if (this.queue[index]?.key !== key) continue;
			this.queue.splice(index, 1);
			dropped++;
		}
		return dropped;
	}

	private reportError(message: string, error: unknown): void {
		this.options.onError?.(message, error);
	}
}

export function readVoiceWakeConfiguration(workspace: WorkspaceStore): VoiceWakeConfiguration {
	const primaryName = parseIdentityName(workspace.readText(IDENTITY_FILE));
	const settings = readSettingsRecord(workspace);
	const voiceSettings = isRecord(settings.voice) ? settings.voice : {};
	const aliases = normalizeVoiceWakeAliases(voiceSettings.aliases);
	const wakeNames = dedupeWakeNames([...(primaryName ? [primaryName] : []), ...aliases]);
	return { primaryName, wakeNames };
}

export function normalizeVoiceWakeAliases(value: unknown): string[] {
	const values = Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: typeof value === "string"
			? value.split(",")
			: [];
	return dedupeWakeNames(
		values
			.map(cleanWakeName)
			.filter((entry): entry is string => Boolean(entry)),
	).slice(0, MAX_WAKE_ALIASES);
}

export function parseIdentityName(identity: string | null | undefined): string | null {
	if (!identity) return null;
	for (const line of identity.split(/\r?\n/)) {
		const withoutBullet = line.trim().replace(/^[-*+]\s+/, "");
		const match = withoutBullet.match(/^(?:\*\*)?name(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$/i);
		if (!match) continue;
		const value = cleanWakeName(match[1] ?? "");
		return value || null;
	}
	return null;
}

export function matchWakePrefix(text: string, wakeNames: string[]): WakePrefixMatch | null {
	const candidates = [...wakeNames].sort((a, b) => b.length - a.length);
	for (const wakeName of candidates) {
		const namePattern = wakeName.split(/\s+/).map(escapeRegExp).join("\\s+");
		const pattern = new RegExp(
			`^\\s*hey(?:\\s+|\\s*[,.:;!?-]+\\s*)${namePattern}(?=$|[\\s,.:;!?\\u2013\\u2014-])`,
			"iu",
		);
		const match = pattern.exec(text);
		if (!match) continue;
		const remaining = text
			.slice(match[0].length)
			.replace(/^[\s,.:;!?()\[\]{}"'`\u2013\u2014-]+/u, "")
			.trim();
		return { wakeName, text: remaining };
	}
	return null;
}

export function parseSpokenVoiceControl(text: string): SpokenVoiceControl | null {
	const compact = text.trim().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
	if (!compact) return null;
	const lower = compact.toLowerCase();
	if (
		/^(?:close|end|disable)(?: the)? voice(?: session| mode)?$/.test(lower)
		|| /^turn off(?: the)? voice(?: session| mode)?$/.test(lower)
		|| /^turn(?: the)? voice(?: session| mode)? off$/.test(lower)
		|| /^voice(?: session| mode)? off$/.test(lower)
		|| /^stop(?: the)? voice(?: session| mode)?$/.test(lower)
		|| /^stop listening$/.test(lower)
	) {
		return { type: "close" };
	}

	let requested: string | undefined;
	const changeMatch = compact.match(/^(?:change|switch|set)(?: (?:the|my))?(?: realtime)? voice(?: to)?(?: (.+))?$/i)
		?? compact.match(/^(?:change|switch|set)(?: (?:the|my))?(?: realtime)?(?: voice)? to (.+?)(?: voice)?$/i)
		?? compact.match(/^set (.+?) as(?: the)?(?: realtime)? voice$/i);
	const useMatch = compact.match(/^use (.+?)(?: as)?(?: the)?(?: realtime)? voice$/i);
	if (changeMatch) requested = changeMatch[1]?.trim();
	else if (useMatch) requested = useMatch[1]?.trim();
	else return null;

	if (!requested || /\b(?:or|and)\b|[,/]/i.test(requested)) {
		return { type: "voice_change", requested, voice: null, reason: "ambiguous" };
	}
	const cleaned = requested.replace(/^[`'"\s]+|[`'"\s]+$/g, "");
	const voice = normalizeRealtimeVoiceName(cleaned);
	return {
		type: "voice_change",
		requested: cleaned || requested,
		voice,
		...(voice ? {} : { reason: "unsupported" as const }),
	};
}

export function readConfiguredRealtimeVoice(workspace: WorkspaceStore): string | null {
	return normalizeRealtimeVoiceName(readSettingsRecord(workspace).realtimeVoice);
}

export function writeConfiguredRealtimeVoice(workspace: WorkspaceStore, voice: string): void {
	const normalized = normalizeRealtimeVoiceName(voice);
	if (!normalized) throw new Error(`Unsupported Realtime voice: ${voice}`);
	const settings = readSettingsRecord(workspace);
	settings.realtimeVoice = normalized;
	workspace.writeText(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

function decideVoiceAttention(state: ExplicitVoiceSessionState, rawText: string): AttentionDecision {
	const notices: VoiceSessionNotice[] = [];
	let text = rawText.trim();
	const wake = matchWakePrefix(rawText, state.wake.wakeNames);

	if (!state.open) {
		if (!wake) {
			notices.push({
				type: "wake_required",
				reason: state.wake.wakeNames.length === 0 ? "wake_name_unconfigured" : "wake_phrase_missing",
			});
			return { notices };
		}
		state.open = true;
		text = wake.text;
		notices.push({ type: "session_opened", wakeName: wake.wakeName });
	} else if (wake) {
		text = wake.text;
	}

	if (!text) return { notices };
	const control = parseSpokenVoiceControl(text);
	if (control) return { notices, control };
	return { notices, deliver: text };
}

function voiceSessionKey(event: Pick<MomEvent, "channel" | "sessionId">, adapter: PlatformAdapter): string {
	const sessionId = event.sessionId?.trim() || event.channel || "default";
	return `${adapter.name}:${sessionId}`;
}

function cleanWakeName(value: string): string | null {
	const cleaned = value
		.trim()
		.replace(/^(?:\*\*|__|[_*`"'])+|(?:\*\*|__|[_*`"'])+$/g, "")
		.trim();
	if (!cleaned || cleaned.length > MAX_WAKE_NAME_CHARS || /[\r\n]/.test(cleaned)) return null;
	if (/^(?:tbd|unknown|none|n\/a|pick something)/i.test(cleaned)) return null;
	return cleaned;
}

function dedupeWakeNames(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(value);
	}
	return result;
}

function readSettingsRecord(workspace: WorkspaceStore): Record<string, unknown> {
	const raw = workspace.readText(SETTINGS_FILE);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
