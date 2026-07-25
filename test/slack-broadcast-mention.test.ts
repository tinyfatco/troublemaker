import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasSlackBroadcastMention, stripSlackBroadcastMentions } from "../src/adapters/slack-addressing.js";
import { SlackSocketAdapter } from "../src/adapters/slack-socket.js";
import { SlackWebhookAdapter } from "../src/adapters/slack-webhook.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

const workingDir = mkdtempSync(join(tmpdir(), "tm-slack-broadcast-mention-"));
const BOT_ID = "U1111111111";

function handler(events: MomEvent[], steers: MomEvent[], runningChannel?: string): MomHandler {
	return {
		isRunning: (channelId) => channelId === runningChannel,
		handleEvent: async (event) => { events.push(event); },
		handleSlashCommand: async () => false,
		handleSteer: (event) => { steers.push(event); },
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
}

function socketMessageListener(adapter: SlackSocketAdapter): (payload: any) => Promise<void> {
	(adapter as any).setupEventHandlers();
	const listeners = (adapter as any).socketClient.listeners("message");
	assert.equal(listeners.length, 1, "socket adapter registers one message listener");
	return listeners[0];
}

function socketAppMentionListener(adapter: SlackSocketAdapter): (payload: any) => Promise<void> {
	const listeners = (adapter as any).socketClient.listeners("app_mention");
	assert.equal(listeners.length, 1, "socket adapter registers one app_mention listener");
	return listeners[0];
}

function channelMessage(channel: string, text: string, user = "U_HUMAN") {
	return {
		event: {
			type: "message",
			channel,
			channel_type: "channel",
			user,
			text,
			ts: "1710000000.000100",
		},
		body: { team_id: "T_EXAMPLE" },
	};
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

try {
	assert.equal(hasSlackBroadcastMention("<!channel> please coordinate"), true);
	assert.equal(hasSlackBroadcastMention("<!here> please coordinate"), true);
	assert.equal(hasSlackBroadcastMention("<!everyone> please coordinate"), true);
	assert.equal(hasSlackBroadcastMention("plain @channel text"), false, "only Slack's canonical broadcast token wakes agents");
	assert.equal(stripSlackBroadcastMentions("<!channel> hello <!here>"), "hello");

	const store = { processAttachments: () => [] } as unknown as ChannelStore;
	const socketEvents: MomEvent[] = [];
	const socketSteers: MomEvent[] = [];
	const socketAmbient: Array<{ channelId: string; event: MomEvent; origin: PlatformAdapter }> = [];
	const socket = new SlackSocketAdapter({
		appToken: "xapp-test",
		botToken: "xoxb-test",
		workingDir,
		store,
		onAmbientMessage: (channelId, event, origin) => socketAmbient.push({ channelId, event, origin }),
	});
	socket.setHandler(handler(socketEvents, socketSteers, "C_RUNNING"));
	(socket as any).botUserId = BOT_ID;
	(socket as any).webClient = {
		conversations: {
			info: async ({ channel }: { channel: string }) => ({ channel: { id: channel, name: "test-channel" } }),
		},
	};
	const onSocketMessage = socketMessageListener(socket);
	const onSocketAppMention = socketAppMentionListener(socket);

	let acknowledgements = 0;
	await onSocketMessage({
		...channelMessage("C_IDLE", "<!channel> coordinate the launch"),
		ack: () => { acknowledgements++; },
	});
	await settle();
	assert.equal(acknowledgements, 1, "broadcast message is acknowledged exactly once");
	assert.equal(socketEvents.length, 1, "@channel starts a normal Socket Mode run");
	assert.equal(socketEvents[0]?.text, "coordinate the launch", "broadcast token is removed from the model prompt");
	assert.equal(socketEvents[0]?.rawText, "<!channel> coordinate the launch", "raw Slack text remains available for audit context");
	assert.equal(socketEvents[0]?.sourceEventType, "slack_broadcast_mention");
	assert.equal(socketEvents[0]?.directlyAddressed, true);
	assert.equal(socketEvents[0]?.threadTs, "1710000000.000100");
	assert.equal(socketAmbient.length, 0, "broadcast addressing bypasses ambient evaluation");

	await onSocketMessage({
		...channelMessage("C_RUNNING", "<!here> use the latest context"),
		ack: () => { acknowledgements++; },
	});
	await settle();
	assert.equal(socketSteers.length, 1, "a broadcast mention steers an active channel run like a direct mention");
	assert.equal(socketSteers[0]?.text, "use the latest context");

	await onSocketAppMention({
		event: {
			type: "app_mention",
			channel: "C_RUNNING",
			user: "U_HUMAN",
			text: `<@${BOT_ID}> steer this exact instruction`,
			ts: "1710000001.000200",
		},
		body: { team_id: "T_EXAMPLE" },
		ack: () => { acknowledgements++; },
	});
	await settle();
	assert.equal(socketSteers.length, 2, "a direct app mention enters the busy steering path");
	assert.equal(socketSteers[1]?.sourceEventType, "slack_app_mention");
	assert.equal(socketSteers[1]?.text, "steer this exact instruction");

	await onSocketMessage({
		...channelMessage("C_IDLE", "ordinary channel chatter"),
		ack: () => { acknowledgements++; },
	});
	await settle();
	assert.equal(socketAmbient.length, 1, "ordinary channel text remains ambient");

	await onSocketMessage({
		...channelMessage("C_IDLE", "<!channel> ignore the bot's own echo", BOT_ID),
		ack: () => { acknowledgements++; },
	});
	await settle();
	assert.equal(socketEvents.length, 1, "the bot's own broadcast message is still suppressed");

	await onSocketMessage({
		...channelMessage("C_IDLE", `<!channel> <@${BOT_ID}> only once`),
		ack: () => { acknowledgements++; },
	});
	await settle();
	assert.equal(socketEvents.length, 1, "a direct bot mention remains owned by app_mention without duplicate message handling");

	const webhookEvents: MomEvent[] = [];
	const webhookSteers: MomEvent[] = [];
	const webhookAmbient: MomEvent[] = [];
	const webhook = new SlackWebhookAdapter({
		botToken: "xoxb-test",
		signingSecret: "test-signing-secret",
		workingDir,
		store,
		onAmbientMessage: (_channelId, event) => webhookAmbient.push(event),
	});
	webhook.setHandler(handler(webhookEvents, webhookSteers, "C_WEBHOOK_RUNNING"));
	(webhook as any).botUserId = BOT_ID;
	(webhook as any).webClient = {
		conversations: {
			info: async ({ channel }: { channel: string }) => ({ channel: { id: channel, name: "test-channel" } }),
		},
	};

	await (webhook as any).handleMessage(channelMessage("C_WEBHOOK", "<!everyone> review this").event, "T_EXAMPLE");
	await webhook.lastRunDone;
	assert.equal(webhookEvents.length, 1, "@everyone starts a normal webhook-adapter run");
	assert.equal(webhookEvents[0]?.text, "review this");
	assert.equal(webhookEvents[0]?.sourceEventType, "slack_broadcast_mention");
	assert.equal(webhookEvents[0]?.directlyAddressed, true);
	assert.equal(webhookAmbient.length, 0, "webhook broadcast addressing bypasses ambient evaluation");

	await (webhook as any).handleMessage(channelMessage("C_WEBHOOK_RUNNING", "<!channel> incorporate this").event, "T_EXAMPLE");
	assert.equal(webhookSteers.length, 1, "webhook broadcast addressing steers an active run");
	assert.equal(webhookSteers[0]?.text, "incorporate this");

	console.log("slack-broadcast-mention ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
