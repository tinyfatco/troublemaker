/**
 * Context management for mom.
 *
 * Provides:
 * - MomSettingsManager: Simple settings for mom (compaction, retry, model preferences)
 *
 * The sync layer (syncLogToSessionManager) was removed in the unified awareness
 * rearchitecture. The runner is now the sole writer to context.jsonl — no sync needed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { SettingsStore } from "./storage/settings.js";

// ============================================================================
// MomSettingsManager - Simple settings for mom
// ============================================================================

export interface MomCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface MomRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

export interface MomSpontaneitySettings {
	enabled: boolean;
	level: 1 | 2 | 3 | 4 | 5;
	spontaneity: number; // 0-1, scales jitter window
	intervalMinutes: number;
	quietHours: { start: string; end: string };
	timezone?: string; // IANA timezone, defaults to system
}

export type FollowUpPreset = "default" | "custom";

export interface MomFollowUpSettings {
	enabled: boolean;
	preset: FollowUpPreset;
	/** Agent-global idle checkpoints after the latest eligible completed wake. */
	intervalsMinutes: number[];
}

export type VerbosityLevel = boolean | "messages-only";

export interface MomVerboseSettings {
	default?: VerbosityLevel;
	[platform: string]: VerbosityLevel | Record<string, VerbosityLevel> | undefined;
}

export type SlackResponsePlacement = "thread" | "channel";
export type TeamsResponsePlacement = SlackResponsePlacement;
export type ToolStreamingMode = "off" | "important" | "all";
export type WorkingStreamPresentation = "split" | "condensed";
export type WorkingOutputMode = "off" | "follow" | "fixed";

export interface WorkingOutputTarget {
	platform: "slack" | "teams" | "mattermost" | "rocket-chat" | "zulip";
	channelId: string;
}

export interface MomWorkingOutputSettings {
	mode: WorkingOutputMode;
	target?: WorkingOutputTarget;
}

export type SlackToolStreamPresentation = WorkingStreamPresentation;
export type TeamsToolStreamPresentation = WorkingStreamPresentation;
export type DiscordToolStreamPresentation = WorkingStreamPresentation;
export type VoiceWebhookInputMode = "interrupt" | "steer";
export const DEFAULT_SLACK_TOOL_STREAM_WINDOW_MINUTES = 1;
export const MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES = 1;
export const MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES = 60;
export const DEFAULT_DISCORD_TOOL_STREAM_WINDOW_MINUTES = DEFAULT_SLACK_TOOL_STREAM_WINDOW_MINUTES;
export const MIN_DISCORD_TOOL_STREAM_WINDOW_MINUTES = MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES;
export const MAX_DISCORD_TOOL_STREAM_WINDOW_MINUTES = MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES;

export interface MomSlackSettings {
	/** Place the whole inbound Slack turn in its thread or at channel top level. */
	responsePlacement?: SlackResponsePlacement;
	/** Surface safe tool labels while ordinary harness output remains quiet. */
	toolStreaming?: ToolStreamingMode;
	/** Keep one edited working message or split it at event-driven time boundaries. */
	toolStreamPresentation?: SlackToolStreamPresentation;
	/** Rolling minutes per edited working message in split presentation. */
	toolStreamWindowMinutes?: number;
	/** Render selected tool lifecycle with Slack's native streaming task UI. */
	nativeProgress?: boolean;
}

export interface MomDiscordSettings {
	/** Surface safe tool labels while ordinary harness output remains quiet. */
	toolStreaming?: ToolStreamingMode;
	/** Keep one edited working message or split it at event-driven time boundaries. */
	toolStreamPresentation?: DiscordToolStreamPresentation;
	/** Rolling minutes per edited working message in split presentation. */
	toolStreamWindowMinutes?: number;
}

