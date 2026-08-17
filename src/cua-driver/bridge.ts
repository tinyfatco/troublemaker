import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	CuaDriver,
	type CuaDriverLike,
	type DriverMetadata,
	type ToolResult,
} from "@trycua/cua-driver";
import type { TSchema } from "typebox";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripToolPresentationArgs } from "../tools/tool-label.js";

export const CUA_DRIVER_VERSION = "0.20.0";
export const CUA_CONTRACT_VERSION = "0.7.0";
export const CUA_TOOLS_SCHEMA_VERSION = "1";
export const CUA_CAPABILITY_VERSION = "1";
export const CUA_TOOL_PREFIX = "cua_";

export const CUA_DRIVER_020_TOOL_NAMES = [
	"list_apps", "list_windows", "get_window_state", "verify_state", "launch_app", "kill_app",
	"bring_to_front", "set_window_frame", "invoke_menu", "click", "double_click", "right_click",
	"drag", "type_text", "press_key", "hotkey", "set_value", "scroll", "clipboard_read",
	"clipboard_write", "get_screen_size", "get_desktop_state", "get_cursor_position", "move_cursor",
	"set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme", "get_agent_cursor_state",
	"check_permissions", "health_report", "get_config", "set_config", "get_accessibility_tree", "zoom",
	"page", "get_browser_state", "browser_prepare", "browser_navigate", "browser_click", "browser_type",
	"browser_dialog", "browser_set_input_files", "browser_download", "browser_pointer", "start_recording",
	"stop_recording", "get_recording_state", "replay_trajectory", "install_ffmpeg", "start_session",
	"escalate_session", "get_session", "list_sessions", "get_session_state", "end_session", "check_for_update",
] as const;

interface CuaToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

interface RawCuaToolDefinition {
	name: string;
	description: string;
	inputSchema?: Record<string, unknown>;
	input_schema?: Record<string, unknown>;
}

interface CuaToolInventory {
	schema_version: string;
	capability_version: string;
	tools: CuaToolDefinition[];
}

interface RawCuaToolInventory {
	schema_version?: unknown;
	capability_version?: unknown;
	tools?: RawCuaToolDefinition[];
}

export interface CuaDriverBridgeOptions {
	connect?: () => CuaDriverLike;
	prepareDaemon?: () => Promise<void>;
}

export interface CuaDriverCommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CuaDriverDaemonPreflightOptions {
	driverCommand?: string;
	platform?: NodeJS.Platform;
	timeoutMs?: number;
	pollIntervalMs?: number;
	runCommand?: (command: string, args: string[]) => Promise<CuaDriverCommandResult>;
}

function runCommand(command: string, args: string[]): Promise<CuaDriverCommandResult> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout, stderr) => {
			if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code !== "number") {
				reject(error);
				return;
			}
			resolve({
				code: error ? Number((error as NodeJS.ErrnoException & { code: number }).code) : 0,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			});
		});
	});
}

function daemonStatus(result: CuaDriverCommandResult): "running" | "stopped" {
	const output = `${result.stdout}\n${result.stderr}`;
	if (result.code === 0 && output.includes("Cua Driver daemon is running")) return "running";
	if (result.code === 1 && output.includes("Cua Driver daemon is not running")) return "stopped";
	throw new Error(`Cua Driver status probe failed closed (exit ${result.code})`);
}

/** Validate the pinned install and start only a definitely absent signed macOS daemon. */
export async function prepareInstalledCuaDriver(
	options: CuaDriverDaemonPreflightOptions = {},
): Promise<void> {
	const command = options.driverCommand
		?? (process.env.TROUBLEMAKER_CUA_DRIVER_COMMAND?.trim() || undefined)
		?? join(homedir(), ".local", "bin", "cua-driver");
	const execute = options.runCommand ?? runCommand;
	const version = await execute(command, ["--version"]);
	if (version.code !== 0 || version.stdout.trim() !== `cua-driver ${CUA_DRIVER_VERSION}`) {
		throw new Error(`Cua Driver ${CUA_DRIVER_VERSION} is required at ${command}`);
	}

	if (daemonStatus(await execute(command, ["status"])) === "running") return;
	if ((options.platform ?? process.platform) !== "darwin") {
		throw new Error("Cua Driver daemon is not running; automatic launch is supported only for the signed macOS app");
	}

	const launch = await execute("/usr/bin/open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"]);
	if (launch.code !== 0) throw new Error(`Failed to launch the signed CuaDriver app (exit ${launch.code})`);

	const timeoutMs = options.timeoutMs ?? 15_000;
	const pollIntervalMs = options.pollIntervalMs ?? 100;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (daemonStatus(await execute(command, ["status"])) === "running") return;
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	throw new Error(`Cua Driver daemon did not become ready within ${timeoutMs}ms`);
}

