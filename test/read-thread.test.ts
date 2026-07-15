import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	collectMattermostThreadMessages,
	collectSlackThreadMessages,
	collectSlackThreadMessagesFromLog,
	collectThreadMessages,
	createReadThreadTool,
	formatSlackThreadTranscript,
	formatThreadTranscript,
	parseMattermostThreadTarget,
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
		target: "slack:C0AN1GL51K7:1779777000.000100",
	}), "read_thread rejects calls without a visible label");
	assert(Check(readThreadTool.parameters, {
		label: "Reading the deploy QA thread",
		show: true,
		target: "slack:C0AN1GL51K7:1779777000.000100",
	}), "read_thread accepts a human-readable label and optional show flag");

	const mattermostChannel = "abcdefghijklmnopqrstuvwx12";
	const mattermostRoot = "zyxwvutsrqponmlkjihgfedc21";
	const mattermostReply = "bcdefghijklmnopqrstuvwxy34";
	const rows = [
		{
			date: "2026-05-26T08:00:00.000Z",
			ts: "1779777000.000100",
			threadTs: "1779777000.000100",
			channel: "slack:#tinyfat",
			channelId: "C0AN1GL51K7",
			displayName: "Alex",
			text: "Thread one root: deploy QA",
			isBot: false,
			directlyAddressed: true,
			sourceEventType: "slack_app_mention",
		},
		{
			date: "2026-05-26T08:01:00.000Z",
			ts: "1779777001.000200",
			threadTs: "1779777000.000100",
			channel: "slack:#tinyfat",
			channelId: "C0AN1GL51K7",
			userName: "zip",
			text: "I will check deploy QA in this thread.",
			isBot: true,
		},
		{
			date: "2026-05-26T08:02:00.000Z",
			ts: "1779777100.000300",
			threadTs: "1779777100.000300",
			channel: "slack:#tinyfat",
			channelId: "C0AN1GL51K7",
			displayName: "Mike",
			text: "Thread two root: product feedback",
			isBot: false,
		},
		{
			date: "2026-05-26T08:03:00.000Z",
			ts: "1779777101.000400",
			threadTs: "1779777100.000300",
			channel: "slack:#tinyfat",
			channelId: "C0AN1GL51K7",
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
			from: "alex@example.com",
			to: ["zip@tinyfat.ai"],
			subject: "Project timing",
			body: "Can you answer in this email thread?",
			messageId: "<email-root@example.com>",
		},
		{
			type: "outbound",
			at: "2026-05-26T10:01:00.000Z",
			channelId: "email-alex_example_com",
			to: ["alex@example.com"],
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
			displayName: "Alex",
			text: "Mattermost migration root",
			isBot: false,
		},
		{
			date: "2026-05-26T10:31:00.000Z",
			ts: mattermostReply,
			threadTs: mattermostRoot,
			channel: "mattermost:agents",
			channelId: mattermostChannel,
			userName: "batman",
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
			date: "2026-05-26T11:01:00.000Z",
			ts: "2026-05-26T11:01:00.000Z",
			channel: "phone:sms/group-site-team",
			channelId: "phone-abc123",
			user: "bot",
			text: "Phone group reply",
			isBot: true,
		},
	].map((row) => JSON.stringify(row)).join("\n") + "\n");

	assert(parseSlackThreadTarget("slack:C0AN1GL51K7:1779777000.000100")?.channelId === "C0AN1GL51K7", "valid Slack thread target parses");
	assert(parseSlackThreadTarget("C0AN1GL51K7") === null, "plain Slack channel is not a thread target");
	assert(parseMattermostThreadTarget(`mattermost:${mattermostChannel}:${mattermostRoot}`)?.threadTs === mattermostRoot, "valid Mattermost thread target parses");
	assert(parseMattermostThreadTarget(`mattermost:${mattermostChannel}`) === null, "Mattermost channel without a root is not a thread target");

	const first = collectSlackThreadMessagesFromLog(workingDir, "slack:C0AN1GL51K7:1779777000.000100");
	const second = collectSlackThreadMessagesFromLog(workingDir, "slack:C0AN1GL51K7:1779777100.000300");
	const missing = collectSlackThreadMessagesFromLog(workingDir, "slack:C0AN1GL51K7:1779777999.999999");

	assert(first?.messages.length === 2, "first thread transcript includes only first thread messages");
	assert(first?.source === "log", "log transcript source is labeled");
	assert(first?.messages.some((m) => m.text.includes("deploy QA")), "first transcript preserves deploy QA nuance");
	assert(!first?.messages.some((m) => m.text.includes("product feedback")), "first transcript excludes second thread nuance");
	assert(first?.messages[0]?.isRoot === true, "root message is marked root");
	assert(first?.messages[1]?.isBot === true, "bot reply is marked Zip context");
	assert(second?.messages.length === 2, "second thread transcript includes second thread messages");
	assert(second?.messages.some((m) => m.text.includes("thread replies less noisy")), "second transcript preserves follow-up nuance");
	assert(missing?.messages.length === 0, "valid but unseen thread returns an empty transcript");

	const formatted = formatSlackThreadTranscript(second!);
	assert(formatted.includes("slack:C0AN1GL51K7:1779777100.000300"), "formatted transcript names exact target");
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
				sender: "Alex",
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
		"slack:C0AN1GL51K7:1779777200.000500",
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
				sender: "Alex",
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
		"slack:C0AN1GL51K7:1779777000.000100",
		[failingSlackApiAdapter],
	);
	assert(fallbackResult?.source === "log", "Slack API failure falls back to local log transcript");
	assert(fallbackResult?.warning?.includes("missing_scope"), "fallback transcript preserves Slack API failure warning");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
