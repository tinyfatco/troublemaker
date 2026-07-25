import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runEdgeWebChat, type EdgeAgentMessage } from "../src/modes/edge/index.js";
import { createEdgeAgentSession } from "../src/modes/edge/pi-session.js";

assert.equal(typeof runEdgeWebChat, "function");

const initialMessages = [{
	role: "user",
	content: [{ type: "text", text: "[2026-05-23T12:00:00.000Z] [web] [user]: remember this" }],
	timestamp: Date.parse("2026-05-23T12:00:00.000Z"),
}] as EdgeAgentMessage[];

const agent = createEdgeAgentSession({
	systemPrompt: "test",
	model: {
		id: "test-model",
		name: "test-model",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 128,
	},
	apiKey: "test-key",
	tools: [],
	initialMessages,
	emit: () => {},
});

assert.equal(agent.state.messages.length, 1);
assert.equal((agent.state.messages[0] as { role?: string }).role, "user");

const edgeFiles = [
	"src/modes/edge/index.ts",
	"src/modes/edge/pi-session.ts",
	"src/modes/edge/tools.ts",
	"src/modes/edge/host-bridge.ts",
	"src/modes/edge/r2-compat.ts",
];

for (const file of edgeFiles) {
	const content = readFileSync(join(process.cwd(), file), "utf-8");
	assert.equal(
		content.includes("@earendil-works/pi-coding-agent"),
		false,
		`${file} must not import pi-coding-agent's Node/TUI entrypoints`,
	);
}

console.log("edge-runtime-import ok");
