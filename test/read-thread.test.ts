import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	collectMattermostThreadMessages,
	collectRocketChatThreadMessages,
	collectSlackThreadMessages,
	collectSlackThreadMessagesFromLog,
	collectThreadMessages,
	createReadThreadTool,
	formatSlackThreadTranscript,
	formatThreadTranscript,
	parseMattermostThreadTarget,
	parseRocketChatThreadTarget,
	parseSlackThreadTarget,
} from "../src/tools/read-thread.js";
import { collectEmailThreadListings } from "../src/adapters/email/thread-ledger.js";
import type { PlatformAdapter } from "../src/adapters/types.js";
import { Check } from "typebox/value";

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

const workingDir = mkdtempSync(join(tmpdir(), "tm-read-thread-"));

try {
	const readThreadTool = createReadThreadTool(workingDir);
	assert(!Check(readThreadTool.parameters, {
		target: "slack:C0123456789:1700000010.000100",
	}), "read_thread rejects calls without a visible label");
	assert(Check(readThreadTool.parameters, {
		label: "Reading the deploy QA thread",
		show: true,
		target: "slack:C0123456789:1700000010.000100",
	}), "read_thread accepts a human-readable label and optional show flag");

	const mattermostChannel = "mmmmmmmmmmmmmmmmmmmmmmmmmm";
	const mattermostRoot = "nnnnnnnnnnnnnnnnnnnnnnnnnn";
	const mattermostReply = "oooooooooooooooooooooooooo";
	const rocketRoom = "rocketRoom123456";
	const rocketRoot = "rocketRoot654321";
	const rocketReply = "rocketReply456789";
	const rows = [
		{
			date: "2026-05-26T08:00:00.000Z",
			ts: "1700000010.000100",
			threadTs: "1700000010.000100",
			channel: "slack:#tinyfat",
			channelId: "C0123456789",
			displayName: "Casey",
			text: "Thread one root: deploy QA",
			isBot: false,
			directlyAddressed: true,
			sourceEventType: "slack_app_mention",
		},
		{
			date: "2026-05-26T08:01:00.000Z",
			ts: "1779777001.000200",
			threadTs: "1700000010.000100",
			channel: "slack:#tinyfat",
			channelId: "C0123456789",
			userName: "agent",
			text: "I will check deploy QA in this thread.",
			isBot: true,
		},
		{
			date: "2026-05-26T08:02:00.000Z",
			ts: "1700000020.000300",
			threadTs: "1700000020.000300",
			channel: "slack:#tinyfat",
			channelId: "C0123456789",
			displayName: "Mike",
			text: "Thread two root: product feedback",
			isBot: false,
		},
		{
			date: "2026-05-26T08:03:00.000Z",
			ts: "1779777101.000400",
			threadTs: "1700000020.000300",
			channel: "slack:#tinyfat",
			channelId: "C0123456789",
			displayName: "Mike",
			text: "The feedback thread is about making thread replies less noisy.",
			isBot: false,
		},
	];
	writeFileSync(join(workingDir, "log.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	writeFileSync(join(workingDir, "email-thread-events.jsonl"), [
		{
			type: "inbound",
			at: "2026-05-26T10:00:00.000Z",
			channelId: "email-alex_example_com",
			from: "casey@example.com",
			to: ["agent@example.com"],
			subject: "Project timing",
			body: "Can you answer in this email thread?",
			messageId: "<email-root@example.com>",
		},
		{
			type: "outbound",
			at: "2026-05-26T10:01:00.000Z",
			channelId: "email-alex_example_com",
			to: ["casey@example.com"],
			subject: "Re: Project timing",
			body: "Yes, this reply should stay in the same native email thread.",
			inReplyTo: "<email-root@example.com>",
			references: "<email-root@example.com>",
		},
	].map((row) => JSON.stringify(row)).join("\n") + "\n");
	writeFileSync(join(workingDir, "phone-channels.json"), JSON.stringify({
		version: 1,
		channels: {
			"phone-abc123": {
				channelId: "phone-abc123",
				transport: "sms",
				displayName: "sms/group-site-team",
				participants: ["+15551234567", "+15557654321"],
				updatedAt: "2026-05-26T11:00:00.000Z",
			},
		},
	}, null, 2));
	writeFileSync(join(workingDir, "log.jsonl"), [
		...rows,
		{
			date: "2026-05-26T10:30:00.000Z",
			ts: mattermostRoot,
			threadTs: mattermostRoot,
			channel: "mattermost:agents",
			channelId: mattermostChannel,
			displayName: "Casey",
			text: "Mattermost migration root",
			isBot: false,
		},
		{
			date: "2026-05-26T10:31:00.000Z",
			ts: mattermostReply,
			threadTs: mattermostRoot,
			channel: "mattermost:agents",
			channelId: mattermostChannel,
			userName: "observer",
			text: "Mattermost migration reply",
			isBot: true,
		},
		{
			date: "2026-05-26T11:00:00.000Z",
			ts: "2026-05-26T11:00:00.000Z",
			channel: "phone:sms/group-site-team",
			channelId: "phone-abc123",
			displayName: "+15551234567",
			text: "Group text root",
			isBot: false,
		},
		{
			date: "2026-05-26T11:10:00.000Z",
			ts: rocketRoot,
			threadTs: rocketRoot,
			channel: "rocket-chat:customer-example",
			channelId: rocketRoom,
			displayName: "Operator",
			text: "Rocket.Chat relationship root",
			isBot: false,
		},
		{
			date: "2026-05-26T11:11:00.000Z",
			ts: rocketReply,
			threadTs: rocketRoot,
			channel: "rocket-chat:customer-example",
			channelId: rocketRoom,
			userName: "operator",
			text: "Rocket.Chat relationship reply",
			isBot: true,
		},
		{
			date: "2026-05-26T11:01:00.000Z",
			ts: "2026-05-26T11:01:00.000Z",
			channel: "phone:sms/group-site-team",
			channelId: "phone-abc123",
			user: "bot",
			text: "Phone group reply",
			isBot: true,
		},
		{
			date: "2026-05-26T11:20:00.000Z",
			ts: "201",
			threadTs: "Road map / alpha",
			channel: "zulip:projects",
			channelId: "4",
			displayName: "Casey",
			text: "Zulip topic root",
			isBot: false,
			directlyAddressed: true,
			sourceEventType: "zulip_mention",
		},
		{
			date: "2026-05-26T11:21:00.000Z",
			ts: "202",
			channel: "zulip:DM: Casey",
			channelId: "dm:8",
			displayName: "Casey",
			text: "Zulip direct hello",
			isBot: false,
			directlyAddressed: true,
			sourceEventType: "zulip_dm",
		},
	].map((row) => JSON.stringify(row)).join("\n") + "\n");

	assert(parseSlackThreadTarget("slack:C0123456789:1700000010.000100")?.channelId === "C0123456789", "valid Slack thread target parses");
	assert(parseSlackThreadTarget("C0123456789") === null, "plain Slack channel is not a thread target");
	assert(parseMattermostThreadTarget(`mattermost:${mattermostChannel}:${mattermostRoot}`)?.threadTs === mattermostRoot, "valid Mattermost thread target parses");
	assert(parseMattermostThreadTarget(`mattermost:${mattermostChannel}`) === null, "Mattermost channel without a root is not a thread target");
	assert(parseRocketChatThreadTarget(`rocket-chat:${rocketRoom}:${rocketRoot}`)?.threadTs === rocketRoot, "valid Rocket.Chat thread target parses");
	assert(parseRocketChatThreadTarget(`rocket-chat:${rocketRoom}`) === null, "Rocket.Chat room without a root is not a thread target");

	const first = collectSlackThreadMessagesFromLog(workingDir, "slack:C0123456789:1700000010.000100");
	const second = collectSlackThreadMessagesFromLog(workingDir, "slack:C0123456789:1700000020.000300");
	const missing = collectSlackThreadMessagesFromLog(workingDir, "slack:C0123456789:1700000099.999999");

	assert(first?.messages.length === 2, "first thread transcript includes only first thread messages");
	assert(first?.source === "log", "log transcript source is labeled");
	assert(first?.messages.some((m) => m.text.includes("deploy QA")), "first transcript preserves deploy QA nuance");
	assert(!first?.messages.some((m) => m.text.includes("product feedback")), "first transcript excludes second thread nuance");
	assert(first?.messages[0]?.isRoot === true, "root message is marked root");
	assert(first?.messages[1]?.isBot === true, "bot reply is marked Agent context");
	assert(second?.messages.length === 2, "second thread transcript includes second thread messages");
	assert(second?.messages.some((m) => m.text.includes("thread replies less noisy")), "second transcript preserves follow-up nuance");
	assert(missing?.messages.length === 0, "valid but unseen thread returns an empty transcript");

	const formatted = formatSlackThreadTranscript(second!);
	assert(formatted.includes("slack:C0123456789:1700000020.000300"), "formatted transcript names exact target");
	assert(formatted.includes("Source: local log"), "formatted transcript shows local log source");
	assert(formatted.includes("[root]"), "formatted transcript marks root");
	assert(formatted.includes("[reply]"), "formatted transcript marks replies");
	assert(!formatted.includes("deploy QA"), "formatted transcript does not leak other thread text");

	const slackApiAdapter = {
		name: "slack",
		readThread: async (channel: string, threadTs: string) => [
			{
				date: "2026-05-26T09:00:00.000Z",
				ts: threadTs,
				threadTs,
				channelId: channel,
				channelName: "tinyfat",
				sender: "Casey",
				text: "Authoritative Slack API root about billing",
				isRoot: true,
				isBot: false,
				sourceEventType: "slack_conversations_replies",
			},
			{
				date: "2026-05-26T09:01:00.000Z",
				ts: "1779777201.000600",
				threadTs,
				channelId: channel,
				channelName: "tinyfat",
				sender: "Mike",
				text: "API-only reply not present in log",
				isRoot: false,
				isBot: false,
				sourceEventType: "slack_conversations_replies",
			},
		],
	} as unknown as PlatformAdapter;
	const apiResult = await collectSlackThreadMessages(
		workingDir,
		"slack:C0123456789:1700000030.000500",
		[slackApiAdapter],
	);
	assert(apiResult?.source === "slack-api", "read_thread prefers live Slack API transcript when available");
	assert(apiResult?.messages.some((m) => m.text.includes("API-only reply")), "Slack API transcript can include messages not present in local log");
	assert(formatSlackThreadTranscript(apiResult!).includes("Source: Slack API"), "formatted API transcript shows Slack API source");

	const mattermostApiAdapter = {
		name: "mattermost",
		readThread: async (channel: string, threadTs: string) => [
			{
				date: "2026-05-26T10:30:00.000Z",
				ts: threadTs,
				threadTs,
				channelId: channel,
				channelName: "agents",
				sender: "Casey",
				text: "Authoritative Mattermost root",
				isRoot: true,
				isBot: false,
			},
		],
	} as unknown as PlatformAdapter;
	const mattermostResult = await collectMattermostThreadMessages(
		workingDir,
		`mattermost:${mattermostChannel}:${mattermostRoot}`,
		[mattermostApiAdapter],
	);
	assert(mattermostResult?.source === "mattermost-api", "read_thread prefers live Mattermost API transcript when available");
	assert(mattermostResult?.messages[0]?.text.includes("Authoritative Mattermost"), "Mattermost API transcript is preserved");
	assert(formatThreadTranscript(mattermostResult!).includes("Mattermost thread"), "generic formatter labels Mattermost threads");

	const mattermostFallback = await collectMattermostThreadMessages(
		workingDir,
		`mattermost:${mattermostChannel}:${mattermostRoot}`,
		[],
	);
	assert(mattermostFallback?.source === "log", "Mattermost transcript falls back to the local log");
	assert(mattermostFallback?.messages.length === 2, "Mattermost log fallback keeps root and replies together");

	const rocketApiAdapter = {
		name: "rocket-chat",
		readThread: async (channel: string, threadTs: string) => [
			{
				date: "2026-05-26T11:10:00.000Z",
				ts: threadTs,
				threadTs,
				channelId: channel,
				channelName: "customer-example",
				sender: "Operator",
				text: "Authoritative Rocket.Chat relationship root",
				isRoot: true,
				isBot: false,
			},
		],
	} as unknown as PlatformAdapter;
	const rocketResult = await collectRocketChatThreadMessages(
		workingDir,
		`rocket-chat:${rocketRoom}:${rocketRoot}`,
		[rocketApiAdapter],
	);
	assert(rocketResult?.source === "rocket-chat-api", "read_thread prefers live Rocket.Chat API transcript when available");
	assert(rocketResult?.messages[0]?.text.includes("Authoritative Rocket.Chat"), "Rocket.Chat API transcript is preserved");
	assert(formatThreadTranscript(rocketResult!).includes("Rocket.Chat thread"), "generic formatter labels Rocket.Chat threads");

	const rocketFallback = await collectRocketChatThreadMessages(
		workingDir,
		`rocket-chat:${rocketRoom}:${rocketRoot}`,
		[],
	);
	assert(rocketFallback?.source === "log", "Rocket.Chat transcript falls back to the local log");
	assert(rocketFallback?.messages.length === 2, "Rocket.Chat log fallback keeps root and replies together");

	const zulipTopic = await collectThreadMessages(
		workingDir,
		"zulip:4:topic:Road%20map%20%2F%20alpha",
		[],
	);
	assert(zulipTopic?.source === "zulip-log", "generic read_thread reads Zulip topic targets");
	assert(zulipTopic?.messages[0]?.text === "Zulip topic root", "Zulip topic transcript preserves exact topic context");
	assert(formatThreadTranscript(zulipTopic!).includes("Zulip conversation"), "generic formatter labels Zulip conversations");
	const zulipDm = await collectThreadMessages(workingDir, "zulip:dm:8", []);
	assert(zulipDm?.source === "zulip-log", "generic read_thread reads Zulip DM targets");
	assert(zulipDm?.messages[0]?.text === "Zulip direct hello", "Zulip DM transcript preserves direct-message context");

	const emailTarget = collectEmailThreadListings(workingDir)[0]?.sendTarget;
	assert(Boolean(emailTarget), "email thread target is discoverable for read_thread");
	const emailResult = await collectThreadMessages(workingDir, emailTarget!, []);
	assert(emailResult?.source === "email-ledger", "generic read_thread reads email ledger targets");
	assert(emailResult?.messages.some((m) => m.text.includes("native email thread")), "email transcript includes outbound thread context");
	assert(formatThreadTranscript(emailResult!).includes("Email thread"), "generic formatter labels email threads");

	const phoneResult = await collectThreadMessages(workingDir, "phone-abc123", []);
	assert(phoneResult?.source === "phone-log", "generic read_thread reads phone conversation targets");
	assert(phoneResult?.messages.some((m) => m.text.includes("Phone group reply")), "phone transcript includes group text replies");
	assert(formatThreadTranscript(phoneResult!).includes("Phone conversation"), "generic formatter labels phone conversations");

	const failingSlackApiAdapter = {
		name: "slack",
		readThread: async () => {
			throw new Error("missing_scope");
		},
	} as unknown as PlatformAdapter;
	const fallbackResult = await collectSlackThreadMessages(
		workingDir,
		"slack:C0123456789:1700000010.000100",
		[failingSlackApiAdapter],
	);
	assert(fallbackResult?.source === "log", "Slack API failure falls back to local log transcript");
	assert(fallbackResult?.warning?.includes("missing_scope"), "fallback transcript preserves Slack API failure warning");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