export interface MomTeamsSettings {
	/** Place channel responses in the originating thread or at channel top level. */
	responsePlacement?: TeamsResponsePlacement;
	/** Surface safe tool labels while ordinary harness output remains quiet. */
	toolStreaming?: ToolStreamingMode;
	/** Keep one edited working message or split it at event-driven time boundaries. */
	toolStreamPresentation?: TeamsToolStreamPresentation;
	/** Rolling minutes per edited working message in split presentation. */
	toolStreamWindowMinutes?: number;
	/** Channels that remain available but do not schedule ambient evaluation. */
	mentionsOnlyConversationIds?: string[];
}

export interface MomMattermostSettings {
	/**
	 * Channels that remain readable and mention-addressable without scheduling
	 * ambient evaluation for every ordinary post.
	 */
	mentionsOnlyChannelIds?: string[];
}

export type MomSpeakBackend = "macos-say" | "command" | "http" | "elevenlabs" | "sag" | "noop" | "disabled";

export interface MomSpeakSettings {
	enabled?: boolean;
	backend?: MomSpeakBackend;
	voice?: string;
	rate?: number;
	maxChars?: number;
	command?: string;
	url?: string;
	headers?: Record<string, string>;
	token?: string;
	tokenEnv?: string;
	tokenHeader?: string;
	tokenPrefix?: string;
	sag?: {
		command?: string;
		modelId?: string;
		shell?: string;
	};
	elevenlabs?: {
		apiKey?: string;
		apiKeyEnv?: string;
		voiceId?: string;
		modelId?: string;
		outputFormat?: string;
		playerCommand?: string;
	};
}

export interface MomVoiceSettings {
	/** Optional wake names in addition to the Name field in IDENTITY.md. */
	aliases?: string[];
	/** Route busy webhook transcripts by replacing the active run or steering it. */
	webhookInputMode?: VoiceWebhookInputMode;
}

export interface MomComputerSettings {
	/** Let the macOS Computer client automatically speak assistant responses. */
	macosAutoSpeech?: boolean;
}

export const DEFAULT_MACOS_COMPUTER_AUTO_SPEECH = true;

export function resolveMacOSComputerAutoSpeech(settings: unknown): boolean {
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		return DEFAULT_MACOS_COMPUTER_AUTO_SPEECH;
	}
	const computer = (settings as Record<string, unknown>).computer;
	if (!computer || typeof computer !== "object" || Array.isArray(computer)) {
		return DEFAULT_MACOS_COMPUTER_AUTO_SPEECH;
	}
	const value = (computer as Record<string, unknown>).macosAutoSpeech;
	return typeof value === "boolean" ? value : DEFAULT_MACOS_COMPUTER_AUTO_SPEECH;
}

export interface MomSettings {
	defaultProvider?: string;
	defaultModel?: string;
	/** Exclusive desktop tool provider: native Cua, legacy Codex MCP rollback, or disabled. */
	computerMode?: "cua" | "codex-mcp" | "off";
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	realtimeVoice?: string;
	voice?: MomVoiceSettings;
	computer?: MomComputerSettings;
	verbose?: VerbosityLevel | MomVerboseSettings;
	/** Route sanitized working/tool labels independently from user-visible delivery. */
	workingOutput?: MomWorkingOutputSettings;
	slack?: MomSlackSettings;
	teams?: MomTeamsSettings;
	mattermost?: MomMattermostSettings;
	discord?: MomDiscordSettings;
	compaction?: Partial<MomCompactionSettings>;
	retry?: Partial<MomRetrySettings>;
	spontaneity?: Partial<MomSpontaneitySettings>;
	/** `"default"` is shorthand for the enabled 1/3/5/10-minute preset. */
	followUps?: Partial<MomFollowUpSettings> | "default" | "off";
	shellPath?: string;
	speak?: MomSpeakSettings;
}

export const DEFAULT_COMPACTION: MomCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: MomRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

/** Level → base interval in minutes */
const SPONTANEITY_LEVELS: Record<number, number> = {
	1: 1440,  // ~once a day
	2: 420,   // ~every 6-8 hours
	3: 180,   // ~every 2-3 hours
	4: 90,    // ~every 1-2 hours
	5: 45,    // ~every 30-60 minutes
};

