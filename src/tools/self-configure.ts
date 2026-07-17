/**
 * self_configure — let the agent change its own durable settings.
 *
 * This is intentionally narrower than arbitrary file editing. It exposes the
 * semantic settings users naturally ask an agent to change: model, thinking,
 * verbosity, Slack delivery/tool display, heartbeat/spontaneity cadence, and the
 * heartbeat checklist prompt.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
	MAX_DISCORD_TOOL_STREAM_WINDOW_MINUTES,
	MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES,
	MIN_DISCORD_TOOL_STREAM_WINDOW_MINUTES,
	MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES,
	MomSettingsManager,
	type DiscordToolStreamPresentation,
	type MomSpontaneitySettings,
	type SlackResponsePlacement,
	type SlackToolStreamPresentation,
	type ToolStreamingMode,
	type VerbosityLevel,
	type VoiceWebhookInputMode,
} from "../context.js";
import { syncHeartbeatFromSpontaneity, type HeartbeatScheduleResult } from "../heartbeat-schedule.js";
import { findModel } from "../model-config.js";
import {
	DEFAULT_REALTIME_VOICE,
	normalizeRealtimeVoiceName,
	realtimeVoiceDescription,
} from "../realtime-voices.js";
import * as log from "../log.js";
import { normalizeVoiceWakeAliases } from "../voice-contract.js";

const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SELF_CONFIGURE_SETTINGS = new Set([
	"model",
	"thinking_level",
	"verbosity",
	"slack.verbosity",
	"slack.response_placement",
	"slack.tool_streaming",
	"slack.tool_stream_presentation",
	"slack.tool_stream_window_minutes",
	"slack.native_progress",
	"discord.tool_streaming",
	"discord.tool_stream_presentation",
	"discord.tool_stream_window_minutes",
	"spontaneity.enabled",
	"spontaneity.level",
	"spontaneity.intervalMinutes",
	"spontaneity.spontaneity",
	"spontaneity.quietHours.start",
	"spontaneity.quietHours.end",
	"spontaneity.timezone",
	"heartbeat.checklist",
	"voice.wake_aliases",
	"voice.webhook_input_mode",
	"voice",
	"realtime_voice",
	"realtime.voice",
]);

const SELF_CONFIGURE_ALIASES: Record<string, string> = {
	"voice": "realtime_voice",
	"voice.aliases": "voice.wake_aliases",
	"voice.wakeAliases": "voice.wake_aliases",
	"voice.webhookInputMode": "voice.webhook_input_mode",
	"voice.webhook_mode": "voice.webhook_input_mode",
	"voice.input_mode": "voice.webhook_input_mode",
	"voiceWebhookInputMode": "voice.webhook_input_mode",
	"wake_aliases": "voice.wake_aliases",
	"realtimeVoice": "realtime_voice",
	"realtime.voice": "realtime_voice",
	"verbose": "verbosity",
	"verbose.default": "verbosity",
	"slack.verbose": "slack.verbosity",
	"slack.responsePlacement": "slack.response_placement",
	"slack.response_placement": "slack.response_placement",
	"slack.toolStreaming": "slack.tool_streaming",
	"slack.toolStreamPresentation": "slack.tool_stream_presentation",
	"slack.tool_stream_layout": "slack.tool_stream_presentation",
	"slack.toolStreamLayout": "slack.tool_stream_presentation",
	"slack.toolStreamWindowMinutes": "slack.tool_stream_window_minutes",
	"slack.tool_stream_group_minutes": "slack.tool_stream_window_minutes",
	"slack.toolStreamGroupMinutes": "slack.tool_stream_window_minutes",
	"slack.tool_stream_split_minutes": "slack.tool_stream_window_minutes",
	"slack.toolStreamSplitMinutes": "slack.tool_stream_window_minutes",
	"slack.nativeProgress": "slack.native_progress",
	"discord.toolStreaming": "discord.tool_streaming",
	"discord.toolStreamPresentation": "discord.tool_stream_presentation",
	"discord.tool_stream_layout": "discord.tool_stream_presentation",
	"discord.toolStreamLayout": "discord.tool_stream_presentation",
	"discord.toolStreamWindowMinutes": "discord.tool_stream_window_minutes",
	"discord.tool_stream_group_minutes": "discord.tool_stream_window_minutes",
	"discord.toolStreamGroupMinutes": "discord.tool_stream_window_minutes",
	"discord.tool_stream_split_minutes": "discord.tool_stream_window_minutes",
	"discord.toolStreamSplitMinutes": "discord.tool_stream_window_minutes",
	"native_progress": "slack.native_progress",
	"tool_streaming": "slack.tool_streaming",
	"toolStreaming": "slack.tool_streaming",
	"tool_stream_presentation": "slack.tool_stream_presentation",
	"toolStreamPresentation": "slack.tool_stream_presentation",
	"tool_stream_window_minutes": "slack.tool_stream_window_minutes",
	"toolStreamWindowMinutes": "slack.tool_stream_window_minutes",
};

interface SelfConfigureResult {
	changed: true;
	setting: string;
	previousValue: unknown;
	newValue: unknown;
	note: string;
	schedule?: HeartbeatScheduleResult;
	path?: string;
}

function loadSettingsRaw(workingDir: string): Record<string, unknown> {
	const settingsPath = join(workingDir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function saveSettingsRaw(workingDir: string, settings: Record<string, unknown>): void {
	const settingsPath = join(workingDir, "settings.json");
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function parseBoolean(value: unknown, setting: string): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "on" || normalized === "yes") return true;
		if (normalized === "false" || normalized === "off" || normalized === "no") return false;
	}
	throw new Error(`${setting} must be true or false.`);
}

function parseNumber(value: unknown, setting: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	throw new Error(`${setting} must be a number.`);
}

function parseString(value: unknown, setting: string): string {
	if (typeof value === "string") return value;
	throw new Error(`${setting} must be a string.`);
}

function configureModel(workingDir: string, value: unknown): SelfConfigureResult {
	const query = parseString(value, "model").trim();
	if (!query) throw new Error("model must be a non-empty string.");
	const match = findModel(query, workingDir);
	if (!match) throw new Error(`Model not found: ${query}. Use /model list to see available models.`);

	const settings = loadSettingsRaw(workingDir);
	const previousValue = settings.defaultProvider && settings.defaultModel
		? `${String(settings.defaultProvider)}/${String(settings.defaultModel)}`
		: settings.model ?? null;

	settings.defaultProvider = match.provider;
	settings.defaultModel = match.id;
	delete settings.model;
	saveSettingsRaw(workingDir, settings);

	return {
		changed: true,
		setting: "model",
		previousValue,
		newValue: `${match.provider}/${match.id}`,
		note: "Model takes effect on the next model resolution.",
	};
}

function configureThinkingLevel(workingDir: string, value: unknown): SelfConfigureResult {
	const level = parseString(value, "thinking_level").trim().toLowerCase();
	if (!(THINKING_LEVEL_VALUES as readonly string[]).includes(level)) {
		throw new Error(`thinking_level must be one of: ${THINKING_LEVEL_VALUES.join(", ")}`);
	}

	const settings = loadSettingsRaw(workingDir);
	const previousValue = settings.thinking_level ?? settings.defaultThinkingLevel ?? "off";
	settings.thinking_level = level;
	settings.defaultThinkingLevel = level;
	saveSettingsRaw(workingDir, settings);

	return {
		changed: true,
		setting: "thinking_level",
		previousValue,
		newValue: level,
		note: "Thinking level takes effect on the next model turn.",
	};
}

function parseVerbosity(value: unknown): VerbosityLevel {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase().replace(/_/g, "-");
		if (["true", "on", "yes", "verbose", "full"].includes(normalized)) return true;
		if (["false", "off", "no", "final-only", "quiet"].includes(normalized)) return false;
		if (["messages-only", "messages only"].includes(normalized)) return "messages-only";
	}
	throw new Error('verbosity must be true, false, or "messages-only".');
}

function configureVerbosity(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getVerboseDefault();
	const newValue = parseVerbosity(value);
	manager.setVerboseDefault(newValue);
	return {
		changed: true,
		setting: "verbosity",
		previousValue,
		newValue,
		note: "Verbosity takes effect on the next turn. false keeps final responses but suppresses working output.",
	};
}

function configureSlackVerbosity(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getPlatformVerboseOverride("slack") ?? manager.getVerboseDefault();
	const newValue = parseVerbosity(value);
	manager.setPlatformVerbose("slack", newValue);
	return {
		changed: true,
		setting: "slack.verbosity",
		previousValue,
		newValue,
		note: "Slack verbosity takes effect on the next Slack turn without changing other platforms.",
	};
}

function parseSlackResponsePlacement(value: unknown): SlackResponsePlacement {
	const normalized = parseString(value, "slack.response_placement").trim().toLowerCase().replace(/_/g, "-");
	if (["thread", "inbound-thread", "subthread", "reply"].includes(normalized)) return "thread";
	if (["channel", "new-channel-message", "new-message", "top-level"].includes(normalized)) return "channel";
	throw new Error('slack.response_placement must be "thread" or "channel".');
}

function configureSlackResponsePlacement(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getSlackResponsePlacement();
	const newValue = parseSlackResponsePlacement(value);
	manager.setSlackResponsePlacement(newValue);
	return {
		changed: true,
		setting: "slack.response_placement",
		previousValue,
		newValue,
		note: newValue === "thread"
			? "Slack working state and reply delivery will use the inbound thread on the next turn."
			: "Slack working state and reply delivery will both use new top-level channel messages on the next turn.",
	};
}

function parseToolStreamingMode(value: unknown, setting: string): ToolStreamingMode {
	const normalized = parseString(value, setting).trim().toLowerCase().replace(/_/g, "-");
	if (["off", "none", "quiet", "false"].includes(normalized)) return "off";
	if (["important", "selected", "selective", "on", "true"].includes(normalized)) return "important";
	if (["all", "everything"].includes(normalized)) return "all";
	throw new Error(`${setting} must be "off", "important", or "all".`);
}

function configureSlackToolStreaming(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getSlackToolStreaming();
	const newValue = parseToolStreamingMode(value, "slack.tool_streaming");
	manager.setSlackToolStreaming(newValue);
	return {
		changed: true,
		setting: "slack.tool_streaming",
		previousValue,
		newValue,
		note: newValue === "off"
			? "Slack tool labels are quiet on the next turn."
			: newValue === "important"
				? "On the next Slack turn, only safe tool labels explicitly marked show: true will surface."
				: "On the next Slack turn, every safe tool label will surface; raw arguments and results still follow the verbosity boundary.",
	};
}

function parseToolStreamPresentation(value: unknown, setting: string): SlackToolStreamPresentation {
	const normalized = parseString(value, setting).trim().toLowerCase().replace(/_/g, "-");
	if (["split", "batched", "segmented", "interleaved", "grouped", "chronological", "rollover"].includes(normalized)) return "split";
	if (["condensed", "compact", "edited", "single", "single-message", "one-message"].includes(normalized)) return "condensed";
	throw new Error(`${setting} must be "split" or "condensed".`);
}

function configureSlackToolStreamPresentation(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getSlackToolStreamPresentation();
	const newValue = parseToolStreamPresentation(value, "slack.tool_stream_presentation");
	manager.setSlackToolStreamPresentation(newValue);
	return {
		changed: true,
		setting: "slack.tool_stream_presentation",
		previousValue,
		newValue,
		note: newValue === "condensed"
			? "On the next Slack turn, tool progress will stay in one edited working message even across deliberate sends."
			: `On the next Slack turn, tool progress will edit one working message for each rolling ${manager.getSlackToolStreamWindowMinutes()}-minute window and start a fresh message after a deliberate send to the active conversation. New messages are created only when real tool events arrive.`,
	};
}

function configureSlackToolStreamWindowMinutes(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getSlackToolStreamWindowMinutes();
	const parsed = parseNumber(value, "slack.tool_stream_window_minutes");
	if (!Number.isInteger(parsed) || parsed < MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES || parsed > MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES) {
		throw new Error(`slack.tool_stream_window_minutes must be an integer from ${MIN_SLACK_TOOL_STREAM_WINDOW_MINUTES} to ${MAX_SLACK_TOOL_STREAM_WINDOW_MINUTES}.`);
	}
	manager.setSlackToolStreamWindowMinutes(parsed);
	return {
		changed: true,
		setting: "slack.tool_stream_window_minutes",
		previousValue,
		newValue: parsed,
		note: `On the next split Slack turn, each edited working message will cover a rolling ${parsed}-minute window. The first real tool event after that window opens a fresh message.`,
	};
}

function configureDiscordToolStreaming(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getDiscordToolStreaming();
	const newValue = parseToolStreamingMode(value, "discord.tool_streaming");
	manager.setDiscordToolStreaming(newValue);
	return {
		changed: true,
		setting: "discord.tool_streaming",
		previousValue,
		newValue,
		note: newValue === "off"
			? "Discord tool labels are quiet on the next turn."
			: newValue === "important"
				? "On the next Discord turn, only safe tool labels explicitly marked show: true will surface."
				: "On the next Discord turn, every safe tool label will surface; raw arguments and results still follow the verbosity boundary.",
	};
}

function configureDiscordToolStreamPresentation(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getDiscordToolStreamPresentation();
	const newValue = parseToolStreamPresentation(value, "discord.tool_stream_presentation") as DiscordToolStreamPresentation;
	manager.setDiscordToolStreamPresentation(newValue);
	return {
		changed: true,
		setting: "discord.tool_stream_presentation",
		previousValue,
		newValue,
		note: newValue === "condensed"
			? "On the next Discord turn, tool progress will stay in one edited working message."
			: `On the next Discord turn, tool progress will edit one working message for each rolling ${manager.getDiscordToolStreamWindowMinutes()}-minute window. New messages are created only when real tool events arrive.`,
	};
}

function configureDiscordToolStreamWindowMinutes(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getDiscordToolStreamWindowMinutes();
	const parsed = parseNumber(value, "discord.tool_stream_window_minutes");
	if (!Number.isInteger(parsed) || parsed < MIN_DISCORD_TOOL_STREAM_WINDOW_MINUTES || parsed > MAX_DISCORD_TOOL_STREAM_WINDOW_MINUTES) {
		throw new Error(`discord.tool_stream_window_minutes must be an integer from ${MIN_DISCORD_TOOL_STREAM_WINDOW_MINUTES} to ${MAX_DISCORD_TOOL_STREAM_WINDOW_MINUTES}.`);
	}
	manager.setDiscordToolStreamWindowMinutes(parsed);
	return {
		changed: true,
		setting: "discord.tool_stream_window_minutes",
		previousValue,
		newValue: parsed,
		note: `On the next split Discord turn, each edited working message will cover a rolling ${parsed}-minute window. The first real tool event after that window opens a fresh message.`,
	};
}

function configureSlackNativeProgress(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getSlackNativeProgress();
	const newValue = parseBoolean(value, "slack.native_progress");
	manager.setSlackNativeProgress(newValue);
	return {
		changed: true,
		setting: "slack.native_progress",
		previousValue,
		newValue,
		note: newValue
			? "Slack will use native streaming task cards for selected tool progress on eligible direct turns, with message fallback."
			: "Slack will use the existing edited-message progress renderer.",
	};
}

function configureSpontaneity(workingDir: string, setting: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previous = manager.getSpontaneitySettings();
	const patch: Partial<MomSpontaneitySettings> = {};
	let previousValue: unknown;
	let newValue: unknown = value;

	if (setting === "spontaneity.enabled") {
		previousValue = previous.enabled;
		patch.enabled = parseBoolean(value, setting);
		newValue = patch.enabled;
	} else if (setting === "spontaneity.level") {
		const level = parseNumber(value, setting);
		if (!Number.isInteger(level) || level < 1 || level > 5) {
			throw new Error("spontaneity.level must be an integer from 1 to 5.");
		}
		previousValue = previous.level;
		patch.level = level as 1 | 2 | 3 | 4 | 5;
		newValue = level;
	} else if (setting === "spontaneity.intervalMinutes") {
		const minutes = parseNumber(value, setting);
		if (minutes <= 0) throw new Error("spontaneity.intervalMinutes must be positive.");
		previousValue = previous.intervalMinutes;
		patch.intervalMinutes = minutes;
		newValue = minutes;
	} else if (setting === "spontaneity.spontaneity") {
		const spontaneity = parseNumber(value, setting);
		if (spontaneity < 0 || spontaneity > 1) {
			throw new Error("spontaneity.spontaneity must be between 0 and 1.");
		}
		previousValue = previous.spontaneity;
		patch.spontaneity = spontaneity;
		newValue = spontaneity;
	} else if (setting === "spontaneity.quietHours.start") {
		const start = parseString(value, setting);
		previousValue = previous.quietHours.start;
		patch.quietHours = { ...previous.quietHours, start };
		newValue = start;
	} else if (setting === "spontaneity.quietHours.end") {
		const end = parseString(value, setting);
		previousValue = previous.quietHours.end;
		patch.quietHours = { ...previous.quietHours, end };
		newValue = end;
	} else if (setting === "spontaneity.timezone") {
		const timezone = parseString(value, setting);
		previousValue = previous.timezone ?? null;
		patch.timezone = timezone;
		newValue = timezone;
	} else {
		throw new Error(`Unsupported spontaneity setting: ${setting}`);
	}

	const merged = manager.setSpontaneity(patch);
	const schedule = syncHeartbeatFromSpontaneity(workingDir, merged);

	return {
		changed: true,
		setting,
		previousValue,
		newValue,
		schedule,
		note: "Heartbeat schedule was resynced.",
	};
}

function configureHeartbeatChecklist(workingDir: string, value: unknown): SelfConfigureResult {
	const checklist = parseString(value, "heartbeat.checklist");
	const path = join(workingDir, "HEARTBEAT.md");
	const previousValue = existsSync(path) ? readFileSync(path, "utf-8") : null;
	writeFileSync(path, checklist, "utf-8");
	return {
		changed: true,
		setting: "heartbeat.checklist",
		previousValue,
		newValue: checklist,
		path: "HEARTBEAT.md",
		note: checklist.trim() ? "Heartbeat checklist updated." : "Heartbeat checklist cleared; heartbeat runs will be skipped.",
	};
}

function configureVoiceWakeAliases(workingDir: string, value: unknown): SelfConfigureResult {
	if (typeof value !== "string" && !Array.isArray(value)) {
		throw new Error("voice.wake_aliases must be a comma-separated string or an array of strings.");
	}
	if (Array.isArray(value) && value.some((entry) => typeof entry !== "string")) {
		throw new Error("voice.wake_aliases entries must be strings.");
	}
	const aliases = normalizeVoiceWakeAliases(value);
	const settings = loadSettingsRaw(workingDir);
	const previousVoice = settings.voice && typeof settings.voice === "object" && !Array.isArray(settings.voice)
		? settings.voice as Record<string, unknown>
		: {};
	const previousValue = normalizeVoiceWakeAliases(previousVoice.aliases);
	settings.voice = { ...previousVoice, aliases };
	saveSettingsRaw(workingDir, settings);
	return {
		changed: true,
		setting: "voice.wake_aliases",
		previousValue,
		newValue: aliases,
		note: aliases.length > 0
			? "Wake aliases apply to newly opened voice transports; the IDENTITY.md Name remains the primary wake name."
			: "Wake aliases cleared; the IDENTITY.md Name remains the primary wake name.",
	};
}

function configureVoiceWebhookInputMode(workingDir: string, value: unknown): SelfConfigureResult {
	const normalized = parseString(value, "voice.webhook_input_mode")
		.trim()
		.toLowerCase()
		.replace(/_/g, "-");
	let newValue: VoiceWebhookInputMode;
	if (["interrupt", "preempt", "restart", "replace"].includes(normalized)) {
		newValue = "interrupt";
	} else if (["steer", "steer-in", "soft-steer", "append"].includes(normalized)) {
		newValue = "steer";
	} else {
		throw new Error('voice.webhook_input_mode must be "interrupt" or "steer".');
	}

	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getVoiceWebhookInputMode();
	manager.setVoiceWebhookInputMode(newValue);
	return {
		changed: true,
		setting: "voice.webhook_input_mode",
		previousValue,
		newValue,
		note: newValue === "steer"
			? "Busy voice webhook transcripts will steer the active model turn when possible and otherwise queue without aborting active work."
			: "Busy voice webhook transcripts will interrupt the active run and restart from the newest input.",
	};
}

function configureRealtimeVoice(workingDir: string, value: unknown): SelfConfigureResult {
	const query = parseString(value, "realtime_voice").trim();
	const voice = normalizeRealtimeVoiceName(query);
	if (!voice) throw new Error(`Unknown Realtime voice: ${query || JSON.stringify(value)}. Use /voice list to see available voices.`);

	const settings = loadSettingsRaw(workingDir);
	const previousValue = normalizeRealtimeVoiceName(settings.realtimeVoice) || DEFAULT_REALTIME_VOICE;
	settings.realtimeVoice = voice;
	saveSettingsRaw(workingDir, settings);

	const description = realtimeVoiceDescription(voice);
	return {
		changed: true,
		setting: "realtime_voice",
		previousValue,
		newValue: voice,
		note: `Realtime voice changes apply to the next voice session.${description ? ` ${description}` : ""}`,
	};
}

export function applySelfConfiguration(
	workingDir: string,
	setting: string,
	value: unknown,
): SelfConfigureResult {
	const target = SELF_CONFIGURE_ALIASES[setting] ?? setting;
	if (!SELF_CONFIGURE_SETTINGS.has(target)) {
		throw new Error(`Unknown self_configure setting: ${setting}. Supported settings: ${Array.from(SELF_CONFIGURE_SETTINGS).join(", ")}`);
	}
	if (target === "model") return configureModel(workingDir, value);
	if (target === "thinking_level") return configureThinkingLevel(workingDir, value);
	if (target === "verbosity") return configureVerbosity(workingDir, value);
	if (target === "slack.verbosity") return configureSlackVerbosity(workingDir, value);
	if (target === "slack.response_placement") return configureSlackResponsePlacement(workingDir, value);
	if (target === "slack.tool_streaming") return configureSlackToolStreaming(workingDir, value);
	if (target === "slack.tool_stream_presentation") return configureSlackToolStreamPresentation(workingDir, value);
	if (target === "slack.tool_stream_window_minutes") return configureSlackToolStreamWindowMinutes(workingDir, value);
	if (target === "slack.native_progress") return configureSlackNativeProgress(workingDir, value);
	if (target === "discord.tool_streaming") return configureDiscordToolStreaming(workingDir, value);
	if (target === "discord.tool_stream_presentation") return configureDiscordToolStreamPresentation(workingDir, value);
	if (target === "discord.tool_stream_window_minutes") return configureDiscordToolStreamWindowMinutes(workingDir, value);
	if (target.startsWith("spontaneity.")) return configureSpontaneity(workingDir, target, value);
	if (target === "heartbeat.checklist") return configureHeartbeatChecklist(workingDir, value);
	if (target === "voice.wake_aliases") return configureVoiceWakeAliases(workingDir, value);
	if (target === "voice.webhook_input_mode") return configureVoiceWebhookInputMode(workingDir, value);
	if (target === "realtime_voice") return configureRealtimeVoice(workingDir, value);
	throw new Error(`Unsupported self_configure setting: ${setting}`);
}

function formatResult(result: SelfConfigureResult): string {
	const lines = [
		`Configured ${result.setting}.`,
		`Previous: ${JSON.stringify(result.previousValue)}`,
		`New: ${JSON.stringify(result.newValue)}`,
		result.note,
	];
	if (result.schedule) {
		lines.push(`Schedule: ${result.schedule.enabled ? result.schedule.schedule : "disabled"}`);
	}
	return lines.join("\n");
}

export function createSelfConfigureTool(workingDir: string): AgentTool<any> {
	const schema = Type.Object({
		label: Type.String({ description: "Brief description of the setting change" }),
		show: Type.Optional(Type.Boolean({ description: "Surface this safe label only when it is a meaningful progress milestone. Default false." })),
		setting: Type.String({
			description:
				"Setting to change. Supported: model, thinking_level, verbosity, slack.verbosity, slack.response_placement, slack.tool_streaming, slack.tool_stream_presentation, slack.tool_stream_window_minutes, slack.native_progress, " +
				"discord.tool_streaming, discord.tool_stream_presentation, discord.tool_stream_window_minutes, " +
				"spontaneity.enabled, spontaneity.level, spontaneity.intervalMinutes, spontaneity.spontaneity, " +
				"spontaneity.quietHours.start, spontaneity.quietHours.end, spontaneity.timezone, " +
				"heartbeat.checklist, voice.wake_aliases, voice.webhook_input_mode, voice/realtime_voice.",
		}),
		value: Type.Any({ description: "New value. Booleans/numbers may be passed as native JSON values or strings." }),
	});

	return {
		name: "self_configure",
		label: "self_configure",
		description:
			"Change your own durable configuration when the user explicitly asks you to adjust model, thinking, verbosity, coherent Slack turn placement, selective Slack or Discord tool streaming, tool-stream grouping, native Slack progress cards, voice webhook routing, voice wake aliases, Realtime voice, heartbeat/spontaneity, or heartbeat checklist settings. Use slack.response_placement to choose inbound threads (the default) or whole-turn top-level channel delivery, slack.tool_streaming or discord.tool_streaming for requests such as ‘quiet down’, ‘show important tool calls’, or ‘show all tool labels’, the matching platform tool_stream_presentation setting with split (the default) to edit within rolling time windows or condensed to keep one edited working message for the whole turn, the matching tool_stream_window_minutes setting to choose 1-60 minutes per split message, slack.native_progress to enable or disable native task cards, and voice.webhook_input_mode to choose interrupt (the default) or steer for busy webhook transcripts. " +
			"This writes settings.json or HEARTBEAT.md and is not for arbitrary file edits, secrets, or user-visible messaging. " +
			"After using it, briefly tell the user what changed if the current channel expects a reply.",
		parameters: schema,
		execute: async (_toolCallId: string, params: unknown) => {
			const { setting, value } = params as { label?: string; setting?: string; value?: unknown };
			if (!setting || typeof setting !== "string") {
				throw new Error("self_configure requires a setting.");
			}
			if (value === undefined) {
				throw new Error("self_configure requires a value.");
			}

			const result = applySelfConfiguration(workingDir, setting, value);
			log.logInfo(`[self_configure] ${setting} -> ${JSON.stringify(result.newValue)}`);
			return {
				content: [{ type: "text" as const, text: formatResult(result) }],
				details: undefined,
			};
		},
	};
}
