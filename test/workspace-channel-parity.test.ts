import assert from "node:assert/strict";
import type { WorkingOutputTarget } from "../src/context.js";
import {
	createWorkspaceMessageContext,
	createWorkspaceWorkingOutputContext,
	type WorkspaceChannelTransport,
} from "../src/adapters/workspace-channel-context.js";
import type { MomEvent } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

type Operation = {
	kind: string;
	channel?: string;
	id?: string;
	rootId?: string;
	text?: string;
	filePath?: string;
	title?: string;
	threadTs?: string;
};

function createTransport(platform: string) {
	const operations: Operation[] = [];
	let sequence = 0;
	const nextId = () => `message-${++sequence}`;
	const transport: WorkspaceChannelTransport = {
		platform,
		maxMessageLength: 16_384,
		assertWorkingTarget(target) {
			assert.equal(target.platform, platform);
			assert.equal(target.channelId, "customer-room");
		},
		async postMessage(channel, text) {
			const id = nextId();
			operations.push({ kind: "post", channel, id, text });
			return id;
		},
		async updateMessage(channel, id, text) {
			operations.push({ kind: "update", channel, id, text });
		},
		async deleteMessage(channel, id) {
			operations.push({ kind: "delete", channel, id });
		},
		async postInThread(channel, rootId, text) {
			const id = nextId();
			operations.push({ kind: "post-thread", channel, rootId, id, text });
			return id;
		},
		async uploadFile(channel, filePath, title, rootId) {
			operations.push({ kind: "upload", channel, filePath, title, rootId });
		},
		logBotResponse(channel, text, id, metadata) {
			operations.push({ kind: "log", channel, id, text, threadTs: metadata.threadTs });
		},
		getUser(userId) {
			return { id: userId, userName: "casey", displayName: "Casey" };
		},
		getChannel(channelId) {
			return { id: channelId, name: "Customer website" };
		},
		getAllUsers() {
			return [{ id: "casey", userName: "casey", displayName: "Casey" }];
		},
		getAllChannels() {
			return [{ id: "customer-room", name: "Customer website" }];
		},
		describeReplyTarget(channelId, rootId) {
			return rootId ? `Customer website thread ${rootId}` : `Customer website (${channelId})`;
		},
	};
	return { transport, operations };
}

async function exerciseProtocol(platform: string): Promise<Operation[]> {
	const { transport, operations } = createTransport(platform);
	const store = {} as ChannelStore;
	const target: WorkingOutputTarget = {
		platform,
		channelId: "customer-room",
	};
	const working = createWorkspaceWorkingOutputContext(transport, target, store, {
		toolStreaming: "all",
		presentation: "split",
		windowMinutes: 1,
	});
	await working.respond("_→ Operator is assembling the preview_", false, { show: true });
	await working.respond("_→ Operator is checking the deployment_", false, { show: true });
	await working.setWorking(false);
	await working.deleteMessage();

	const event: MomEvent = {
		type: "mention",
		channel: "customer-room",
		ts: "inbound-message",
		user: "casey",
		text: "Please ship the private review.",
		directlyAddressed: true,
		attachments: [],
	};
	const message = createWorkspaceMessageContext(transport, event, store, {
		responseThreadId: "inbound-message",
	});
	await message.sendFinalResponse("ordinary harness output");
	await message.sendFinalResponse("The agent failed before it could answer.", { force: true });
	await message.uploadFile("/tmp/private-review.png", "Private review");
	await message.deleteMessage();

	return operations;
}

const mattermost = await exerciseProtocol("mattermost");
const rocket = await exerciseProtocol("rocket-chat");

assert.deepEqual(
	rocket,
	mattermost,
	"workspace transports must expose identical customer-channel product behavior",
);
assert.deepEqual(
	mattermost.map(({ kind }) => kind),
	["post", "update", "update", "delete", "post-thread", "log", "upload", "delete"],
);
assert(!mattermost.some(({ text }) => text === "ordinary harness output"));
assert(mattermost.some(({ text }) => text === "The agent failed before it could answer."));

console.log("workspace channel parity ok");
