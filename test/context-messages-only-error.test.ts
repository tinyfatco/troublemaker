import { createTwoMessageContext } from "../src/adapters/context.js";
import type { MomEvent } from "../src/adapters/types.js";

type Posted = { channel: string; text: string };

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

async function run() {
	const posts: Posted[] = [];
	const event: MomEvent = {
		type: "mention",
		channel: "discord-channel",
		ts: "test-ts",
		user: "user-1",
		text: "hello",
		attachments: [],
	};

	const ctx = createTwoMessageContext(
		{
			post: async (channel, text) => {
				posts.push({ channel, text });
				return `post-${posts.length}`;
			},
			update: async () => {},
			delete: async () => {},
			formatStatus: (text) => `_${text}_`,
			throttleMs: 0,
			maxLength: 2000,
		},
		{
			headerLine: "_Thinking_",
			event,
			channels: [],
			users: [],
			verbose: "messages-only",
		},
	);

	await ctx.sendFinalResponse("normal harness text");
	assert(posts.length === 0, "messages-only suppresses ordinary final responses");

	await ctx.sendFinalResponse("_Sorry, something went wrong: test failure_", { force: true });
	assert(posts.length === 1, "forced final response posts in messages-only");
	assert(posts[0]?.text.includes("test failure") === true, "forced response includes error text");

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
	console.error("Test error:", err);
	process.exit(1);
});
