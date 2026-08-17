import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CuaDriverLike, DriverMetadata, ToolResult } from "@trycua/cua-driver";
import {
	CUA_DRIVER_020_TOOL_NAMES,
	CuaDriverBridge,
	prepareInstalledCuaDriver,
} from "../src/cua-driver/bridge.js";
import { resolveComputerToolMode } from "../src/cua-driver/mode.js";
import { isComputerUseMcpServer } from "../src/mcp-client/bridge.js";

const metadata: DriverMetadata = {
	driverVersion: "0.20.0",
	contractVersion: "0.7.0",
	toolsListSchemaVersion: "1",
	capabilityVersion: "1",
	mcpProtocolVersion: "2025-06-18",
	pid: 123,
	embedded: false,
};

function inventory(overrides: { names?: readonly string[]; schema?: string } = {}): string {
	return JSON.stringify({
		schema_version: overrides.schema ?? "1",
		capability_version: "1",
		tools: (overrides.names ?? CUA_DRIVER_020_TOOL_NAMES).map((name) => ({
			name,
			description: `Native ${name}`,
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		})),
	});
}

function fakeClient(options: {
	metadata?: DriverMetadata;
	inventory?: string;
	result?: ToolResult;
	onCall?: (name: string, args: string, signal?: AbortSignal) => void;
	onShutdown?: () => void;
} = {}): CuaDriverLike {
	return {
		metadata: async () => options.metadata ?? metadata,
		listToolsJson: async () => options.inventory ?? inventory(),
		callTool: async (name: string, args: string, asyncOptions?: { signal: AbortSignal }) => {
			options.onCall?.(name, args, asyncOptions?.signal);
			return options.result ?? {
				text: "ok",
				images: [],
				isError: false,
				degraded: false,
				rawJson: "{}",
			};
		},
		shutdown: async () => options.onShutdown?.(),
	} as unknown as CuaDriverLike;
}

test("computer mode is explicit, exclusive, and fails closed", () => {
	const dir = mkdtempSync(join(tmpdir(), "troublemaker-cua-mode-"));
	try {
		assert.equal(resolveComputerToolMode(dir, {}), "off");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ computerMode: "cua" }));
		assert.equal(resolveComputerToolMode(dir, {}), "cua");
		assert.equal(resolveComputerToolMode(dir, { TROUBLEMAKER_COMPUTER_MODE: "codex-mcp" }), "codex-mcp");
		assert.throws(() => resolveComputerToolMode(dir, { TROUBLEMAKER_COMPUTER_MODE: "both" }), /must be one of/);
		writeFileSync(join(dir, "settings.json"), "{");
		assert.throws(() => resolveComputerToolMode(dir, {}), /malformed settings/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("computer MCP detection covers aliases and capability scope", () => {
	assert.equal(isComputerUseMcpServer({ alias: "computer-use", transport: "stdio", command: "x", args: [], scopes: [] }), true);
	assert.equal(isComputerUseMcpServer({ alias: "anything", transport: "stdio", command: "x", args: [], scopes: ["computer:use"] }), true);
	assert.equal(isComputerUseMcpServer({ alias: "github", transport: "stdio", command: "x", args: [], scopes: ["repo:read"] }), false);
});

test("daemon preflight never launches when the pinned daemon is already running", async () => {
	const calls: Array<[string, string[]]> = [];
	await prepareInstalledCuaDriver({
		driverCommand: "/synthetic/cua-driver",
		runCommand: async (command, args) => {
			calls.push([command, args]);
			return args[0] === "--version"
				? { code: 0, stdout: "cua-driver 0.20.0\n", stderr: "" }
				: { code: 0, stdout: "Cua Driver daemon is running\n", stderr: "" };
		},
	});
	assert.deepEqual(calls, [
		["/synthetic/cua-driver", ["--version"]],
		["/synthetic/cua-driver", ["status"]],
	]);
});

test("daemon preflight launches only a definitely stopped signed macOS app", async () => {
	const calls: Array<[string, string[]]> = [];
	let statusChecks = 0;
	await prepareInstalledCuaDriver({
		driverCommand: "/synthetic/cua-driver",
		platform: "darwin",
		pollIntervalMs: 0,
		runCommand: async (command, args) => {
			calls.push([command, args]);
			if (args[0] === "--version") return { code: 0, stdout: "cua-driver 0.20.0\n", stderr: "" };
			if (command === "/usr/bin/open") return { code: 0, stdout: "", stderr: "" };
			statusChecks += 1;
			return statusChecks < 2
				? { code: 1, stdout: "", stderr: "Cua Driver daemon is not running\n" }
				: { code: 0, stdout: "Cua Driver daemon is running\n", stderr: "" };
		},
	});
	assert.deepEqual(calls[2], ["/usr/bin/open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"]]);
});