function parseJsonObject(value: string | undefined): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function validateMetadata(metadata: DriverMetadata): void {
	if (metadata.embedded) throw new Error("Cua Driver adapter requires the signed standalone daemon");
	const expected: Array<[keyof DriverMetadata, string]> = [
		["driverVersion", CUA_DRIVER_VERSION],
		["contractVersion", CUA_CONTRACT_VERSION],
		["toolsListSchemaVersion", CUA_TOOLS_SCHEMA_VERSION],
		["capabilityVersion", CUA_CAPABILITY_VERSION],
	];
	for (const [key, value] of expected) {
		if (metadata[key] !== value) {
			throw new Error(`Incompatible Cua Driver ${key}: expected ${value}, received ${String(metadata[key])}`);
		}
	}
}

function parseInventory(json: string): CuaToolInventory {
	let inventory: unknown;
	try {
		inventory = JSON.parse(json);
	} catch (error) {
		throw new Error(`Cua Driver returned malformed tool inventory: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
		throw new Error("Cua Driver tool inventory must be an object");
	}
	const candidate = inventory as RawCuaToolInventory;
	if (candidate.schema_version !== CUA_TOOLS_SCHEMA_VERSION || candidate.capability_version !== CUA_CAPABILITY_VERSION) {
		throw new Error("Cua Driver tool inventory contract does not match the pinned adapter");
	}
	if (!Array.isArray(candidate.tools)) throw new Error("Cua Driver tool inventory has no tools array");

	const names = new Set<string>();
	const tools: CuaToolDefinition[] = [];
	for (const tool of candidate.tools) {
		if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name)) {
			throw new Error("Cua Driver tool inventory contains an invalid tool name");
		}
		if (names.has(tool.name)) throw new Error(`Cua Driver tool inventory contains duplicate ${tool.name}`);
		names.add(tool.name);
		if (tool.inputSchema && tool.input_schema && JSON.stringify(tool.inputSchema) !== JSON.stringify(tool.input_schema)) {
			throw new Error(`Cua Driver tool ${tool.name} returned conflicting schema fields`);
		}
		const inputSchema = tool.inputSchema ?? tool.input_schema;
		if (typeof tool.description !== "string" || !inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
			throw new Error(`Cua Driver tool ${tool.name} has an invalid definition`);
		}
		tools.push({ name: tool.name, description: tool.description, inputSchema });
	}

	const expected = new Set<string>(CUA_DRIVER_020_TOOL_NAMES);
	const missing = [...expected].filter((name) => !names.has(name));
	const unexpected = [...names].filter((name) => !expected.has(name));
	if (missing.length || unexpected.length || names.size !== expected.size) {
		throw new Error(`Cua Driver 0.20.0 daemon tool surface mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`);
	}
	return {
		schema_version: candidate.schema_version,
		capability_version: candidate.capability_version,
		tools,
	} as CuaToolInventory;
}

function toAgentResult(result: ToolResult) {
	const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
	const prefix = result.isError
		? `Cua Driver refused or failed${result.errorCode ? ` (${result.errorCode})` : ""}: `
		: "";
	if (result.text || prefix) content.push({ type: "text", text: `${prefix}${result.text || "No error detail was returned."}` });
	for (const image of result.images) {
		content.push({ type: "image", data: image.dataBase64, mimeType: image.mimeType });
	}
	if (content.length === 0) content.push({ type: "text", text: "Cua Driver completed the operation." });
	return {
		content,
		details: {
			isError: result.isError,
			errorCode: result.errorCode,
			degraded: result.degraded,
			structured: parseJsonObject(result.structuredJson),
			action: result.action,
			verification: result.verification,
		},
	};
}

export class CuaDriverBridge {
	private readonly connectClient: () => CuaDriverLike;
	private readonly prepareDaemon: () => Promise<void>;
	private client?: CuaDriverLike;
	private toolDefinitions: AgentTool<any>[] = [];

	constructor(options: CuaDriverBridgeOptions = {}) {
		this.connectClient = options.connect ?? (() => CuaDriver.connect(undefined));
		this.prepareDaemon = options.prepareDaemon ?? (() => prepareInstalledCuaDriver());
	}

	async connect(): Promise<void> {
		if (this.client) return;
		await this.prepareDaemon();
		const client = this.connectClient();
		try {
			validateMetadata(await client.metadata());
			const inventory = parseInventory(await client.listToolsJson());
			this.toolDefinitions = inventory.tools.map((definition): AgentTool<any> => ({
				name: `${CUA_TOOL_PREFIX}${definition.name}`,
				label: `${CUA_TOOL_PREFIX}${definition.name}`,
				description: `${definition.description}\n\nThis is the native Cua Driver tool. Tool names referenced above are exposed with the ${CUA_TOOL_PREFIX} prefix.`,
				parameters: definition.inputSchema as TSchema,
				execute: async (_toolCallId, params, signal) => {
					if (signal?.aborted) throw new Error("Cua Driver operation aborted");
					const forwarded = stripToolPresentationArgs(params);
					const result = await client.callTool(
						definition.name,
						JSON.stringify(forwarded),
						signal ? { signal } : undefined,
					);
					return toAgentResult(result);
				},
			}));
			this.client = client;
		} catch (error) {
			await client.shutdown().catch(() => undefined);
			throw error;
		}
	}

	tools(): AgentTool<any>[] {
		return [...this.toolDefinitions];
	}

	async disconnect(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.toolDefinitions = [];
		if (client) await client.shutdown();
	}
}
