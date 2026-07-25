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

	const selectivePosts: Posted[] = [];
	const rawDetails: string[] = [];
	const selective = createTwoMessageContext(
		{
			post: async (channel, text) => {
				selectivePosts.push({ channel, text });
				return `selective-${selectivePosts.length}`;
			},
			update: async (_channel, _id, text) => {
				selectivePosts[0] = { channel: event.channel, text };
			},
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
			toolStreaming: "important",
		},
		{
			respondInThread: async (text) => { rawDetails.push(text); },
		},
	);

	await selective.respond("ordinary interim text", true);
	await selective.respond("_→ Routine read_", false, { show: false });
	assert(selectivePosts.length === 0, "important mode suppresses routine tool labels");
	await selective.respond("_→ Checking the deployed revision_", false, { show: true });
	assert(selectivePosts.length === 1, "important mode surfaces a show:true tool label");
	assert(selectivePosts[0]?.text.includes("Checking the deployed revision") === true, "surfaced working output contains the safe label");
	assert(selectivePosts[0]?.text.includes("ordinary interim text") === false, "a selected label cannot expose buffered assistant text");
	await selective.respondInThread("raw arguments and result");
	assert(rawDetails.length === 0, "messages-only suppresses raw tool detail even after a label surfaces");
	await selective.sendFinalResponse("ordinary harness final");
	assert(selectivePosts.length === 1, "ordinary final output remains suppressed after a label surfaces");

	const allPosts: Posted[] = [];
	const allLabels = createTwoMessageContext(
		{
			post: async (channel, text) => { allPosts.push({ channel, text }); return `all-${allPosts.length}`; },
			update: async () => {}, delete: async () => {}, formatStatus: (text) => text, throttleMs: 0, maxLength: 2000,
		},
		{ headerLine: "Thinking", event, channels: [], users: [], verbose: "messages-only", toolStreaming: "all" },
	);
	await allLabels.respond("_→ Routine read_", false, { show: false });
	assert(allPosts.length === 1, "all mode surfaces every safe tool label");

	const offPosts: Posted[] = [];
	const noLabels = createTwoMessageContext(
		{
			post: async (channel, text) => { offPosts.push({ channel, text }); return `off-${offPosts.length}`; },
			update: async () => {}, delete: async () => {}, formatStatus: (text) => text, throttleMs: 0, maxLength: 2000,
		},
		{ headerLine: "Thinking", event, channels: [], users: [], verbose: "messages-only", toolStreaming: "off" },
	);
	await noLabels.respond("_→ Important operation_", false, { show: true });
	assert(offPosts.length === 0, "off mode suppresses even show:true labels");

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
	console.error("Test error:", err);
	process.exit(1);
});
