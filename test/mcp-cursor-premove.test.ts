import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { wrapMcpTool } from "../src/mcp-client/wrap-tool.js";

interface RecordedCall {
	name: string;
	arguments: Record<string, unknown>;
}

function makeClient(options: { moveFails?: boolean; results?: Record<string, string> } = {}): { client: Client; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const client = {
		async callTool(input: { name: string; arguments?: Record<string, unknown> }) {
			calls.push({ name: input.name, arguments: input.arguments || {} });
			if (input.name === "move" && options.moveFails) {
				throw new Error("move failed");
			}
			return { content: [{ type: "text", text: options.results?.[input.name] || `${input.name} ok` }] };
		},
	} as unknown as Client;
	return { client, calls };
}

function tool(name: string, client: Client) {
	return wrapMcpTool("peekaboo", {
		name,
		inputSchema: { type: "object", properties: {} },
	}, client);
}

{
	const { client, calls } = makeClient();
	await tool("click", client).execute("tool-1", {
		label: "Click Login",
		on: "B3",
		snapshot: "snap-1",
	});

	assert.deepEqual(calls.map((call) => call.name), ["move", "click"]);
	assert.deepEqual(calls[0].arguments, {
		id: "B3",
		smooth: true,
		profile: "human",
		duration: 450,
		snapshot: "snap-1",
	});
	assert.deepEqual(calls[1].arguments, { on: "B3", snapshot: "snap-1" });
}

{
	const { client, calls } = makeClient();
	await tool("click", client).execute("tool-2", {
		label: "Click coordinates",
		coords: "100,200",
	});

	assert.deepEqual(calls.map((call) => call.name), ["move", "click"]);
	assert.deepEqual(calls[0].arguments, {
		to: "100,200",
		smooth: true,
		profile: "human",
		duration: 450,
	});
	assert.deepEqual(calls[1].arguments, { coords: "100,200" });
}

{
	const { client, calls } = makeClient({
		results: {
			see: `UI State Captured
Snapshot ID: snap-spotify
Application: Spotify
Window: Spotify Premium
Screenshot: /tmp/spotify.png
Elements found: 245

UI Elements:
  elem_0 - "Spotify Premium" - at (560, 38) size 800x1205 - [not actionable]`,
		},
	});

	await tool("see", client).execute("tool-see", {
		label: "See Spotify",
		app_target: "Spotify",
		annotate: true,
	});
	await tool("click", client).execute("tool-click", {
		label: "Click cropped screenshot coordinate",
		coords: "478,135",
	});

	assert.deepEqual(calls.map((call) => call.name), ["see", "move", "click"]);
	assert.deepEqual(calls[1].arguments, {
		to: "1038,173",
		smooth: true,
		profile: "human",
		duration: 450,
	});
	assert.deepEqual(calls[2].arguments, { coords: "1038,173" });
}

{
	const { client, calls } = makeClient({
		results: {
			see: `UI State Captured
Snapshot ID: snap-spotify
Application: Spotify
UI Elements:
  elem_0 - "Spotify Premium" - at (560, 38) size 800x1205 - [not actionable]`,
		},
	});

	await tool("see", client).execute("tool-see", { label: "See Spotify" });
	await tool("click", client).execute("tool-click", {
		label: "Click absolute coordinate",
		coords: "650,135",
	});

	assert.deepEqual(calls.map((call) => call.name), ["see", "move", "click"]);
	assert.deepEqual(calls[1].arguments, {
		to: "650,135",
		smooth: true,
		profile: "human",
		duration: 450,
	});
	assert.deepEqual(calls[2].arguments, { coords: "650,135" });
}

{
	const { client, calls } = makeClient();
	await tool("type", client).execute("tool-3", {
		label: "Type query",
		on: "T1",
		text: "Daft Punk",
	});

	assert.deepEqual(calls.map((call) => call.name), ["move", "type"]);
	assert.deepEqual(calls[0].arguments, {
		id: "T1",
		smooth: true,
		profile: "human",
		duration: 350,
	});
	assert.deepEqual(calls[1].arguments, { on: "T1", text: "Daft Punk" });
}

{
	const { client, calls } = makeClient();
	await tool("scroll", client).execute("tool-4", {
		label: "Scroll list",
		on: "S2",
		direction: "down",
	});

	assert.deepEqual(calls.map((call) => call.name), ["move", "scroll"]);
	assert.deepEqual(calls[0].arguments, {
		id: "S2",
		smooth: true,
		profile: "human",
		duration: 350,
	});
	assert.deepEqual(calls[1].arguments, { on: "S2", direction: "down" });
}

{
	const { client, calls } = makeClient();
	const wrapped = wrapMcpTool("other", {
		name: "click",
		inputSchema: { type: "object", properties: {} },
	}, client);
	await wrapped.execute("tool-5", { label: "Other click", on: "B1" });

	assert.deepEqual(calls.map((call) => call.name), ["click"]);
}

{
	const { client, calls } = makeClient({ moveFails: true });
	await tool("click", client).execute("tool-6", {
		label: "Click despite move failure",
		on: "B9",
	});

	assert.deepEqual(calls.map((call) => call.name), ["move", "click"]);
}

console.log("mcp cursor pre-move tests passed");
