import assert from "node:assert/strict";
import { createTwoMessageContext } from "../src/adapters/context.js";
import type { MomEvent } from "../src/adapters/types.js";

const event: MomEvent = {
	type: "mention",
	channel: "10",
	ts: "1",
	user: "8",
	text: "hello",
	attachments: [],
};

function harness(update: () => Promise<void>, post?: () => Promise<string>) {
	const posts: string[] = [];
	let updates = 0;
	const context = createTwoMessageContext(
		{
			post: async (_channel, text) => {
				if (post) return post();
				posts.push(text);
				return `message-${posts.length}`;
			},
			update: async () => {
				updates += 1;
				await update();
			},
			delete: async () => {},
			formatStatus: (text) => `*${text}*`,
			throttleMs: 0,
			maxLength: 10_000,
		},
		{ headerLine: "", event, channels: [], users: [], verbose: "messages-only", toolStreaming: "all" },
	);
	return { context, posts, updateCount: () => updates };
}

const refused = async () => {
	throw new Error("Zulip host proxy returned HTTP 500: The time limit for editing this message has passed");
};

{
	const { context, posts, updateCount } = harness(refused);
	await context.respond("_→ first_", false);
	assert.equal(posts.length, 1, "the first label opens the working message");

	await context.respond("_→ second_", false);
	assert.equal(updateCount(), 1);
	assert.equal(posts.length, 2, "a refused edit continues in a fresh message");
	assert.ok(posts[1].includes("second"), "the fresh message carries the latest status");
	assert.ok(!posts[1].includes("first"), "the fresh message does not repeat older statuses");

	await context.setWorking(false);
	assert.equal(updateCount(), 2, "the closing edit is attempted");
	assert.equal(posts.length, 2, "a refused closing edit posts nothing new and does not fail the run");

	await context.sendFinalResponse("done", { force: true });
	assert.equal(posts.at(-1), "done", "the final response still goes out");
}

{
	let edits = 0;
	const { context, posts } = harness(async () => {
		edits += 1;
		if (edits === 1) await refused();
	});
	await context.respond("_→ first_", false);
	await context.respond("_→ second_", false);
	await context.respond("_→ third_", false);
	assert.equal(edits, 2, "edits resume on the fresh message");
	assert.equal(posts.length, 2, "only the refused edit posts a new message");
}

{
	let postCalls = 0;
	const { context } = harness(refused, async () => {
		postCalls += 1;
		if (postCalls === 1) return "message-1";
		throw new Error("post refused");
	});
	await context.respond("_→ first_", false);
	await context.respond("_→ second_", false);
	await context.respond("_→ third_", false);
	assert.equal(postCalls, 3, "a failed fallback post does not stop the run or later attempts");
}

{
	const { context } = harness(async () => {}, async () => {
		throw new Error("post refused");
	});
	await assert.rejects(context.respond("_→ first_", false), /post refused/, "a failed first post still surfaces");
}

console.log("working status edit tests passed");
