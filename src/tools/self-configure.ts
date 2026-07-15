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
	MAX_SLACK_TOOL_STREAM_BATCH_SIZE,
	MIN_SLACK_TOOL_STREAM_BATCH_SIZE,
	MomSettingsManager,
	type MomSpontaneitySettings,
	type SlackResponsePlacement,
	type SlackToolStreamPresentation,
	type ToolStreamingMode,
	type VerbosityLevel,
} from "../context.js";
import { syncHeartbeatFromSpontaneity, type HeartbeatScheduleResult } from "../heartbeat-schedule.js";
import { findModel } from "../model-config.js";
import {
	DEFAULT_REALTIME_VOICE,
	normalizeRealtimeVoiceName,
	realtimeVoiceDescription,
} from "../realtime-voices.js";
import * as log from "../log.js";

const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SELF_CONFIGURE_SETTINGS = new Set([
	"model",
	"thinking_level",
	"verbosity",
	"slack.verbosity",
	"slack.response_placement",
	"slack.tool_streaming",
	"slack.tool_stream_presentation",
	"slack.tool_stream_batch_size",
	"slack.native_progress",
	"spontaneity.enabled",
	"spontaneity.level",
	"spontaneity.intervalMinutes",
	"spontaneity.spontaneity",
	"spontaneity.quietHours.start",
	"spontaneity.quietHours.end",
	"spontaneity.timezone",
	"heartbeat.checklist",
	"voice",
	"realtime_voice",
	"realtime.voice",
]);

const SELF_CONFIGURE_ALIASES: Record<string, string> = {
	"voice": "realtime_voice",
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
	"slack.toolStreamBatchSize": "slack.tool_stream_batch_size",
	"slack.tool_stream_group_size": "slack.tool_stream_batch_size",
	"slack.toolStreamGroupSize": "slack.tool_stream_batch_size",
	"slack.nativeProgress": "slack.native_progress",
	"native_progress": "slack.native_progress",
	"tool_streaming": "slack.tool_streaming",
	"toolStreaming": "slack.tool_streaming",
	"tool_stream_presentation": "slack.tool_stream_presentation",
	"toolStreamPresentation": "slack.tool_stream_presentation",
	"tool_stream_batch_size": "slack.tool_stream_batch_size",
	"toolStreamBatchSize": "slack.tool_stream_batch_size",
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

function parseToolStreamingMode(value: unknown): ToolStreamingMode {
	const normalized = parseString(value, "slack.tool_streaming").trim().toLowerCase().replace(/_/g, "-");
	if (["off", "none", "quiet", "false"].includes(normalized)) return "off";
	if (["important", "selected", "selective", "on", "true"].includes(normalized)) return "important";
	if (["all", "everything"].includes(normalized)) return "all";
	throw new Error('slack.tool_streaming must be "off", "important", or "all".');
}

function configureSlackToolStreaming(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getSlackToolStreaming();
	const newValue = parseToolStreamingMode(value);
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

function parseSlackToolStreamPresentation(value: unknown): SlackToolStreamPresentation {
	const normalized = parseString(value, "slack.tool_stream_presentation").trim().toLowerCase().replace(/_/g, "-");
	if (["batched", "segmented", "interleaved", "grouped", "chronological", "rollover"].includes(normalized)) return "batched";
	if (["condensed", "compact", "edited", "single", "single-message", "one-message"].includes(normalized)) return "condensed";
	throw new Error('slack.tool_stream_presentation must be "batched" or "condensed".');
}

function configureSlackToolStreamPresentation(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getSlackToolStreamPresentation();
	const newValue = parseSlackToolStreamPresentation(value);
	manager.setSlackToolStreamPresentation(newValue);
	return {
		changed: true,
		setting: "slack.tool_stream_presentation",
		previousValue,
		newValue,
		note: newValue === "condensed"
			? "On the next Slack turn, tool progress will stay in one edited working message even across deliberate sends."
			: `On the next Slack turn, tool progress will edit within groups of ${manager.getSlackToolStreamBatchSize()} surfaced labels and start a fresh group after a deliberate send to the active conversation. New groups are created only when real tool events arrive.`,
	};
}

function configureSlackToolStreamBatchSize(workingDir: string, value: unknown): SelfConfigureResult {
	const manager = new MomSettingsManager(workingDir);
	const previousValue = manager.getSlackToolStreamBatchSize();
	const parsed = parseNumber(value, "slack.tool_stream_batch_size");
	if (!Number.isInteger(parsed) || parsed < MIN_SLACK_TOOL_STREAM_BATCH_SIZE || parsed > MAX_SLACK_TOOL_STREAM_BATCH_SIZE) {
		throw new Error(`slack.tool_stream_batch_size must be an integer from ${MIN_SLACK_TOOL_STREAM_BATCH_SIZE} to ${MAX_SLACK_TOOL_STREAM_BATCH_SIZE}.`);
	}
	manager.setSlackToolStreamBatchSize(parsed);
	return {
		changed: true,
		setting: "slack.tool_stream_batch_size",
		previousValue,
		newValue: parsed,
		note: `On the next batched Slack turn, each edited working message will hold up to ${parsed} surfaced tool labels before the next real tool event opens a fresh message.`,
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
	if (target === "slack.tool_stream_batch_size") return configureSlackToolStreamBatchSize(workingDir, value);
	if (target === "slack.native_progress") return configureSlackNativeProgress(workingDir, value);
	if (target.startsWith("spontaneity.")) return configureSpontaneity(workingDir, target, value);
	if (target === "heartbeat.checklist") return configureHeartbeatChecklist(workingDir, value);
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
				"Setting to change. Supported: model, thinking_level, verbosity, slack.verbosity, slack.response_placement, slack.tool_streaming, slack.tool_stream_presentation, slack.tool_stream_batch_size, slack.native_progress, " +
				"spontaneity.enabled, spontaneity.level, spontaneity.intervalMinutes, spontaneity.spontaneity, " +
				"spontaneity.quietHours.start, spontaneity.quietHours.end, spontaneity.timezone, " +
				"heartbeat.checklist, voice/realtime_voice.",
		}),
		value: Type.Any({ description: "New value. Booleans/numbers may be passed as native JSON values or strings." }),
	});

	return {
		name: "self_configure",
		label: "self_configure",
		description:
			"Change your own durable configuration when the user explicitly asks you to adjust model, thinking, verbosity, coherent Slack turn placement, selective Slack tool streaming, Slack tool-stream grouping, native Slack progress cards, Realtime voice, heartbeat/spontaneity, or heartbeat checklist settings. Use slack.response_placement to choose inbound threads (the default) or whole-turn top-level channel delivery, slack.tool_streaming for requests such as ‘quiet down’, ‘show important tool calls’, or ‘show all tool labels’, slack.tool_stream_presentation with batched (the default) to edit within event-driven groups or condensed to keep one edited working message for the whole turn, slack.tool_stream_batch_size to choose 2-20 surfaced labels per batched message, and slack.native_progress to enable or disable native task cards. " +
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
