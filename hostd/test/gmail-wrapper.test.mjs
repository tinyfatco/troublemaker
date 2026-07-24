import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GogGmail } from "../src/gmail.mjs";

const fakeGog = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.GOG_RECORD, JSON.stringify({ args, input }) + "\\n");
const has = (...parts) => parts.every((part) => args.includes(part));
if (has("gmail", "search")) {
  console.log(JSON.stringify({ threads: [{ id: "thread-1", date: "2026-07-23", from: "person@example.com", subject: "Example", messageCount: 2 }] }));
} else if (has("drafts", "create") || has("drafts", "update")) {
  console.log(JSON.stringify({ draftId: "draft-1", threadId: "thread-1", message: { id: "draft-message-1", threadId: "thread-1" } }));
} else if (has("drafts", "get")) {
  console.log(JSON.stringify({ draft: { id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1", payload: { mimeType: "text/plain", headers: [
    { name: "To", value: "person@example.com" },
    { name: "Subject", value: "Example" }
  ], body: { data: Buffer.from("Draft body").toString("base64url") } } } } }));
} else if (has("drafts", "send")) {
  console.log(JSON.stringify({ messageId: "sent-1", threadId: "thread-1" }));
} else if (has("drafts", "delete")) {
  console.log(JSON.stringify({ deleted: true, draftId: "draft-1" }));
} else {
  console.error("unexpected fake gog command");
  process.exit(2);
}
`;

test("gog wrapper keeps draft writes send-disabled and enables only draft send for delivery", () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-gog-wrapper-"));
	const executable = join(directory, "gog");
	const record = join(directory, "calls.jsonl");
	writeFileSync(executable, fakeGog);
	chmodSync(executable, 0o755);
	const gmail = new GogGmail({ account: "agent@example.com", gogPath: executable }, {
		...process.env,
		GOG_RECORD: record,
	});

	try {
		assert.deepEqual(gmail.searchThreads("newer_than:30d", 4), [{
			id: "thread-1",
			date: "2026-07-23",
			from: "person@example.com",
			subject: "Example",
			messageCount: 2,
		}]);
		assert.deepEqual(gmail.createDraft({
			to: "person@example.com",
			subject: "Example",
			body: "Draft body",
			replyToMessageId: "message-1",
		}), { draftId: "draft-1", messageId: "draft-message-1", threadId: "thread-1" });
		assert.deepEqual(gmail.getDraft("draft-1"), {
			draftId: "draft-1",
			messageId: "draft-message-1",
			threadId: "thread-1",
			to: ["person@example.com"],
			cc: [],
			bcc: [],
			replyTo: [],
			subject: "Example",
			body: "Draft body",
			hasAttachments: false,
		});
		assert.deepEqual(gmail.sendDraft("draft-1"), { messageId: "sent-1", threadId: "thread-1" });
		gmail.deleteDraft("draft-1");

		const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const create = calls.find((call) => call.args.includes("create"));
		assert.ok(create.args.includes("--gmail-no-send"));
		assert.ok(create.args.includes("--enable-commands=gmail.drafts.create,gmail.drafts.update,gmail.drafts.delete"));
		assert.equal(create.input, "Draft body");
		assert.ok(create.args.includes("--reply-to-message-id"));

		const send = calls.find((call) => call.args.includes("send"));
		assert.ok(!send.args.includes("--gmail-no-send"));
		assert.ok(send.args.includes("--enable-commands=gmail.drafts.send"));
		assert.ok(!send.args.some((arg) => arg.includes("gmail.send")));

		const read = calls.find((call) => call.args.includes("get"));
		assert.ok(read.args.includes("--gmail-no-send"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
