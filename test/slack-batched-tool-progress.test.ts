import assert from "node:assert/strict";
import { SlackBatchedToolProgress } from "../src/adapters/slack-batched-tool-progress.js";
import type { ConversationToolExecutionDetails } from "../src/console/tool-detail-projection.js";
import type { ToolProgressUpdate } from "../src/adapters/types.js";

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

function harness(maxMessageLength = 40_000) {
	const surfaced: ToolProgressUpdate[] = [];
	const replies: Array<{ channel: string; threadTs: string; text: string; ts: string }> = [];
	const updates: Array<{ channel: string; ts: string; text: string }> = [];
	const deletes: Array<{ channel: string; ts: string }> = [];
	let currentRoot: string | undefined = "batch-1";
	let nextReply = 1;
	const progress = new SlackBatchedToolProgress({
		api: {
			surfaceBatchRoot: async (update) => {
				surfaced.push(update);
				return currentRoot;
			},
			updateMessage: async (channel, ts, text) => { updates.push({ channel, ts, text }); },
			postReply: async (channel, threadTs, text) => {
				const reply = { channel, threadTs, text, ts: `reply-${nextReply++}` };
				replies.push(reply);
				return reply.ts;
			},
			deleteMessage: async (channel, ts) => { deletes.push({ channel, ts }); },
		},
		channel: "C9999999999",
		maxMessageLength,
	});
	return {
		progress,
		surfaced,
		replies,
		updates,
		deletes,
		setRoot: (root: string | undefined) => { currentRoot = root; },
	};
}

{
	const h = harness();
	h.setRoot(undefined);
	await h.progress.update({ id: "hidden", label: "Routine hidden work", status: "in_progress", details: invocation("hidden") });
	assert.equal(h.replies.length, 0, "a tool rejected by existing batch admission gets no lifecycle reply");

	h.setRoot("batch-1");
	const firstInvocation = invocation('{\n  "path": "/tmp/example-one.txt"\n}');
	await h.progress.update({ id: "tool-1", label: "Inspecting first file", status: "in_progress", show: true, details: firstInvocation });
	assert.equal(h.surfaced.at(-1)?.id, "tool-1");
	assert.deepEqual(h.replies[0], {
		channel: "C9999999999",
		threadTs: "batch-1",
		text: "*→ Inspecting first file*\n\n_Running_ · `read`\n\n*Input*\n```\n{\n  \"path\": \"/tmp/example-one.txt\"\n}\n```",
		ts: "reply-1",
	});

	await h.progress.update({ id: "tool-1", label: "Inspecting first file", status: "in_progress", show: true, details: firstInvocation });
	assert.equal(h.surfaced.filter((update) => update.id === "tool-1").length, 1, "duplicate start never re-adds the tool to a batch root");
	assert.equal(h.replies.length, 1, "duplicate start never creates another lifecycle reply");
	assert.equal(h.updates.length, 0, "identical lifecycle state does not edit stable replies");

	await h.progress.update({ id: "tool-2", label: "Inspecting second file", status: "in_progress", show: true, details: invocation('{\n  "path": "/tmp/example-two.txt"\n}') });
	assert.equal(h.replies.length, 2, "a second tool creates exactly one lifecycle reply");
	assert(h.replies.every((reply) => reply.threadTs === "batch-1"), "tools admitted in one window share the same batch root");

	await h.progress.update({ id: "tool-1", label: "Inspecting first file", status: "complete", show: true, details: result("FIRST_RESULT") });
	assert.equal(h.replies.length, 2, "completion does not create a separate result reply");
	assert.equal(h.updates[0]?.ts, "reply-1", "completion edits the first tool's exact lifecycle reply");
	assert.match(h.updates[0]?.text || "", /✓ Inspecting first file/);
	assert.match(h.updates[0]?.text || "", /Complete.*`read`/s, "the lifecycle identifies the actual tool beside its status");
	assert.match(h.updates[0]?.text || "", /Input[\s\S]*example-one[\s\S]*Output[\s\S]*FIRST_RESULT/);

	await h.progress.update({ id: "tool-1", label: "Inspecting first file", status: "complete", show: true, details: result("FIRST_RESULT_CORRECTED") });
	assert.equal(h.replies.length, 2, "corrected result still uses one reply");
	assert.equal(h.updates.at(-1)?.ts, "reply-1");
	assert.match(h.updates.at(-1)?.text || "", /FIRST_RESULT_CORRECTED/);

	await h.progress.update({ id: "tool-2", label: "Inspecting second file", status: "error", show: true, details: result("SECOND_ERROR") });
	assert.equal(h.updates.at(-1)?.ts, "reply-2", "failure edits only the second lifecycle reply");
	assert.match(h.updates.at(-1)?.text || "", /✗ Inspecting second file[\s\S]*Failed[\s\S]*Error[\s\S]*SECOND_ERROR/);

	h.setRoot("batch-2");
	await h.progress.update({ id: "tool-3", label: "Recovered completion", status: "complete", show: true, details: result("RECOVERED_RESULT") });
	assert.equal(h.surfaced.at(-1)?.id, "tool-3", "a missing start can recover through existing batch admission");
	assert.equal(h.replies.at(-1)?.threadTs, "batch-2");
	assert.match(h.replies.at(-1)?.text || "", /✓ Recovered completion[\s\S]*RECOVERED_RESULT/);

	await h.progress.deleteAll();
	assert.deepEqual(h.deletes.map((entry) => entry.ts).sort(), h.replies.map((reply) => reply.ts).sort(), "cleanup owns lifecycle replies only");
	assert(!h.deletes.some((entry) => entry.ts.startsWith("batch-")), "the existing working context retains batch-root ownership");
}

{
	const h = harness(512);
	await h.progress.update({
		id: "bounded",
		label: `Bounded ${"label".repeat(200)}`,
		status: "complete",
		details: {
			...invocation(`${"i".repeat(2_000)}\n\`\`\`unsafe input fence`),
			...result(`${"o".repeat(2_000)}\n\`\`\`unsafe output fence`, true),
		},
	});
	assert.equal(h.replies.length, 1);
	assert((h.replies[0]?.text.length || 0) <= 512, "one lifecycle reply respects the configured message bound");
	assert.doesNotMatch(h.replies[0]?.text || "", /```unsafe/, "projected detail cannot terminate the containing code fence");
	assert.match(h.replies[0]?.text || "", /truncated|Truncated/);
}

{
	const h = harness();
	for (let index = 1; index <= 257; index++) {
		await h.progress.update({ id: `bounded-${index}`, label: `Bounded ${index}`, status: "complete" });
	}
	await h.progress.update({ id: "bounded-1", label: "Bounded 1", status: "complete" });
	assert.equal(h.replies.length, 257, "a pruned settled tool retains bounded dedupe identity");
	await h.progress.deleteAll();
	assert.equal(h.deletes.length, 257, "pruned lifecycle replies remain under cleanup ownership");
}

console.log("Slack batched tool progress tests passed");
