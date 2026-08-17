import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	CuaDriver,
	type CuaDriverLike,
	type DriverMetadata,
	type ToolResult,
} from "@trycua/cua-driver";
import type { TSchema } from "typebox";
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
	"escalate_session", "get_session", "list_sessions", "get_session_state", "end_session",
] as const;

interface CuaToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

interface CuaToolInventory {
	schema_version: string;
	capability_version: string;
	tools: CuaToolDefinition[];
}

export interface CuaDriverBridgeOptions {
	connect?: () => CuaDriverLike;
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
	const candidate = inventory as Partial<CuaToolInventory>;
	if (candidate.schema_version !== CUA_TOOLS_SCHEMA_VERSION || candidate.capability_version !== CUA_CAPABILITY_VERSION) {
		throw new Error("Cua Driver tool inventory contract does not match the pinned adapter");
	}
	if (!Array.isArray(candidate.tools)) throw new Error("Cua Driver tool inventory has no tools array");

	const names = new Set<string>();
	for (const tool of candidate.tools) {
		if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name)) {
			throw new Error("Cua Driver tool inventory contains an invalid tool name");
		}
		if (names.has(tool.name)) throw new Error(`Cua Driver tool inventory contains duplicate ${tool.name}`);
		names.add(tool.name);
		if (typeof tool.description !== "string" || !tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
			throw new Error(`Cua Driver tool ${tool.name} has an invalid definition`);
		}
	}

	const expected = new Set<string>(CUA_DRIVER_020_TOOL_NAMES);
	const missing = [...expected].filter((name) => !names.has(name));
	const unexpected = [...names].filter((name) => !expected.has(name));
	if (missing.length || unexpected.length || names.size !== expected.size) {
		throw new Error(`Cua Driver 0.20.0 tool surface mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`);
	}
	return candidate as CuaToolInventory;
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
	private client?: CuaDriverLike;
	private toolDefinitions: AgentTool<any>[] = [];

	constructor(options: CuaDriverBridgeOptions = {}) {
		this.connectClient = options.connect ?? (() => CuaDriver.connect(undefined));
	}

	async connect(): Promise<void> {
		if (this.client) return;
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
