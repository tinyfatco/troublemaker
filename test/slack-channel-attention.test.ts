import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackSocketAdapter } from "../src/adapters/slack-socket.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import { MomSettingsManager } from "../src/context.js";
import type { ChannelStore } from "../src/store.js";
import { applySelfConfiguration, createSelfConfigureTool } from "../src/tools/self-configure.js";

const workingDir = mkdtempSync(join(tmpdir(), "tm-slack-channel-attention-"));
const BOT_ID = "U1111111111";
const QUIET = "C0QUIET001";
const LOUD = "C0LOUD0002";

function slackSettings(): Record<string, unknown> {
	const parsed = JSON.parse(readFileSync(join(workingDir, "settings.json"), "utf-8"));
	return (parsed.slack ?? {}) as Record<string, unknown>;
}

function handler(events: MomEvent[]): MomHandler {
	return {
		isRunning: () => false,
		handleEvent: async (event) => { events.push(event); },
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
}

function message(channel: string, text: string, channelType = "channel", ts = "1710000000.000100") {
	return {
		event: { type: "message", channel, channel_type: channelType, user: "U_HUMAN", text, ts },
		body: { team_id: "T_EXAMPLE" },
		ack: () => {},
	};
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

try {
	// --- self_configure surface ---
	const tool = createSelfConfigureTool(workingDir);
	const settingDescription = (tool.parameters as any).properties.setting.description as string;
	assert(settingDescription.includes("slack.channel_attention"), "schema exposes slack.channel_attention");
	assert(tool.description.includes("slack.channel_attention"), "tool description explains Slack attention");

	const here = createSelfConfigureTool(workingDir, {
		resolveWorkingOutputTarget: () => ({ platform: "slack", channelId: QUIET }),
	});
	await (here.execute as any)("call-slack-here", {
		label: "mentions only here",
		setting: "slack.channel_attention",
		value: { mode: "mentions-only", channel: "here" },
	});
	assert.deepEqual(slackSettings().mentionsOnlyChannelIds, [QUIET], "'here' persists the current Slack channel");
	assert.equal(new MomSettingsManager(workingDir).getSlackChannelAttention(LOUD), "ambient", "other channels stay ambient");

	// Bare mode string defaults to channel "here".
	const bare = createSelfConfigureTool(workingDir, {
		resolveWorkingOutputTarget: () => ({ platform: "slack", channelId: LOUD }),
	});
	await (bare.execute as any)("call-slack-bare", { label: "mute", setting: "slack.attention", value: "ignore" });
	assert.deepEqual(slackSettings().mentionsOnlyChannelIds, [LOUD, QUIET].sort(), "bare mode + alias applies to current channel");
	applySelfConfiguration(workingDir, "slack.channelAttention", { mode: "ambient", channel: LOUD });
	assert.deepEqual(slackSettings().mentionsOnlyChannelIds, [QUIET], "explicit channel ID resumes ambient");

	assert.throws(
		() => applySelfConfiguration(workingDir, "slack.channel_attention", { mode: "mentions-only", channel: "here" }),
		/requires an active Slack channel turn/,
		"'here' without a Slack turn fails closed",
	);
	const mattermostTurn = createSelfConfigureTool(workingDir, {
		resolveWorkingOutputTarget: () => ({ platform: "mattermost", channelId: "abcdefghijklmnopqrstuvwxyz" }),
	});
	await assert.rejects(
		(mattermostTurn.execute as any)("call-wrong-platform", {
			label: "wrong platform",
			setting: "slack.channel_attention",
			value: { mode: "mentions-only", channel: "here" },
		}),
		/requires an active Slack channel turn/,
	);
	assert.throws(
		() => applySelfConfiguration(workingDir, "slack.channel_attention", { mode: "mentions-only", channel: "D0DMCHAN01" }),
		/does not apply to DMs/,
	);
	assert.throws(
		() => applySelfConfiguration(workingDir, "slack.channel_attention", { mode: "mentions-only", channel: "not-a-channel" }),
		/valid Slack C\/G channel ID/,
	);
	assert.throws(
		() => applySelfConfiguration(workingDir, "slack.channel_attention", { mode: "sometimes", channel: QUIET }),
		/must be "ambient" or "mentions-only"/,
	);

	// --- adapter gating ---
	const ambient: string[] = [];
	const events: MomEvent[] = [];
	const socket = new SlackSocketAdapter({
		appToken: "xapp-test",
		botToken: "xoxb-test",
		workingDir,
		store: { processAttachments: () => [] } as unknown as ChannelStore,
		onAmbientMessage: (channelId) => ambient.push(channelId),
	});
	socket.setHandler(handler(events));
	(socket as any).botUserId = BOT_ID;
	(socket as any).webClient = {
		conversations: { info: async ({ channel }: { channel: string }) => ({ channel: { id: channel, name: "c" } }) },
	};
	(socket as any).setupEventHandlers();
	const onMessage = (socket as any).socketClient.listeners("message")[0] as (p: any) => Promise<void>;

	await onMessage(message(QUIET, "ordinary chatter", "channel", "1710000000.000101"));
	await onMessage(message(LOUD, "ordinary chatter", "channel", "1710000000.000102"));
	await settle();
	assert.deepEqual(ambient, [LOUD], "mentions-only channel skips ambient evaluation; ambient channel does not");

	await onMessage(message(QUIET, "<!here> please look", "channel", "1710000000.000103"));
	await settle();
	assert(events.some((e) => e.channel === QUIET), "broadcast mention still wakes the agent in a mentions-only channel");

	// Workspace-wide toggle.
	ambient.length = 0;
	applySelfConfiguration(workingDir, "slack.channel_attention", { mode: "mentions-only", channel: "all" });
	assert.equal(slackSettings().mentionsOnlyAllChannels, true, "'all' persists workspace-wide mentions-only");
	await onMessage(message(LOUD, "more chatter", "channel", "1710000000.000104"));
	await settle();
	assert.deepEqual(ambient, [], "workspace-wide mentions-only suppresses ambient everywhere");

	const partial = applySelfConfiguration(workingDir, "slack.channel_attention", { mode: "ambient", channel: QUIET });
	assert.equal((partial.newValue as any).mode, "mentions-only", "per-channel ambient reports the effective mode while 'all' is on");
	assert.match(partial.note ?? "", /workspace-wide Slack mentions-only is still on/);

	applySelfConfiguration(workingDir, "slack.channel_attention", { mode: "ambient", channel: "all" });
	const cleared = slackSettings();
	assert.equal(cleared.mentionsOnlyAllChannels, undefined, "ambient 'all' clears the workspace flag");
	assert.equal(cleared.mentionsOnlyChannelIds, undefined, "ambient 'all' clears per-channel entries");
	await onMessage(message(QUIET, "back to normal", "channel", "1710000000.000105"));
	await settle();
	assert.deepEqual(ambient, [QUIET], "ambient evaluation resumes after clearing");

	console.log("slack channel attention tests passed");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
