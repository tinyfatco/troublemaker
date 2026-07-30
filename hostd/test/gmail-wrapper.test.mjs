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
} else if (has("thread", "get")) {
  console.log(JSON.stringify({ thread: { messages: [{
    id: "message-1",
    headers: {
      From: "TinyFat <noreply@example.com>",
      To: "agent@example.com",
      "Reply-To": "person@example.com",
      Subject: "Example"
    },
    body: "Thread body"
  }] } }));
} else if (has("gmail", "get") && !args.includes("drafts")) {
  console.log(JSON.stringify({ message: { payload: { headers: [
    { name: "From", value: "TinyFat <noreply@example.com>" },
    { name: "To", value: "agent@example.com" },
    { name: "Reply-To", value: "person@example.com" },
    { name: "Subject", value: "Example" },
    { name: "X-Tinyfat-Contact-Version", value: "1" }
  ] } } }));
} else if (has("drafts", "create") || has("drafts", "update")) {
  console.log(JSON.stringify({ draftId: "draft-1", threadId: "thread-1", message: { id: "draft-message-1", threadId: "thread-1" } }));
} else if (has("drafts", "get")) {
  console.log(JSON.stringify({ draft: { id: "draft-1", message: { id: "draft-message-1", threadId: "thread-1", payload: { mimeType: "text/plain", headers: [
    { name: "To", value: "person@example.com, owner@example.com" },
    { name: "Cc", value: "archive@example.com" },
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

test("gog wrapper keeps draft writes send-disabled and enables only draft send for delivery", async () => {
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
		assert.deepEqual(await gmail.searchThreads("newer_than:30d", 4), [{
			id: "thread-1",
			date: "2026-07-23",
			from: "person@example.com",
			subject: "Example",
			messageCount: 2,
		}]);
		assert.deepEqual(await gmail.getMetadata("message-1"), {
			from: "TinyFat <noreply@example.com>",
			to: "agent@example.com",
			"reply-to": "person@example.com",
			subject: "Example",
			"x-tinyfat-contact-version": "1",
		});
		assert.deepEqual(await gmail.getThread("thread-1"), [{
			id: "message-1",
			date: "",
			from: "TinyFat <noreply@example.com>",
			to: "agent@example.com",
			cc: "",
			bcc: "",
			replyTo: "person@example.com",
			subject: "Example",
			body: "Thread body",
		}]);
		assert.deepEqual(await gmail.createDraft({
			to: ["person@example.com", "owner@example.com"],
			cc: ["archive@example.com"],
			subject: "Example",
			body: "Draft body",
			replyToMessageId: "message-1",
		}), { draftId: "draft-1", messageId: "draft-message-1", threadId: "thread-1" });
		assert.deepEqual(await gmail.getDraft("draft-1"), {
			draftId: "draft-1",
			messageId: "draft-message-1",
			threadId: "thread-1",
			to: ["person@example.com", "owner@example.com"],
			cc: ["archive@example.com"],
			bcc: [],
			replyTo: [],
			subject: "Example",
			body: "Draft body",
			hasAttachments: false,
		});
		assert.deepEqual(await gmail.sendDraft("draft-1"), { messageId: "sent-1", threadId: "thread-1" });
		await gmail.deleteDraft("draft-1");

		const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const create = calls.find((call) => call.args.includes("create"));
		assert.ok(create.args.includes("--gmail-no-send"));
		assert.ok(create.args.includes("--enable-commands=gmail.drafts.create,gmail.drafts.update,gmail.drafts.delete"));
		assert.equal(create.input, "Draft body");
		assert.ok(create.args.includes("--reply-to-message-id"));
		assert.equal(
			create.args.at(create.args.indexOf("--to") + 1),
			"person@example.com,owner@example.com",
		);
		assert.equal(create.args.at(create.args.indexOf("--cc") + 1), "archive@example.com");
		const bodyHtml = create.args.at(create.args.indexOf("--body-html") + 1);
		assert.ok(bodyHtml.includes("<body style=\"margin:0;padding:0\">"));
		assert.ok(!bodyHtml.includes("max-width"));

		const send = calls.find((call) => call.args.includes("send"));
		assert.ok(!send.args.includes("--gmail-no-send"));
		assert.ok(send.args.includes("--enable-commands=gmail.drafts.send"));
		assert.ok(!send.args.some((arg) => arg.includes("gmail.send")));

		const read = calls.find((call) => call.args.includes("get"));
		assert.ok(read.args.includes("--gmail-no-send"));
		const metadata = calls.find((call) => call.args.includes("--format"));
		assert.equal(metadata.args.at(metadata.args.indexOf("--format") + 1), "full");
		assert.ok(!metadata.args.includes("--headers"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
