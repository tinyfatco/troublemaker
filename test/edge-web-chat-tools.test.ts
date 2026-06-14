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
const workspaceBridge = {
	readFile: async () => ({ path: "MEMORY.md", content: "ok" }),
	writeFile: async () => ({ path: "MEMORY.md", bytes: 2 }),
	editFile: async () => ({ path: "MEMORY.md", replacements: 1, bytes: 2 }),
};

assert.deepEqual(
	createEdgeWebChatTools({
		input: { message: "hello", channelId: "web", source: "web" },
		workspaceBridge,
		emit,
	}).map((tool) => tool.name),
	["read", "write", "edit"],
	"ordinary free edge chat exposes only R2-backed workspace tools",
);

assert.deepEqual(
	createEdgeWebChatTools({
		input: { message: "deploy", channelId: "project:alice-bakery:web", source: "web", project },
		managedProjectBridge,
		workspaceBridge,
		emit,
	}).map((tool) => tool.name),
	["read", "write", "edit", "deploy_preview"],
	"free project edge chat exposes R2 workspace tools plus managed preview deploy",
);

assert.deepEqual(
	createEdgeWebChatTools({
		input: { message: "inspect", channelId: "project:alice-bakery:web", source: "web", project },
		hostBridge,
		managedProjectBridge,
		workspaceBridge,
		emit,
	}).map((tool) => tool.name),
	["bash", "read", "write", "edit", "deploy_preview"],
	"host-backed Agent plan edge chat can expose bash plus edge-native tools",
);

console.log("edge-web-chat-tools ok");
