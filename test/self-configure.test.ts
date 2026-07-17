import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applySelfConfiguration, createSelfConfigureTool } from "../src/tools/self-configure.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

function readSettings(workingDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(workingDir, "settings.json"), "utf-8")) as Record<string, unknown>;
}

const workingDir = mkdtempSync(join(tmpdir(), "self-configure-"));

try {
	const model = applySelfConfiguration(workingDir, "model", "minimax");
	let settings = readSettings(workingDir);
	assert(model.newValue === "fireworks/accounts/fireworks/models/minimax-m2p7", "model alias resolves to canonical provider/model");
	assert(settings.defaultProvider === "fireworks", "model writes defaultProvider");
	assert(settings.defaultModel === "accounts/fireworks/models/minimax-m2p7", "model writes defaultModel");

	const thinking = applySelfConfiguration(workingDir, "thinking_level", "low");
	settings = readSettings(workingDir);
	assert(thinking.newValue === "low", "thinking level result reports new value");
	assert(settings.thinking_level === "low", "thinking_level writes canonical key");
	assert(settings.defaultThinkingLevel === "low", "thinking_level keeps legacy key in sync");

	const verbosity = applySelfConfiguration(workingDir, "verbosity", true);
	settings = readSettings(workingDir);
	assert(verbosity.newValue === true, "verbosity result reports full output");
	assert((settings.verbose as any).default === true, "verbosity writes the durable verbose default");
	const messagesOnly = applySelfConfiguration(workingDir, "verbose", "messages_only");
	settings = readSettings(workingDir);
	assert(messagesOnly.newValue === "messages-only", "verbose alias normalizes messages-only");
	assert((settings.verbose as any).default === "messages-only", "verbose alias updates the durable default");
	applySelfConfiguration(workingDir, "verbosity", "messages-only");
	const slackVerbosity = applySelfConfiguration(workingDir, "slack.verbosity", true);
	settings = readSettings(workingDir);
	assert(slackVerbosity.newValue === true, "Slack verbosity reports full output");
	assert((settings.verbose as any).default === "messages-only", "Slack verbosity preserves the global default");
	assert((settings.verbose as any).slack === true, "Slack verbosity writes a platform-wide override");

	const placement = applySelfConfiguration(workingDir, "slack.response_placement", "inbound_thread");
	settings = readSettings(workingDir);
	assert(placement.newValue === "thread", "Slack placement normalizes inbound-thread alias");
	assert((settings.slack as any).responsePlacement === "thread", "Slack placement writes its durable settings block");
	const channelPlacement = applySelfConfiguration(workingDir, "slack.responsePlacement", "new_channel_message");
	settings = readSettings(workingDir);
	assert(channelPlacement.newValue === "channel", "Slack placement alias normalizes new-channel-message");
	assert((settings.slack as any).responsePlacement === "channel", "Slack placement alias updates the durable setting");

	const selectiveStreaming = applySelfConfiguration(workingDir, "slack.tool_streaming", "selected");
	settings = readSettings(workingDir);
	assert(selectiveStreaming.newValue === "important", "Slack tool streaming normalizes selected to important");
	assert((settings.slack as any).toolStreaming === "important", "Slack tool streaming writes its durable settings block");
	const quietStreaming = applySelfConfiguration(workingDir, "tool_streaming", "quiet");
	settings = readSettings(workingDir);
	assert(quietStreaming.newValue === "off", "natural tool-streaming alias normalizes quiet to off");
	assert((settings.slack as any).toolStreaming === "off", "tool-streaming alias updates the Slack setting");
	const allStreaming = applySelfConfiguration(workingDir, "slack.toolStreaming", "everything");
	settings = readSettings(workingDir);
	assert(allStreaming.newValue === "all", "camelCase tool-streaming alias normalizes everything to all");
	assert((settings.slack as any).toolStreaming === "all", "camelCase tool-streaming alias persists all mode");
	const condensedPresentation = applySelfConfiguration(workingDir, "slack.tool_stream_presentation", "one_message");
	settings = readSettings(workingDir);
	assert(condensedPresentation.newValue === "condensed", "Slack tool-stream presentation normalizes one-message language");
	assert((settings.slack as any).toolStreamPresentation === "condensed", "condensed tool-stream presentation persists inside Slack settings");
	const splitPresentation = applySelfConfiguration(workingDir, "slack.toolStreamLayout", "grouped");
	settings = readSettings(workingDir);
	assert(splitPresentation.newValue === "split", "tool-stream layout alias normalizes grouped language to split");
	assert((settings.slack as any).toolStreamPresentation === "split", "split tool-stream presentation replaces the prior value");
	const windowMinutes = applySelfConfiguration(workingDir, "slack.tool_stream_group_minutes", "4");
	settings = readSettings(workingDir);
	assert(windowMinutes.newValue === 4, "tool-stream group-minutes alias accepts a numeric string");
	assert((settings.slack as any).toolStreamWindowMinutes === 4, "tool-stream window persists inside Slack settings");
	const nativeProgress = applySelfConfiguration(workingDir, "slack.nativeProgress", "on");
	settings = readSettings(workingDir);
	assert(nativeProgress.newValue === true, "native progress alias accepts natural booleans");
	assert((settings.slack as any).nativeProgress === true, "native progress persists inside the Slack settings block");

	const discordSelectiveStreaming = applySelfConfiguration(workingDir, "discord.tool_streaming", "selected");
	settings = readSettings(workingDir);
	assert(discordSelectiveStreaming.newValue === "important", "Discord tool streaming normalizes selected to important");
	assert((settings.discord as any).toolStreaming === "important", "Discord tool streaming writes its durable settings block");
	const discordAllStreaming = applySelfConfiguration(workingDir, "discord.toolStreaming", "everything");
	settings = readSettings(workingDir);
	assert(discordAllStreaming.newValue === "all", "Discord camelCase tool-streaming alias normalizes everything to all");
	assert((settings.discord as any).toolStreaming === "all", "Discord camelCase tool-streaming alias persists all mode");
	const discordCondensedPresentation = applySelfConfiguration(workingDir, "discord.tool_stream_presentation", "one_message");
	settings = readSettings(workingDir);
	assert(discordCondensedPresentation.newValue === "condensed", "Discord tool-stream presentation normalizes one-message language");
	assert((settings.discord as any).toolStreamPresentation === "condensed", "Discord condensed presentation persists");
	const discordSplitPresentation = applySelfConfiguration(workingDir, "discord.toolStreamLayout", "grouped");
	settings = readSettings(workingDir);
	assert(discordSplitPresentation.newValue === "split", "Discord tool-stream layout alias normalizes grouped language");
	assert((settings.discord as any).toolStreamPresentation === "split", "Discord split presentation replaces the prior value");
	const discordWindowMinutes = applySelfConfiguration(workingDir, "discord.tool_stream_group_minutes", "4");
	settings = readSettings(workingDir);
	assert(discordWindowMinutes.newValue === 4, "Discord tool-stream group-minutes alias accepts a numeric string");
	assert((settings.discord as any).toolStreamWindowMinutes === 4, "Discord tool-stream window persists inside Discord settings");

	const spontaneity = applySelfConfiguration(workingDir, "spontaneity.level", 5);
	settings = readSettings(workingDir);
	assert((settings.spontaneity as any).level === 5, "spontaneity level writes settings");
	assert((settings.spontaneity as any).intervalMinutes === 45, "spontaneity level recomputes interval");
	assert(existsSync(join(workingDir, "attention", "queue", "heartbeat.json")), "spontaneity change resyncs heartbeat schedule");
	assert(spontaneity.schedule?.enabled === true, "spontaneity result reports schedule");

	const checklist = applySelfConfiguration(workingDir, "heartbeat.checklist", "Check the inbox.");
	assert(checklist.path === "HEARTBEAT.md", "heartbeat checklist reports file path");
	assert(readFileSync(join(workingDir, "HEARTBEAT.md"), "utf-8") === "Check the inbox.", "heartbeat checklist writes file");

	const voice = applySelfConfiguration(workingDir, "realtime_voice", "cedar");
	settings = readSettings(workingDir);
	assert(voice.newValue === "cedar", "realtime voice result reports selected voice");
	assert(settings.realtimeVoice === "cedar", "realtime_voice writes realtimeVoice");
	const voiceAlias = applySelfConfiguration(workingDir, "voice", "marin");
	settings = readSettings(workingDir);
	assert(voiceAlias.newValue === "marin", "voice alias reports selected voice");
	assert(settings.realtimeVoice === "marin", "voice alias writes realtimeVoice");
	const wakeAliases = applySelfConfiguration(workingDir, "voice.wakeAliases", ["Lantern", "lantern", "Orbit"]);
	settings = readSettings(workingDir);
	assert(JSON.stringify(wakeAliases.newValue) === JSON.stringify(["Lantern", "Orbit"]), "wake aliases deduplicate case-insensitively");
	assert(JSON.stringify((settings.voice as any).aliases) === JSON.stringify(["Lantern", "Orbit"]), "wake aliases persist in the voice settings block");
	const webhookSteer = applySelfConfiguration(workingDir, "voice.webhookInputMode", "soft_steer");
	settings = readSettings(workingDir);
	assert(webhookSteer.previousValue === "interrupt", "voice webhook routing defaults to interrupt");
	assert(webhookSteer.newValue === "steer", "voice webhook routing normalizes soft-steer language");
	assert((settings.voice as any).webhookInputMode === "steer", "voice webhook routing persists alongside wake aliases");
	assert(JSON.stringify((settings.voice as any).aliases) === JSON.stringify(["Lantern", "Orbit"]), "voice webhook routing preserves wake aliases");
	const webhookInterrupt = applySelfConfiguration(workingDir, "voice.webhook_mode", "restart");
	settings = readSettings(workingDir);
	assert(webhookInterrupt.newValue === "interrupt", "voice webhook mode alias normalizes restart to interrupt");
	assert((settings.voice as any).webhookInputMode === "interrupt", "voice webhook mode alias updates the durable setting");

	const tool = createSelfConfigureTool(workingDir);
	const settingDescription = (tool.parameters as any).properties.setting.description as string;
	assert(settingDescription.includes("voice.wake_aliases"), "self_configure schema exposes compact wake aliases");
	assert(settingDescription.includes("voice.webhook_input_mode"), "self_configure schema exposes voice webhook routing");
	assert(!settingDescription.includes("speak.auto"), "self_configure schema does not expose speak.auto");
	assert(!tool.description.toLowerCase().includes("automatic local sag"), "self_configure metadata does not advertise automatic SAG speech");

	for (const removedSetting of ["speak.auto", "auto_speak", "autoSpeak", "sag", "sag.enabled", "speak.automatic"]) {
		try {
			applySelfConfiguration(workingDir, removedSetting, true);
			assert(false, `${removedSetting} is rejected`);
		} catch (err) {
			assert(err instanceof Error && err.message.includes("Unknown self_configure setting"), `${removedSetting} is rejected`);
		}
	}

	try {
		await (tool.execute as any)("call-removed-speech", {
			label: "removed setting",
			setting: "speak.auto",
			value: true,
		});
		assert(false, "self_configure tool rejects speak.auto");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("Unknown self_configure setting"), "self_configure tool rejects speak.auto");
	}

	const result = await (tool.execute as any)("call-1", {
		label: "set thinking high",
		setting: "thinking_level",
		value: "high",
	});
	settings = readSettings(workingDir);
	assert(settings.thinking_level === "high", "tool execute applies setting");
	assert((result.content?.[0]?.text || "").includes("Configured thinking_level"), "tool result summarizes setting");

	try {
		applySelfConfiguration(workingDir, "slack.response_placement", "somewhere");
		assert(false, "invalid Slack placement throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("thread"), "invalid Slack placement explains accepted values");
	}

	try {
		applySelfConfiguration(workingDir, "slack.tool_streaming", "maximum-jazz");
		assert(false, "invalid Slack tool-streaming mode throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("important"), "invalid Slack tool-streaming mode explains accepted values");
	}

	try {
		applySelfConfiguration(workingDir, "slack.tool_stream_presentation", "maximum-jazz");
		assert(false, "invalid Slack tool-stream presentation throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("split"), "invalid Slack tool-stream presentation explains accepted values");
	}

	try {
		applySelfConfiguration(workingDir, "slack.tool_stream_window_minutes", 0);
		assert(false, "unsafe Slack tool-stream window throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("1"), "invalid Slack tool-stream window explains its safe range");
	}

	try {
		applySelfConfiguration(workingDir, "discord.tool_streaming", "maximum-jazz");
		assert(false, "invalid Discord tool-streaming mode throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("important"), "invalid Discord tool-streaming mode explains accepted values");
	}

	try {
		applySelfConfiguration(workingDir, "discord.tool_stream_presentation", "maximum-jazz");
		assert(false, "invalid Discord tool-stream presentation throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("split"), "invalid Discord tool-stream presentation explains accepted values");
	}

	try {
		applySelfConfiguration(workingDir, "discord.tool_stream_window_minutes", 0);
		assert(false, "unsafe Discord tool-stream window throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("1"), "invalid Discord tool-stream window explains its safe range");
	}

	try {
		applySelfConfiguration(workingDir, "voice.webhook_input_mode", "sometimes");
		assert(false, "invalid voice webhook input mode throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("interrupt"), "invalid voice webhook input mode explains accepted values");
	}

	try {
		applySelfConfiguration(workingDir, "not_a_real_setting", true);
		assert(false, "unsupported setting throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("Unknown self_configure setting"), "unsupported setting fails closed");
	}
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
