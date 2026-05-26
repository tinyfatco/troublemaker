import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectChannelsFromLog, collectSlackThreadsFromLog, formatChannelTable } from "../src/tools/list-channels.js";

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
			ts: "1779777000.000100",
			threadTs: "1779777000.000100",
			channel: "slack:#tinyfat",
			channelId: "C0AN1GL51K7",
			user: "UROOT",
			displayName: "Alex",
			text: "Root one: decide where the reply belongs",
			isBot: false,
		},
		{
			date: "2026-05-26T08:01:00.000Z",
			ts: "1779777001.000200",
			threadTs: "1779777000.000100",
			channel: "slack:#tinyfat",
			channelId: "C0AN1GL51K7",
			user: "UZIP",
			text: "Reply in root one",
			isBot: true,
		},
		{
			date: "2026-05-26T08:02:00.000Z",
			ts: "1779777100.000300",
			threadTs: "1779777100.000300",
			channel: "slack:#tinyfat",
			channelId: "C0AN1GL51K7",
			user: "UOTHER",
			displayName: "Mike",
			text: "Root two: this is a separate thread",
			isBot: false,
		},
		{
			date: "2026-05-26T08:03:00.000Z",
			channel: "telegram:DM:Alex",
			channelId: "1234567890",
			text: "hello",
		},
	];
	writeFileSync(join(workingDir, "log.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

	const channels = collectChannelsFromLog(workingDir);
	const threads = collectSlackThreadsFromLog(workingDir);
	const table = formatChannelTable(channels, threads);

	assert(channels.some((c) => c.adapter === "slack" && c.id === "C0AN1GL51K7"), "channel list still includes Slack channel target");
	assert(threads.length === 2, "two Slack thread roots stay distinct");
	assert(threads.some((t) => t.sendTarget === "slack:C0AN1GL51K7:1779777000.000100"), "first thread exposes exact send target");
	assert(threads.some((t) => t.sendTarget === "slack:C0AN1GL51K7:1779777100.000300"), "second thread exposes exact send target");
	assert(threads.find((t) => t.threadTs === "1779777000.000100")?.participants.includes("Zip"), "bot replies are participant context, not a separate target");
	assert(table.includes("Recent Slack thread targets:"), "formatted output has a Slack thread section");
	assert(table.includes("Root one: decide where the reply belongs"), "formatted output keeps root preview for nuance");
	assert(table.includes("Root two: this is a separate thread"), "formatted output keeps separate root preview");
	assert(table.includes("`slack:C0AN1GL51K7:1779777100.000300`"), "formatted output shows send_message-ready thread target");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);