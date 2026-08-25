import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isComputerControlHeld, wrapMcpTool } from "../src/mcp-client/wrap-tool.js";

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

{
	let receivedSignal: AbortSignal | undefined;
	const client = {
		async callTool(
			_input: { name: string; arguments?: Record<string, unknown> },
			_schema?: unknown,
			options?: { signal?: AbortSignal },
		) {
			receivedSignal = options?.signal;
			return await new Promise((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("MCP request aborted")), { once: true });
			});
		},
	} as unknown as Client;
	const wrapped = wrapMcpTool("computer-use", {
		name: "click",
		inputSchema: { type: "object", properties: {} },
	}, client);
	const controller = new AbortController();
	const execution = wrapped.execute("tool-abort", { label: "Click target", element_index: 4 }, controller.signal);
	await Promise.resolve();
	controller.abort();
	await assert.rejects(execution, /MCP request aborted/);
	assert.equal(receivedSignal, controller.signal, "wrapped MCP tools receive the active run abort signal");
}

{
	const client = {
		async callTool() {
			return {
				content: [
					{ type: "text", text: "Desktop captured" },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
			};
		},
	} as unknown as Client;
	const wrapped = wrapMcpTool("cua", {
		name: "get_desktop_state",
		inputSchema: { type: "object", properties: {} },
	}, client);
	const result = await wrapped.execute("tool-image", { label: "Inspect the desktop" });
	assert.deepEqual(result.content, [
		{ type: "text", text: "Desktop captured" },
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
	], "CUA screenshots remain visible to the model");
}

{
	const directory = await mkdtemp(join(tmpdir(), "troublemaker-computer-control-"));
	const controlFile = join(directory, "state.json");
	const previous = process.env.TROUBLEMAKER_COMPUTER_CONTROL_FILE;
	let calls = 0;
	try {
		await writeFile(controlFile, JSON.stringify({
			version: 1,
			mode: "human",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		}));
		process.env.TROUBLEMAKER_COMPUTER_CONTROL_FILE = controlFile;
		assert.equal(isComputerControlHeld("cua", controlFile), true);
		const client = {
			async callTool() {
				calls++;
				return { content: [{ type: "text", text: "clicked" }] };
			},
		} as unknown as Client;
		const wrapped = wrapMcpTool("cua", {
			name: "click",
			inputSchema: { type: "object", properties: {} },
		}, client);
		const held = await wrapped.execute("tool-held", { label: "Click target" });
		assert.equal(calls, 0, "the agent cannot inject input during a human takeover");
		assert.match(held.content[0].type === "text" ? held.content[0].text : "", /user controls/);

		await writeFile(controlFile, JSON.stringify({
			version: 1,
			mode: "human",
			expiresAt: new Date(Date.now() - 1_000).toISOString(),
		}));
		assert.equal(isComputerControlHeld("cua", controlFile), false, "expired leases fail back to agent control");
		await wrapped.execute("tool-expired", { label: "Click target" });
		assert.equal(calls, 1);
	} finally {
		if (previous === undefined) delete process.env.TROUBLEMAKER_COMPUTER_CONTROL_FILE;
		else process.env.TROUBLEMAKER_COMPUTER_CONTROL_FILE = previous;
		await rm(directory, { recursive: true, force: true });
	}
}

console.log("mcp cursor pre-move tests passed");
