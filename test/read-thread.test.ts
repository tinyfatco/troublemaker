import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	collectSlackThreadMessagesFromLog,
	formatSlackThreadTranscript,
	parseSlackThreadTarget,
} from "../src/tools/read-thread.js";

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

	assert(parseSlackThreadTarget("slack:C0AN1GL51K7:1779777000.000100")?.channelId === "C0AN1GL51K7", "valid Slack thread target parses");
	assert(parseSlackThreadTarget("C0AN1GL51K7") === null, "plain Slack channel is not a thread target");

	const first = collectSlackThreadMessagesFromLog(workingDir, "slack:C0AN1GL51K7:1779777000.000100");
	const second = collectSlackThreadMessagesFromLog(workingDir, "slack:C0AN1GL51K7:1779777100.000300");
	const missing = collectSlackThreadMessagesFromLog(workingDir, "slack:C0AN1GL51K7:1779777999.999999");

	assert(first?.messages.length === 2, "first thread transcript includes only first thread messages");
	assert(first?.messages.some((m) => m.text.includes("deploy QA")), "first transcript preserves deploy QA nuance");
	assert(!first?.messages.some((m) => m.text.includes("product feedback")), "first transcript excludes second thread nuance");
	assert(first?.messages[0]?.isRoot === true, "root message is marked root");
	assert(first?.messages[1]?.isBot === true, "bot reply is marked Zip context");
	assert(second?.messages.length === 2, "second thread transcript includes second thread messages");
	assert(second?.messages.some((m) => m.text.includes("thread replies less noisy")), "second transcript preserves follow-up nuance");
	assert(missing?.messages.length === 0, "valid but unseen thread returns an empty transcript");

	const formatted = formatSlackThreadTranscript(second!);
	assert(formatted.includes("slack:C0AN1GL51K7:1779777100.000300"), "formatted transcript names exact target");
	assert(formatted.includes("[root]"), "formatted transcript marks root");
	assert(formatted.includes("[reply]"), "formatted transcript marks replies");
	assert(!formatted.includes("deploy QA"), "formatted transcript does not leak other thread text");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