test("daemon preflight fails closed without launching on version or status ambiguity", async () => {
	let launched = false;
	await assert.rejects(prepareInstalledCuaDriver({
		runCommand: async (_command, args) => {
			if (args[0] === "--version") return { code: 0, stdout: "cua-driver 0.19.0\n", stderr: "" };
			launched = true;
			return { code: 0, stdout: "", stderr: "" };
		},
	}), /0\.20\.0 is required/);
	assert.equal(launched, false);

	await assert.rejects(prepareInstalledCuaDriver({
		runCommand: async (command, args) => {
			if (args[0] === "--version") return { code: 0, stdout: "cua-driver 0.20.0\n", stderr: "" };
			if (command === "/usr/bin/open") launched = true;
			return { code: 2, stdout: "unexpected", stderr: "" };
		},
	}), /status probe failed closed/);
	assert.equal(launched, false);
});

test("native inventory becomes namespaced deferred Pi tools and forwards exact arguments", async () => {
	let call: { name: string; args: string; signal?: AbortSignal } | undefined;
	const result: ToolResult = {
		text: "captured",
		images: [{ mimeType: "image/png", dataBase64: "aW1hZ2U=" }],
		structuredJson: "{\"window\":1}",
		isError: false,
		degraded: false,
		rawJson: "{}",
	};
	const bridge = new CuaDriverBridge({
		prepareDaemon: async () => undefined,
		connect: () => fakeClient({
			result,
			onCall: (name, args, signal) => { call = { name, args, signal }; },
		}),
	});
	await bridge.connect();
	const tools = bridge.tools();
	assert.equal(tools.length, 55);
	assert.equal(new Set(tools.map((tool) => tool.name)).size, 55);
	const click = tools.find((tool) => tool.name === "cua_click");
	assert.ok(click);
	const controller = new AbortController();
	const output = await click.execute("call-1", { label: "Click safely", show: true, x: 4, y: 9 }, controller.signal);
	assert.deepEqual(call, { name: "click", args: "{\"x\":4,\"y\":9}", signal: controller.signal });
	assert.deepEqual(output.content, [
		{ type: "text", text: "captured" },
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
	]);
	assert.deepEqual((output.details as { structured: unknown }).structured, { window: 1 });
	await bridge.disconnect();
});

test("Cua refusal stays prominent while retaining image evidence", async () => {
	const bridge = new CuaDriverBridge({ prepareDaemon: async () => undefined, connect: () => fakeClient({ result: {
		text: "approval required",
		images: [{ mimeType: "image/jpeg", dataBase64: "eA==" }],
		isError: true,
		errorCode: "policy_denied",
		degraded: false,
		rawJson: "{}",
	} }) });
	await bridge.connect();
	const output = await bridge.tools()[0].execute("call-2", { label: "Inspect" });
	assert.match((output.content[0] as { text: string }).text, /^Cua Driver refused or failed \(policy_denied\):/);
	assert.equal(output.content[1].type, "image");
});

test("version, schema, duplicates, and exact surface mismatches fail closed", async () => {
	for (const client of [
		fakeClient({ metadata: { ...metadata, driverVersion: "0.19.0" } }),
		fakeClient({ inventory: inventory({ schema: "2" }) }),
		fakeClient({ inventory: inventory({ names: [...CUA_DRIVER_020_TOOL_NAMES, "click"] }) }),
		fakeClient({ inventory: inventory({ names: CUA_DRIVER_020_TOOL_NAMES.slice(1) }) }),
	]) {
		let shutdown = false;
		const originalShutdown = client.shutdown.bind(client);
		client.shutdown = async () => { shutdown = true; await originalShutdown(); };
		const bridge = new CuaDriverBridge({ prepareDaemon: async () => undefined, connect: () => client });
		await assert.rejects(bridge.connect());
		assert.equal(shutdown, true);
		assert.deepEqual(bridge.tools(), []);
	}
});

test("adapter has no model, MCP, or API-key execution path", async () => {
	const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/cua-driver/bridge.ts", import.meta.url), "utf8"));
	assert.doesNotMatch(source, /OPENAI_API_KEY|McpBridge|streamSimple|responses\.create|chat\.completions/);
});