const DEFAULT_SPONTANEITY: MomSpontaneitySettings = {
	enabled: true,
	level: 3,
	spontaneity: 0.3,
	intervalMinutes: 180,
	quietHours: { start: "23:00", end: "07:00" },
};

export const DEFAULT_FOLLOW_UP_INTERVALS_MINUTES = [1, 3, 5, 10] as const;
export const MAX_FOLLOW_UP_INTERVALS = 12;
export const MAX_FOLLOW_UP_INTERVAL_MINUTES = 7 * 24 * 60;

const DEFAULT_FOLLOW_UPS: MomFollowUpSettings = {
	enabled: false,
	preset: "default",
	intervalsMinutes: [...DEFAULT_FOLLOW_UP_INTERVALS_MINUTES],
};

export function normalizeFollowUpIntervals(value: unknown): number[] {
	if (!Array.isArray(value)) return [...DEFAULT_FOLLOW_UP_INTERVALS_MINUTES];
	const normalized = Array.from(new Set(value
		.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
		.filter((entry) => Number.isInteger(entry) && entry >= 1 && entry <= MAX_FOLLOW_UP_INTERVAL_MINUTES)))
		.sort((a, b) => a - b)
		.slice(0, MAX_FOLLOW_UP_INTERVALS);
	return normalized.length > 0 ? normalized : [...DEFAULT_FOLLOW_UP_INTERVALS_MINUTES];
}

const SEND_MESSAGE_ONLY_PLATFORMS = new Set(["slack", "teams", "mattermost", "telegram", "discord", "email", "phone"]);

export function inferPlatformFromChannelId(channelId: string): string | undefined {
	if (/^[a-z0-9]{26}$/.test(channelId)) return "mattermost";
	if (/^[CDG]/.test(channelId)) return "slack";
	if (/^\d{17,20}$/.test(channelId)) return "discord";
	if (/^-?\d+$/.test(channelId)) return "telegram";
	if (channelId.startsWith("email-")) return "email";
	if (channelId.startsWith("phone-")) return "phone";
	if (channelId.startsWith("form-")) return "form";
	if (channelId.startsWith("web-") || channelId === "web") return "web";
	if (channelId.startsWith("voice-") || channelId === "voice") return "voice";
	if (channelId === "heartbeat") return "heartbeat";
	if (channelId === "operator" || channelId === "operator-control") return "operator";
	return undefined;
}

export function isSendMessageOnlyPlatform(channelId: string, platform?: string): boolean {
	const resolved = platform || inferPlatformFromChannelId(channelId);
	return resolved ? SEND_MESSAGE_ONLY_PLATFORMS.has(resolved) : false;
}

export function isWorkingOutputTarget(value: unknown): value is WorkingOutputTarget {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as { platform?: unknown; channelId?: unknown };
	if (typeof candidate.channelId !== "string") return false;
	if (candidate.platform === "slack") return /^[CDG][A-Z0-9]+$/i.test(candidate.channelId);
	if (candidate.platform === "teams") return candidate.channelId.length > 0 && candidate.channelId.length <= 2048 && !/[\u0000-\u001f]/.test(candidate.channelId);
	if (candidate.platform === "mattermost") return /^[a-z0-9]{26}$/.test(candidate.channelId);
	if (candidate.platform === "rocket-chat") return /^[a-zA-Z0-9_-]{8,128}$/.test(candidate.channelId);
	if (candidate.platform === "zulip") {
		return /^[1-9]\d*$/.test(candidate.channelId)
			|| /^dm:[1-9]\d*(?:,[1-9]\d*)*$/.test(candidate.channelId);
	}
	return false;
}

/**
 * Settings manager for mom.
 * Stores settings in the workspace root directory.
 */
export class MomSettingsManager {
	private settingsPath: string;
	private settings: MomSettings;
	private store?: SettingsStore;

