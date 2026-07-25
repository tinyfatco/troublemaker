import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PlatformAdapter } from "../src/adapters/types.js";
import { collectEmailThreadListings } from "../src/adapters/email/thread-ledger.js";
import { collectChannels, collectChannelsFromLog, collectPhoneConversations, collectSlackThreads, collectSlackThreadsFromLog, formatChannelTable } from "../src/tools/list-channels.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ok ${msg}`);
	} else {
		failed++;
		console.error(`  FAIL ${msg}`);
	}
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-list-channels-"));

try {
	const rows = [
		{
			date: "2026-05-26T08:00:00.000Z",
			ts: "1700000010.000100",
			threadTs: "1700000010.000100",
			channel: "slack:#tinyfat",
			channelId: "C0123456789",
			user: "UROOT",
			displayName: "Casey",
			text: "Root one: decide where the reply belongs",
			isBot: false,
		},
		{
			date: "2026-05-26T08:01:00.000Z",
			ts: "1779777001.000200",
			threadTs: "1700000010.000100",
			channel: "slack:#tinyfat",
			channelId: "C0123456789",
			user: "UAGENT",
			text: "Reply in root one",
			isBot: true,
		},
		{
			date: "2026-05-26T08:02:00.000Z",
			ts: "1700000020.000300",
			threadTs: "1700000020.000300",
			channel: "slack:#tinyfat",
			channelId: "C0123456789",
			user: "UOTHER",
			displayName: "Mike",
			text: "Root two: this is a separate thread",
			isBot: false,
		},
		{
			date: "2026-05-26T08:02:30.000Z",
			ts: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
			threadTs: "nnnnnnnnnnnnnnnnnnnnnnnnnn",
			channel: "mattermost:agents",
			channelId: "mmmmmmmmmmmmmmmmmmmmmmmmmm",
			text: "Mattermost migration thread",
			isBot: false,
		},
		{
			date: "2026-05-26T08:02:45.000Z",
			ts: "rocketRoot654321",
			threadTs: "rocketRoot654321",
			channel: "rocket-chat:customer-example",
			channelId: "rocketRoom123456",
			text: "Rocket.Chat relationship thread",
			isBot: false,
		},
		{
			date: "2026-05-26T08:03:00.000Z",
			channel: "telegram:DM:Casey",
			channelId: "1234567890",
			text: "hello",
		},
		{
			date: "2026-05-26T08:04:00.000Z",
			ts: "2026-05-26T08:04:00.000Z",
			channel: "phone:sms/+15551234567",
			channelId: "phone-abc123",
			user: "+15551234567",
			text: "Can the group meet tomorrow?",
			isBot: false,
			transport: "sms",
		},
	];
	writeFileSync(join(workingDir, "log.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	writeFileSync(join(workingDir, "email-thread-events.jsonl"), [
		{
			type: "inbound",
			at: "2026-05-26T08:05:00.000Z",
			channelId: "email-alex_example_com",
			from: "casey@example.com",
			to: ["agent@example.com"],
			subject: "Project timing",
			body: "Can you update this thread?",
			messageId: "<root@example.com>",
		},
		{
			type: "outbound",
			at: "2026-05-26T08:06:00.000Z",
			channelId: "email-alex_example_com",
			to: ["casey@example.com"],
			subject: "Re: Project timing",
			body: "Yes, I will update it here.",
			inReplyTo: "<root@example.com>",
			references: "<root@example.com>",
		},
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	writeFileSync(join(workingDir, "phone-channels.json"), JSON.stringify({
		version: 1,
		channels: {
			"phone-abc123": {
				channelId: "phone-abc123",
				transport: "sms",
				displayName: "sms/group-site-team",
				participants: ["+15551234567", "+15557654321", "+15550001111"],
				updatedAt: "2026-05-26T08:04:00.000Z",
			},
		},
	}, null, 2));

	const channels = collectChannelsFromLog(workingDir);
	const liveZulipAdapter = {
		name: "zulip",
		getAllChannels: () => [{ id: "4", name: "customer · Casey" }],
	} as unknown as PlatformAdapter;
	const channelsWithLiveAdapter = collectChannels(workingDir, [liveZulipAdapter]);
	const threads = collectSlackThreadsFromLog(workingDir);
	const emailThreads = collectEmailThreadListings(workingDir);
	const phoneConversations = collectPhoneConversations(workingDir);
	const apiOnlyThreadTarget = "slack:C0123456789:1700000030.000500";
	const slackApiAdapter = {
		name: "slack",
		listThreads: async () => [
			{
				channelId: "C0123456789",
				channelName: "tinyfat",
				threadTs: "1700000010.000100",
				sendTarget: "slack:C0123456789:1700000010.000100",
				rootPreview: "Root one from Slack API with current metadata",
				lastPreview: "Latest Slack API view of root one",
				participants: ["Casey", "Agent"],
				messageCount: 3,
				lastSeen: "2026-05-26T08:05:00.000Z",
				source: "slack-api" as const,
			},
			{
				channelId: "C0123456789",
				channelName: "tinyfat",
				threadTs: "1700000030.000500",
				sendTarget: apiOnlyThreadTarget,
				rootPreview: "Root three: visible only from Slack API",
				lastPreview: "Root three: visible only from Slack API",
				participants: ["Sam"],
				messageCount: 1,
				lastSeen: "2026-05-26T08:04:00.000Z",
				source: "slack-api" as const,
			},
		],
	} as unknown as PlatformAdapter;
	const throwingSlackApiAdapter = {
		name: "slack",
		listThreads: async () => {
			throw new Error("Slack unavailable");
		},
	} as unknown as PlatformAdapter;
	const combinedThreads = await collectSlackThreads(workingDir, [slackApiAdapter]);
	const fallbackThreads = await collectSlackThreads(workingDir, [throwingSlackApiAdapter]);
	const table = formatChannelTable(channels, threads, emailThreads, phoneConversations);
	const combinedTable = formatChannelTable(channels, combinedThreads, emailThreads, phoneConversations);

	assert(channels.some((c) => c.adapter === "slack" && c.id === "C0123456789"), "channel list still includes Slack channel target");
	assert(
		channelsWithLiveAdapter.some((c) => c.adapter === "zulip" && c.id === "4" && c.name === "customer · Casey"),
		"live adapter membership exposes a send-ready channel before it has a log row",
	);
	assert(
		formatChannelTable(channelsWithLiveAdapter).includes("`zulip:4`"),
		"live Zulip membership formats as an explicit send target",
	);
	assert(channels.some((c) => c.adapter === "mattermost" && c.id === "mmmmmmmmmmmmmmmmmmmmmmmmmm"), "channel list includes Mattermost channel targets");
	assert(table.includes("`mattermost:mmmmmmmmmmmmmmmmmmmmmmmmmm`"), "formatted output uses an explicit Mattermost send target");
	assert(channels.some((c) => c.adapter === "rocket-chat" && c.id === "rocketRoom123456"), "channel list includes Rocket.Chat room targets");
	assert(table.includes("`rocket-chat:rocketRoom123456`"), "formatted output uses an explicit Rocket.Chat send target");
	assert(threads.length === 2, "two Slack thread roots stay distinct");
	assert(threads.every((t) => t.source === "log"), "log-discovered thread targets are labeled as local log");
	assert(threads.some((t) => t.sendTarget === "slack:C0123456789:1700000010.000100"), "first thread exposes exact send target");
	assert(threads.some((t) => t.sendTarget === "slack:C0123456789:1700000020.000300"), "second thread exposes exact send target");
	assert(threads.find((t) => t.threadTs === "1700000010.000100")?.participants.includes("Agent"), "bot replies are participant context, not a separate target");
	assert(combinedThreads.some((t) => t.sendTarget === apiOnlyThreadTarget), "Slack API thread discovery adds targets not present in local log");
	assert(combinedThreads.some((t) => t.source === "slack-api"), "Slack API-discovered thread targets are source labeled");
	assert(combinedThreads.find((t) => t.threadTs === "1700000010.000100")?.rootPreview === "Root one from Slack API with current metadata", "Slack API metadata wins over stale local log rows for the same thread");
	assert(combinedThreads.some((t) => t.sendTarget === "slack:C0123456789:1700000010.000100"), "log fallback remains available alongside API targets");
	assert(fallbackThreads.length === threads.length && fallbackThreads.every((t) => t.source === "log"), "Slack API failures fall back to local log thread targets");
	assert(table.includes("Recent Slack thread targets:"), "formatted output has a Slack thread section");
	assert(table.includes("Root one: decide where the reply belongs"), "formatted output keeps root preview for nuance");
	assert(table.includes("Root two: this is a separate thread"), "formatted output keeps separate root preview");
	assert(table.includes("`slack:C0123456789:1700000020.000300`"), "formatted output shows send_message-ready thread target");
	assert(combinedTable.includes("Slack API"), "formatted output tells the agent when a target came from Slack API");
	assert(combinedTable.includes("local log"), "formatted output tells the agent when a target came from local log fallback");
	assert(emailThreads.length === 1, "email ledger produces a thread target");
	assert(emailThreads[0]?.sendTarget.startsWith("email-thread:"), "email thread target is send_message-ready");
	assert(table.includes("Recent email thread targets:"), "formatted output has an email thread section");
	assert(table.includes("Project timing"), "email thread listing keeps subject context");
	assert(phoneConversations.length === 1, "phone registry produces a conversation target");
	assert(phoneConversations[0]?.participants.includes("+15557654321"), "phone conversation listing includes group participants");
	assert(table.includes("Recent phone conversation targets:"), "formatted output has a phone conversation section");
	assert(table.includes("sms/group-site-team"), "phone conversation listing keeps registry display name");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
