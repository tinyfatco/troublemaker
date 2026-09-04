import assert from "node:assert/strict";
import { SlackThreadedToolProgress } from "../src/adapters/slack-threaded-tool-progress.js";
import type { ConversationToolExecutionDetails } from "../src/console/tool-detail-projection.js";

interface Posted {
	channel: string;
	text: string;
	threadTs?: string;
	ts: string;
}

function invocation(text: string): ConversationToolExecutionDetails {
	return {
		toolName: "read",
		invocation: { text, format: "json", language: "json", isTruncated: false },
		artifacts: [],
	};
}

function result(text: string, isTruncated = false): ConversationToolExecutionDetails {
	return {
		toolName: "read",
		result: { text, format: "text", isTruncated },
		artifacts: [],
	};
}

function harness(mode: "off" | "important" | "all" = "important", maxMessageLength = 40_000) {
	const roots: Posted[] = [];
	const replies: Posted[] = [];
	const updates: Array<{ channel: string; ts: string; text: string }> = [];
	const deletes: Array<{ channel: string; ts: string }> = [];
	let next = 1;
	const progress = new SlackThreadedToolProgress({
		api: {
			postRoot: async (channel, text) => {
				const posted = { channel, text, ts: `root-${next++}` };
				roots.push(posted);
				return posted.ts;
			},
			updateMessage: async (channel, ts, text) => { updates.push({ channel, ts, text }); },
			postReply: async (channel, threadTs, text) => {
				const posted = { channel, threadTs, text, ts: `reply-${next++}` };
				replies.push(posted);
				return posted.ts;
			},
			deleteMessage: async (channel, ts) => { deletes.push({ channel, ts }); },
		},
		channel: "C9999999999",
		mode,
		verbose: false,
		maxMessageLength,
	});
	return { progress, roots, replies, updates, deletes };
}

{
	const h = harness();
	await h.progress.update({ id: "hidden", label: "Routine hidden work", status: "in_progress", show: false, details: invocation("hidden") });
	await h.progress.update({ id: "hidden", label: "Routine hidden work", status: "complete", show: false, details: result("hidden") });
	assert.equal(h.roots.length, 0, "important mode fails closed without show:true across the full lifecycle");

	const firstInvocation = invocation('{\n  "path": "/tmp/example-one.txt"\n}');
	await h.progress.update({ id: "tool-1", label: "Inspecting first file", status: "in_progress", show: true, details: firstInvocation });
	assert.deepEqual(h.roots[0], {
		channel: "C9999999999",
		text: "_→ Inspecting first file_",
		ts: "root-1",
	});
	assert.equal(h.replies[0]?.threadTs, "root-1", "first invocation detail belongs to the first tool root");
	assert.match(h.replies[0]?.text || "", /Invocation/);
	assert.match(h.replies[0]?.text || "", /example-one/);

	await h.progress.update({ id: "tool-1", label: "Inspecting first file", status: "in_progress", show: true, details: firstInvocation });
	assert.equal(h.roots.length, 1, "duplicate start never creates another root");
	assert.equal(h.replies.length, 1, "duplicate invocation never creates another reply");
	assert.equal(h.updates.length, 0, "identical progress does not edit stable messages");

	await h.progress.update({ id: "tool-2", label: "Inspecting second file", status: "in_progress", show: true, details: invocation('{\n  "path": "/tmp/example-two.txt"\n}') });
	assert.equal(h.roots.length, 2, "a second visible tool creates its own root");
	assert.equal(h.replies[1]?.threadTs, "root-3", "second invocation detail belongs only to the second tool root");
	assert.notEqual(h.replies[0]?.threadTs, h.replies[1]?.threadTs, "unrelated tools never share a catch-all thread");

	await h.progress.update({ id: "tool-1", label: "Inspecting first file", status: "complete", show: true, details: result("FIRST_RESULT") });
	assert.deepEqual(h.updates[0], { channel: "C9999999999", ts: "root-1", text: "_✓ Inspecting first file_" });
	assert.equal(h.replies[2]?.threadTs, "root-1", "first result reconciles under the first tool root");
	assert.match(h.replies[2]?.text || "", /FIRST_RESULT/);

	await h.progress.update({ id: "tool-1", label: "Inspecting first file", status: "complete", show: true, details: result("FIRST_RESULT_CORRECTED") });
	assert.equal(h.replies.length, 3, "corrected result reuses the existing result reply");
	assert.deepEqual(h.updates.at(-1), {
		channel: "C9999999999",
		ts: h.replies[2]?.ts,
		text: "*Result*\n```\nFIRST_RESULT_CORRECTED\n```",
	}, "corrected result edits only its own reply");

	await h.progress.update({ id: "tool-2", label: "Inspecting second file", status: "error", show: true, details: result("SECOND_ERROR") });
	assert(h.updates.some((update) => update.ts === "root-3" && update.text === "_✗ Inspecting second file_"));
	assert.equal(h.replies.at(-1)?.threadTs, "root-3", "second result remains under the second root");
	assert.match(h.replies.at(-1)?.text || "", /SECOND_ERROR/);

	await h.progress.update({ id: "tool-3", label: "Recovered completion", status: "complete", show: true, details: result("RECOVERED_RESULT") });
	assert.equal(h.roots.at(-1)?.text, "_✓ Recovered completion_", "a visible completion can recover a missing start without duplicating another tool");
	assert.equal(h.replies.at(-1)?.threadTs, h.roots.at(-1)?.ts, "recovered completion still owns an exact result thread");

	await h.progress.deleteAll();
	const ownedIds = [...h.roots, ...h.replies].map((message) => message.ts).sort();
	assert.deepEqual(h.deletes.map((entry) => entry.ts).sort(), ownedIds, "cleanup deletes only and all agent-owned roots and replies");
}

{
	const h = harness("all", 512);
	await h.progress.update({
		id: "bounded",
		label: `Bounded ${"label".repeat(200)}`,
		status: "complete",
		details: result(`${"x".repeat(2_000)}\n\`\`\`unsafe fence`, true),
	});
	assert.equal(h.roots.length, 1, "all mode surfaces a routine tool without show:true");
	assert((h.roots[0]?.text.length || 0) <= 512, "Slack tool summary remains within the configured message bound");
	assert.match(h.roots[0]?.text || "", /…_$/, "an oversized tool label carries an explicit truncation marker");
	assert((h.replies[0]?.text.length || 0) < 600, "Slack detail remains within the configured message bound");
	assert.doesNotMatch(h.replies[0]?.text || "", /```unsafe fence/, "detail content cannot terminate its own code fence");
	assert.match(h.replies[0]?.text || "", /detail truncated|Truncated by the safe detail projector/);
}

{
	const h = harness("all");
	for (let index = 1; index <= 257; index++) {
		await h.progress.update({ id: `bounded-${index}`, label: `Bounded ${index}`, status: "complete" });
	}
	await h.progress.update({ id: "bounded-1", label: "Bounded 1", status: "complete" });
	assert.equal(h.roots.length, 257, "a pruned settled tool retains bounded dedupe identity");
	await h.progress.deleteAll();
	assert.equal(h.deletes.length, 257, "pruned roots remain under cleanup ownership");
}

{
	const h = harness("off");
	await h.progress.update({ id: "off", label: "Hidden", status: "complete", show: true, details: result("HIDDEN") });
	assert.equal(h.roots.length, 0, "off mode preserves compact suppression");
}

console.log("Slack threaded tool progress tests passed");