	constructor(workspaceDirOrStore: string | SettingsStore) {
		if (typeof workspaceDirOrStore === "string") {
			this.settingsPath = join(workspaceDirOrStore, "settings.json");
		} else {
			this.settingsPath = "settings.json";
			this.store = workspaceDirOrStore;
		}
		this.settings = this.load();
	}

	private load(): MomSettings {
		if (this.store) {
			return this.store.read();
		}

		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			if (this.store) {
				this.store.write(this.settings);
				return;
			}
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getCompactionSettings(): MomCompactionSettings {
		return {
			...DEFAULT_COMPACTION,
			...this.settings.compaction,
		};
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): MomRetrySettings {
		return {
			...DEFAULT_RETRY,
			...this.settings.retry,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	getSpontaneitySettings(): MomSpontaneitySettings {
		const s = this.settings.spontaneity || {};
		const level = s.level ?? DEFAULT_SPONTANEITY.level;
		const intervalFromLevel = SPONTANEITY_LEVELS[level] ?? DEFAULT_SPONTANEITY.intervalMinutes;
		return {
			enabled: s.enabled ?? DEFAULT_SPONTANEITY.enabled,
			level,
			spontaneity: s.spontaneity ?? DEFAULT_SPONTANEITY.spontaneity,
			intervalMinutes: s.intervalMinutes ?? intervalFromLevel,
			quietHours: s.quietHours ?? DEFAULT_SPONTANEITY.quietHours,
			timezone: s.timezone,
		};
	}

	/**
	 * Merge a partial spontaneity patch and persist. If `level` changes and
	 * `intervalMinutes` is not supplied in the patch, interval is recomputed
	 * from the level table so the two stay in sync.
	 */
	setSpontaneity(patch: Partial<MomSpontaneitySettings>): MomSpontaneitySettings {
		const current = this.getSpontaneitySettings();
		const merged: MomSpontaneitySettings = { ...current, ...patch };
		if (patch.level !== undefined && patch.intervalMinutes === undefined) {
			merged.intervalMinutes =
				SPONTANEITY_LEVELS[merged.level] ?? DEFAULT_SPONTANEITY.intervalMinutes;
		}
		this.settings.spontaneity = merged;
		this.save();
		return merged;
	}

	getFollowUpSettings(): MomFollowUpSettings {
		const raw = this.settings.followUps;
		if (raw === "default") {
			return { enabled: true, preset: "default", intervalsMinutes: [...DEFAULT_FOLLOW_UP_INTERVALS_MINUTES] };
		}
		if (raw === "off" || raw === undefined) return { ...DEFAULT_FOLLOW_UPS, intervalsMinutes: [...DEFAULT_FOLLOW_UPS.intervalsMinutes] };

		const preset: FollowUpPreset = raw.preset === "custom" ? "custom" : "default";
		return {
			enabled: raw.enabled ?? preset === "default",
			preset,
			intervalsMinutes: normalizeFollowUpIntervals(raw.intervalsMinutes),
		};
	}

	setFollowUps(settings: MomFollowUpSettings): MomFollowUpSettings {
		const normalized: MomFollowUpSettings = {
			enabled: settings.enabled,
			preset: settings.preset,
			intervalsMinutes: normalizeFollowUpIntervals(settings.intervalsMinutes),
		};
		this.settings.followUps = normalized;
		this.save();
		return normalized;
	}

	/**
	 * Read the raw verbose setting for the operator `describe` verb.
	 * Callers that want channel-scoped boolean resolution should use
	 * `getVerbose(channelId, platform)` below instead.
	 */
	getVerboseRaw(): VerbosityLevel | MomVerboseSettings | undefined {
		return this.settings.verbose;
	}

	/**
	 * Replace the entire verbose block. Accepts a boolean (simple global
	 * form) or an object (per-platform / per-channel control). Used by
	 * the operator `configure verbose` path.
	 */
	setVerboseRaw(value: VerbosityLevel | MomVerboseSettings): void {
		this.settings.verbose = value;
		this.save();
	}

	/**
	 * Raw access to the in-memory settings blob, for callers that need to
	 * describe the full current state (e.g. the operator `describe` verb).
	 * Returns a defensive copy.
	 */
	getRawSettings(): MomSettings {
		return JSON.parse(JSON.stringify(this.settings));
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
		this.settings.defaultThinkingLevel = level as MomSettings["defaultThinkingLevel"];
		this.save();
	}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		// Preserve each inbound as its own user message, but let Pi inject every
		// pending steer together at the next safe model boundary. Troublemaker's
		// canonical run gate still prevents parallel agent turns.
		return "all";
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time"; // Mom processes one message at a time
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		// No-op for mom
	}

	getHookPaths(): string[] {
		return []; // Mom doesn't use hooks
	}

	getHookTimeout(): number {
		return 30000;
	}

	getImageAutoResize(): boolean {
		return false; // Mom doesn't auto-resize images
	}

	getShellCommandPrefix(): string | undefined {
		return undefined;
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.settings.shellPath = path;
		this.save();
	}

	getBranchSummarySettings(): { reserveTokens: number } {
		return { reserveTokens: 16384 };
	}

	getTheme(): string | undefined {
		return undefined;
	}

	getVerbose(channelId: string, platform?: string): VerbosityLevel {
		const resolvedPlatform = platform || inferPlatformFromChannelId(channelId);
		const platformDefault: VerbosityLevel = isSendMessageOnlyPlatform(channelId, resolvedPlatform)
			? "messages-only"
			: true;
		const v = this.settings.verbose;
		// Legacy bare boolean or "messages-only"
		if (typeof v === "boolean" || v === "messages-only") return v;
		// No explicit config: preserve the safe platform default.
		if (!v) return platformDefault;
		// Check a platform-wide value or a platform bucket with a channel override.
		if (resolvedPlatform) {
			const bucket = v[resolvedPlatform];
			if (typeof bucket === "boolean" || bucket === "messages-only") return bucket;
			if (bucket && typeof bucket === "object") {
				const overrides = bucket as Record<string, VerbosityLevel>;
				if (channelId in overrides) return overrides[channelId];
				if ("default" in overrides) return overrides.default;
			}
		}
		// Explicit global default overrides the platform default; otherwise preserve it.
		return v.default ?? platformDefault;
	}

	setChannelVerbose(channelId: string, platform: string, value: VerbosityLevel | null): void {
		let v = this.settings.verbose;
		// Migrate bare boolean / string to object form
		if (typeof v !== "object" || !v) {
			v = { default: typeof v === "boolean" ? v : (v === "messages-only" ? v : true) };
			this.settings.verbose = v;
		}
		if (!v[platform] || typeof v[platform] !== "object") {
			const previousPlatformValue = v[platform];
			(v as any)[platform] = typeof previousPlatformValue === "boolean" || previousPlatformValue === "messages-only"
				? { default: previousPlatformValue }
				: {};
		}
		const bucket = v[platform] as Record<string, VerbosityLevel>;
		if (value === null) {
			delete bucket[channelId];
		} else {
			bucket[channelId] = value;
		}
		this.save();
	}

	setVerboseDefault(value: VerbosityLevel): void {
		let v = this.settings.verbose;
		if (typeof v !== "object" || !v) {
			v = { default: value };
			this.settings.verbose = v;
		} else {
			v.default = value;
		}
		this.save();
	}

	getVerboseDefault(): VerbosityLevel {
		const v = this.settings.verbose;
		if (typeof v === "boolean" || v === "messages-only") return v;
		if (!v) return "messages-only";
		return v.default ?? "messages-only";
	}

	getWorkingOutput(): MomWorkingOutputSettings {
		const configured = this.settings.workingOutput;
		if (!configured) return { mode: "follow" };
		if (configured.mode === "off" || configured.mode === "follow") {
			return { mode: configured.mode };
		}
		if (configured.mode === "fixed" && isWorkingOutputTarget(configured.target)) {
			return {
				mode: "fixed",
				target: { ...configured.target },
			};
		}
		// An explicitly malformed route must fail closed instead of leaking
		// progress back into whichever external conversation triggered the turn.
		return { mode: "off" };
	}

	setWorkingOutput(
		value: MomWorkingOutputSettings,
		slackPatch: Partial<Pick<MomSlackSettings, "toolStreaming" | "toolStreamPresentation" | "toolStreamWindowMinutes">> = {},
	): MomWorkingOutputSettings {
		let normalized: MomWorkingOutputSettings;
		if (value.mode === "off" || value.mode === "follow") {
			normalized = { mode: value.mode };
		} else if (value.mode === "fixed" && isWorkingOutputTarget(value.target)) {
			normalized = { mode: "fixed", target: { ...value.target } };
		} else {
			throw new Error('working output must use mode "off", "follow", or "fixed" with a valid collaboration target.');
		}

		if (slackPatch.toolStreaming !== undefined && !["off", "important", "all"].includes(slackPatch.toolStreaming)) {
			throw new Error('Slack tool streaming must be "off", "important", or "all".');
		}
		if (slackPatch.toolStreamPresentation !== undefined && !["split", "condensed"].includes(slackPatch.toolStreamPresentation)) {
			throw new Error('Slack tool stream presentation must be "split" or "condensed".');
		}
		if (slackPatch.toolStreamWindowMinutes !== undefined) {
			const minutes = slackPatch.toolStreamWindowMinutes;
			if (!Number.isInteger(minutes) || minutes < MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES || minutes > MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES) {
				throw new Error(`Slack tool stream window must be an integer from ${MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES} to ${MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES} minutes.`);
			}
		}

		this.settings.workingOutput = normalized;
		if (Object.keys(slackPatch).length > 0) {
			this.settings.slack = { ...this.settings.slack, ...slackPatch };
		}
		this.save();
		return this.getWorkingOutput();
	}

	getMattermostMentionsOnlyChannelIds(): string[] {
		const configured = this.settings.mattermost?.mentionsOnlyChannelIds;
		if (!Array.isArray(configured)) return [];
		return [...new Set(configured.filter((channelId): channelId is string =>
			typeof channelId === "string" && /^[a-z0-9]{26}$/.test(channelId),
		))];
	}

	getMattermostChannelAttention(channelId: string): "ambient" | "mentions-only" {
		return this.getMattermostMentionsOnlyChannelIds().includes(channelId)
			? "mentions-only"
			: "ambient";
	}

	setMattermostChannelAttention(
		channelId: string,
		mode: "ambient" | "mentions-only",
	): "ambient" | "mentions-only" {
		if (!/^[a-z0-9]{26}$/.test(channelId)) {
			throw new Error("Mattermost channel attention requires a valid channel ID.");
		}
		const mentionsOnly = new Set(this.getMattermostMentionsOnlyChannelIds());
		if (mode === "mentions-only") mentionsOnly.add(channelId);
		else mentionsOnly.delete(channelId);
		this.settings.mattermost = {
			...this.settings.mattermost,
			mentionsOnlyChannelIds: [...mentionsOnly].sort(),
		};
		this.save();
		return this.getMattermostChannelAttention(channelId);
	}

	getSlackResponsePlacement(): SlackResponsePlacement {
		return this.settings.slack?.responsePlacement ?? "thread";
	}

	setSlackResponsePlacement(value: SlackResponsePlacement): void {
		this.settings.slack = { ...this.settings.slack, responsePlacement: value };
		this.save();
	}

	getSlackToolStreaming(): ToolStreamingMode {
		// Slack exposes the complete tool-label stream by default. Agents can
		// still explicitly select important-only or disable it altogether.
		return this.settings.slack?.toolStreaming ?? "all";
	}

	setSlackToolStreaming(value: ToolStreamingMode): void {
		this.settings.slack = { ...this.settings.slack, toolStreaming: value };
		this.save();
	}

	getSlackToolStreamPresentation(): SlackToolStreamPresentation {
		// Split keeps each time window edited in place while occasionally creating
		// a real Slack message that other ambient agents can observe. Any persisted
		// legacy "batched" value intentionally migrates to this default.
		return this.settings.slack?.toolStreamPresentation === "condensed" ? "condensed" : "split";
	}

	setSlackToolStreamPresentation(value: SlackToolStreamPresentation): void {
		this.settings.slack = { ...this.settings.slack, toolStreamPresentation: value };
		this.save();
	}

	getSlackToolStreamWindowMinutes(): number {
		const value = this.settings.slack?.toolStreamWindowMinutes;
		return typeof value === "number"
			&& Number.isInteger(value)
			&& value >= MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES
			&& value <= MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES
			? value
			: DEFAULT_SLACK_TOOL_STREAM_WINDOW_MINUTES;
	}

	setSlackToolStreamWindowMinutes(value: number): void {
		if (!Number.isInteger(value) || value < MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES || value > MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES) {
			throw new Error(`Slack tool stream window must be an integer from ${MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES} to ${MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES} minutes.`);
		}
		this.settings.slack = { ...this.settings.slack, toolStreamWindowMinutes: value };
		this.save();
	}

	getTeamsMentionsOnlyConversationIds(): string[] {
		const configured = this.settings.teams?.mentionsOnlyConversationIds;
		if (!Array.isArray(configured)) return [];
		return [...new Set(configured.filter((conversationId): conversationId is string =>
			typeof conversationId === "string" && conversationId.length > 0 && conversationId.length <= 2048,
		))];
	}

	getTeamsChannelAttention(conversationId: string): "ambient" | "mentions-only" {
		return this.getTeamsMentionsOnlyConversationIds().includes(conversationId) ? "mentions-only" : "ambient";
	}

	setTeamsChannelAttention(
		conversationId: string,
		mode: "ambient" | "mentions-only",
	): "ambient" | "mentions-only" {
		if (!conversationId || conversationId.length > 2048) {
			throw new Error("Microsoft Teams attention requires a valid conversation ID.");
		}
		const mentionsOnly = new Set(this.getTeamsMentionsOnlyConversationIds());
		if (mode === "mentions-only") mentionsOnly.add(conversationId);
		else mentionsOnly.delete(conversationId);
		this.settings.teams = {
			...this.settings.teams,
			mentionsOnlyConversationIds: [...mentionsOnly].sort(),
		};
		this.save();
		return this.getTeamsChannelAttention(conversationId);
	}

	getTeamsResponsePlacement(): TeamsResponsePlacement {
		return this.settings.teams?.responsePlacement ?? "thread";
	}

	setTeamsResponsePlacement(value: TeamsResponsePlacement): void {
		this.settings.teams = { ...this.settings.teams, responsePlacement: value };
		this.save();
	}

	getTeamsToolStreaming(): ToolStreamingMode {
		return this.settings.teams?.toolStreaming ?? "all";
	}

	setTeamsToolStreaming(value: ToolStreamingMode): void {
		this.settings.teams = { ...this.settings.teams, toolStreaming: value };
		this.save();
	}

	getTeamsToolStreamPresentation(): TeamsToolStreamPresentation {
		return this.settings.teams?.toolStreamPresentation === "condensed" ? "condensed" : "split";
	}

	setTeamsToolStreamPresentation(value: TeamsToolStreamPresentation): void {
		this.settings.teams = { ...this.settings.teams, toolStreamPresentation: value };
		this.save();
	}

	getTeamsToolStreamWindowMinutes(): number {
		const value = this.settings.teams?.toolStreamWindowMinutes;
		return typeof value === "number"
			&& Number.isInteger(value)
			&& value >= MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES
			&& value <= MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES
			? value
			: DEFAULT_SLACK_TOOL_STREAM_WINDOW_MINUTES;
	}

	setTeamsToolStreamWindowMinutes(value: number): void {
		if (!Number.isInteger(value) || value < MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES || value > MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES) {
			throw new Error(`Microsoft Teams tool stream window must be an integer from ${MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES} to ${MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES} minutes.`);
		}
		this.settings.teams = { ...this.settings.teams, toolStreamWindowMinutes: value };
		this.save();
	}

	getDiscordToolStreaming(): ToolStreamingMode {
		return this.settings.discord?.toolStreaming ?? "all";
	}

	setDiscordToolStreaming(value: ToolStreamingMode): void {
		this.settings.discord = { ...this.settings.discord, toolStreaming: value };
		this.save();
	}

	getDiscordToolStreamPresentation(): DiscordToolStreamPresentation {
		return this.settings.discord?.toolStreamPresentation === "condensed" ? "condensed" : "split";
	}

	setDiscordToolStreamPresentation(value: DiscordToolStreamPresentation): void {
		this.settings.discord = { ...this.settings.discord, toolStreamPresentation: value };
		this.save();
	}

	getDiscordToolStreamWindowMinutes(): number {
		const value = this.settings.discord?.toolStreamWindowMinutes;
		return typeof value === "number"
			&& Number.isInteger(value)
			&& value >= MIN_DISCORD_TOOL_STREAM_WINDOW_MINUTES
			&& value <= MAX_DISCORD_TOOL_STREAM_WINDOW_MINUTES
			? value
			: DEFAULT_DISCORD_TOOL_STREAM_WINDOW_MINUTES;
	}

	setDiscordToolStreamWindowMinutes(value: number): void {
		if (!Number.isInteger(value) || value < MIN_DISCORD_TOOL_STREAM_WINDOW_MINUTES || value > MAX_DISCORD_TOOL_STREAM_WINDOW_MINUTES) {
			throw new Error(`Discord tool stream window must be an integer from ${MIN_DISCORD_TOOL_STREAM_WINDOW_MINUTES} to ${MAX_DISCORD_TOOL_STREAM_WINDOW_MINUTES} minutes.`);
		}
		this.settings.discord = { ...this.settings.discord, toolStreamWindowMinutes: value };
		this.save();
	}

	getSlackNativeProgress(): boolean {
		return this.settings.slack?.nativeProgress === true;
	}

	setSlackNativeProgress(value: boolean): void {
		this.settings.slack = { ...this.settings.slack, nativeProgress: value };
		this.save();
	}

	getVoiceWebhookInputMode(): VoiceWebhookInputMode {
		return this.settings.voice?.webhookInputMode === "steer" ? "steer" : "interrupt";
	}

	setVoiceWebhookInputMode(value: VoiceWebhookInputMode): void {
		this.settings.voice = { ...this.settings.voice, webhookInputMode: value };
		this.save();
	}

	getPlatformVerboseOverride(platform: string): VerbosityLevel | null {
		const v = this.settings.verbose;
		if (typeof v !== "object" || !v) return null;
		const value = v[platform];
		if (typeof value === "boolean" || value === "messages-only") return value;
		if (value && typeof value === "object") return value.default ?? null;
		return null;
	}

	setPlatformVerbose(platform: string, value: VerbosityLevel): void {
		let v = this.settings.verbose;
		if (typeof v !== "object" || !v) {
			v = { default: typeof v === "boolean" ? v : (v === "messages-only" ? v : "messages-only") };
			this.settings.verbose = v;
		}
		const platformValue = v[platform];
		if (platformValue && typeof platformValue === "object") {
			platformValue.default = value;
		} else {
			v[platform] = value;
		}
		this.save();
	}

	getChannelVerboseOverride(channelId: string, platform: string): VerbosityLevel | null {
		const v = this.settings.verbose;
		if (typeof v !== "object" || !v) return null;
		const bucket = v[platform];
		if (bucket && typeof bucket === "object" && channelId in bucket) {
			return (bucket as Record<string, VerbosityLevel>)[channelId];
		}
		return null;
	}

	reload(): void {
		this.settings = this.load();
	}
}
