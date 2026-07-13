import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackWebhookAdapter } from "../src/adapters/slack-webhook.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

const workingDir = mkdtempSync(join(tmpdir(), "tm-slack-ambient-origin-"));

try {
	const store = { processAttachments: () => [] } as unknown as ChannelStore;
	const ambient: Array<{ adapter: PlatformAdapter; channelId: string; event: MomEvent }> = [];
	const adapter = new SlackWebhookAdapter({
		botToken: "xoxb-test",
		signingSecret: "",
		workingDir,
		store,
		onAmbientMessage: (channelId, event, origin) => ambient.push({ adapter: origin, channelId, event }),
	});
	const handler: MomHandler = {
		isRunning: () => false,
		handleEvent: async () => {},
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
	adapter.setHandler(handler);

	(adapter as any).webClient = {
		conversations: {
			info: async ({ channel }: { channel: string }) => ({ channel: { id: channel, name: "new-room" } }),
		},
	};

	const channelId = "C1111111111";
	assert.equal(adapter.getChannel(channelId), undefined, "post-start channel is absent from the startup snapshot");

	await (adapter as any).handleMessage({
		type: "message",
		channel: channelId,
		channel_type: "channel",
		user: "U1111111111",
		text: "ordinary ambient chatter",
		ts: "1710000000.000100",
	}, "T1111111111");
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(ambient.length, 1, "first ambient message in a post-start channel reaches the ambient callback");
	assert.equal(ambient[0]?.adapter, adapter, "ambient callback retains the exact receiving Slack adapter");
	assert.equal(ambient[0]?.channelId, channelId, "ambient callback retains the originating channel");
	assert.equal(ambient[0]?.event.teamId, "T1111111111", "ambient callback retains the originating workspace");
	assert.equal(adapter.getChannel(channelId)?.name, "new-room", "live traffic adds and refreshes a newly joined channel");

	console.log("slack-ambient-origin ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
