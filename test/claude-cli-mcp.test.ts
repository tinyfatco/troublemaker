import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import {
	startClaudeCliMcpBridge,
	type ClaudeCliRuntimeToolEvent,
} from "../src/claude-cli-mcp.js";
import { emitToolOutput, type ToolOutputEvent } from "../src/tools/tool-output-stream.js";

const calls: Array<{ id: string; args: unknown }> = [];
const events: ClaudeCliRuntimeToolEvent[] = [];
const outputEvents: ToolOutputEvent[] = [];

const echoTool: AgentTool<any> = {
	name: "send_message",
	label: "send_message",
	description: "Test runtime delivery tool",
	parameters: Type.Object({
		label: Type.String(),
		target: Type.String(),
		text: Type.String(),
	}),
	execute: async (id, args) => {
		calls.push({ id, args });
		emitToolOutput({ toolCallId: id, stream: "stdout", text: "delivery progress" });
		return {
			content: [{ type: "text", text: `sent:${args.target}` }],
			details: { delivered: true },
		};
	},
};

const failTool: AgentTool<any> = {
	name: "fail_runtime_tool",
	label: "fail_runtime_tool",
	description: "Test runtime failure",
	parameters: Type.Object({}),
	execute: async () => {
		throw new Error("expected tool failure");
	},
};

const bridge = await startClaudeCliMcpBridge({
	tools: [echoTool, failTool],
	onToolEvent: (event) => events.push(event),
	onToolOutput: (event) => outputEvents.push(event),
});

const config = bridge.config.mcpServers.troublemaker;
assert.match(config.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]{48}$/);
assert.doesNotMatch(config.url, /Bearer|token/i, "bridge credential is not placed in the URL");
assert.match(config.headers.Authorization, /^Bearer [a-f0-9]{64}$/);

const unauthorized = await fetch(config.url, { method: "POST" });
assert.equal(unauthorized.status, 401, "per-turn MCP endpoint rejects unauthenticated loopback calls");

const transport = new StreamableHTTPClientTransport(new URL(config.url), {
	requestInit: { headers: config.headers },
});
const client = new Client({ name: "troublemaker-test", version: "1.0.0" });

try {
	await client.connect(transport);
	const listed = await client.listTools();
	assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["fail_runtime_tool", "send_message"]);

	const result = await client.callTool({
		name: "send_message",
		arguments: { label: "Reply to test", target: "C123", text: "hello" },
	});
	assert.equal(result.isError, undefined);
	assert.equal((result.content[0] as { type: string; text: string }).text, "sent:C123");
	assert.equal(calls.length, 1);
	assert.equal(events[0]?.type, "tool_execution_start");
	assert.equal(events[0]?.toolName, "send_message");
	assert.equal(events[1]?.type, "tool_execution_end");
	assert.equal(outputEvents[0]?.text, "delivery progress");
	assert.equal(outputEvents[0]?.toolCallId, calls[0]?.id);

	const invalid = await client.callTool({
		name: "send_message",
		arguments: { target: "C123", text: "missing label" },
	});
	assert.equal(invalid.isError, true);
	assert.match((invalid.content[0] as { type: string; text: string }).text, /Invalid arguments for send_message/);
	assert.equal(calls.length, 1, "schema-invalid MCP calls never reach the runtime tool");

	const failure = await client.callTool({ name: "fail_runtime_tool", arguments: {} });
	assert.equal(failure.isError, true);
	assert.match((failure.content[0] as { type: string; text: string }).text, /expected tool failure/);
	assert.equal(events.at(-1)?.type, "tool_execution_end");
	assert.equal(events.at(-1)?.type === "tool_execution_end" && events.at(-1)?.isError, true);
} finally {
	await client.close();
	await bridge.close();
}

console.log("claude-cli-mcp ok");
