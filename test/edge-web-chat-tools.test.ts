import assert from "node:assert/strict";
import { createEdgeWebChatTools } from "../src/modes/edge/index.js";

const project = {
	slug: "alice-bakery",
	siteId: "11111111-1111-4111-8111-111111111111",
	displayName: "Alice Bakery",
};

const managedProjectBridge = {
	deployPreview: async () => ({
		url: "https://alice-bakery.preview.tinyfat.dev/",
		project,
	}),
};

const hostBridge = {
	executeBash: async () => ({ stdout: "ok", stderr: "", code: 0 }),
};

const emit = () => {};

assert.deepEqual(
	createEdgeWebChatTools({
		input: { message: "hello", channelId: "web", source: "web" },
		emit,
	}).map((tool) => tool.name),
	[],
	"ordinary free edge chat exposes no hosted tools",
);

assert.deepEqual(
	createEdgeWebChatTools({
		input: { message: "deploy", channelId: "project:alice-bakery:web", source: "web", project },
		managedProjectBridge,
		emit,
	}).map((tool) => tool.name),
	["deploy_preview"],
	"free project edge chat exposes only the managed preview deploy tool",
);

assert.deepEqual(
	createEdgeWebChatTools({
		input: { message: "inspect", channelId: "project:alice-bakery:web", source: "web", project },
		hostBridge,
		managedProjectBridge,
		emit,
	}).map((tool) => tool.name),
	["bash", "deploy_preview"],
	"host-backed Agent plan edge chat can expose bash plus managed preview deploy",
);

console.log("edge-web-chat-tools ok");
