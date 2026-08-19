import assert from "node:assert/strict";
import { createMcpConnectionToolDefinitions } from "../src/tools/mcp-connections.js";

const seen: Array<{
	url: string;
	authorization: string | null;
	body: Record<string, unknown>;
}> = [];

const fakeFetch: typeof fetch = async (input, init) => {
	seen.push({
		url: String(input),
		authorization: new Headers(init?.headers).get("authorization"),
		body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
	});
	return Response.json({
		url: `https://app.example.com/connect?v=tfat_one_${"a".repeat(24)}`,
		expires_at: "2026-08-18T20:00:00.000Z",
	});
};

function output(result: unknown): Record<string, unknown> {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	assert.equal(content?.[0]?.type, "text");
	return JSON.parse(content?.[0]?.text || "{}");
}

assert.deepEqual(createMcpConnectionToolDefinitions({}), [], "tool stays hidden outside Hostd");

const [tool] = createMcpConnectionToolDefinitions({
	baseUrl: "http://127.0.0.1:3099/",
	token: "example-context-MCP-control-capability",
	contextId: "front-desk:example:intake",
	fetch: fakeFetch,
});
assert.equal(tool.name, "mcp_connection");
assert.match(tool.description, /instead of asking anyone to paste a credential into chat/i);

const requested = await tool.execute("request-call", {
	action: "request",
	direction: "outbound",
	name: "Custom Vellum",
	server_url: "https://vellum.example.com/mcp",
});
assert.match(String(output(requested).url), /\?v=tfat_one_/);
assert.deepEqual(seen[0], {
	url: "http://127.0.0.1:3099/v1/mcp/control",
	authorization: "Bearer example-context-MCP-control-capability",
	body: {
		context_id: "front-desk:example:intake",
		action: "request",
		direction: "outbound",
		name: "Custom Vellum",
		server_url: "https://vellum.example.com/mcp",
	},
});

await tool.execute("request-both", {
	action: "request",
	direction: "bidirectional",
	name: "Vellum relationship exchange",
});
assert.equal(seen[1].body.direction, "bidirectional");

await tool.execute("list-call", { action: "list" });
assert.equal(seen[2].body.action, "list");

await tool.execute("revoke-call", {
	action: "revoke",
	direction: "inbound",
	id: "mcp_example",
});
assert.deepEqual(seen[3].body, {
	context_id: "front-desk:example:intake",
	action: "revoke",
	direction: "inbound",
	id: "mcp_example",
});

await assert.rejects(
	() => tool.execute("bad-revoke", { action: "revoke", id: "mcp_example" }),
	/requires its id and handoff\/inbound\/outbound direction/,
);

console.log("MCP connection tool: ok");
