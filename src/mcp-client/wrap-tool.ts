import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readFileSync } from "node:fs";
import * as log from "../log.js";
import { requireNonblankToolLabel, requiredToolLabelSchema, stripToolPresentationArgs } from "../tools/tool-label.js";

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, object>;
		required?: string[];
		[key: string]: unknown;
	};
}

interface CoordinatePair {
	x: number;
	y: number;
}

interface PeekabooObservationBounds {
	x: number;
	y: number;
	width: number;
	height: number;
	snapshot?: string;
	app?: string;
	screenshot?: string;
}

const peekabooObservationBounds = new WeakMap<Client, PeekabooObservationBounds>();
const COMPUTER_USE_ALIASES = new Set(["cua", "cua-driver", "computer-use", "codex-computer-use"]);

export function isComputerControlHeld(
	alias: string,
	controlFile = process.env.TROUBLEMAKER_COMPUTER_CONTROL_FILE,
	now = Date.now(),
): boolean {
	if (!COMPUTER_USE_ALIASES.has(alias) || !controlFile) return false;
	try {
		const state = JSON.parse(readFileSync(controlFile, "utf8")) as {
			version?: unknown;
			mode?: unknown;
			expiresAt?: unknown;
		};
		return state.version === 1
			&& state.mode === "human"
			&& typeof state.expiresAt === "string"
			&& Date.parse(state.expiresAt) > now;
	} catch {
		// A missing or malformed optional gate cannot grant human control. Hostd
		// mounts the real file read-only for computer-enabled OCI contexts.
		return false;
	}
}

function getStringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseCoordinatePair(value: string): CoordinatePair | null {
	const match = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
	if (!match) return null;
	return { x: Number(match[1]), y: Number(match[2]) };
}

function formatCoordinatePair(pair: CoordinatePair): string {
	return `${Math.round(pair.x)},${Math.round(pair.y)}`;
}

function parsePeekabooObservationBounds(text: string): PeekabooObservationBounds | null {
	const boundsMatch = text.match(/(?:^|\n)\s*elem_0\s+-.*?-\s+at\s+\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)\s+size\s+(\d+(?:\.\d+)?)\s*[x\u00d7]\s*(\d+(?:\.\d+)?)/);
	if (!boundsMatch) return null;

	const bounds: PeekabooObservationBounds = {
		x: Number(boundsMatch[1]),
		y: Number(boundsMatch[2]),
		width: Number(boundsMatch[3]),
		height: Number(boundsMatch[4]),
	};
	if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width <= 0 || bounds.height <= 0) {
		return null;
	}

	const snapshot = text.match(/(?:^|\n)Snapshot ID:\s*([^\n]+)/)?.[1]?.trim();
	const app = text.match(/(?:^|\n)Application:\s*([^\n]+)/)?.[1]?.trim();
	const screenshot = text.match(/(?:^|\n)Screenshot:\s*([^\n]+)/)?.[1]?.trim();
	return {
		...bounds,
		...(snapshot ? { snapshot } : {}),
		...(app ? { app } : {}),
		...(screenshot ? { screenshot } : {}),
	};
}

function maybeRememberPeekabooObservation(
	alias: string,
	toolName: string,
	client: Client,
	text: string,
): void {
	if (alias !== "peekaboo") return;
	if (toolName !== "see" && toolName !== "inspect_ui") return;

	const bounds = parsePeekabooObservationBounds(text);
	if (!bounds) return;
	peekabooObservationBounds.set(client, bounds);
	log.logInfo(`[mcp-client] peekaboo__${toolName}: remembered observation bounds ${JSON.stringify(bounds).substring(0, 200)}`);
}

function maybeTranslateAppCroppedCoordinate(
	coords: string,
	client: Client,
	namespacedName: string,
): string | null {
	const bounds = peekabooObservationBounds.get(client);
	if (!bounds) return null;

	const pair = parseCoordinatePair(coords);
	if (!pair) return null;

	const withinLocalImage = pair.x >= 0 && pair.y >= 0 && pair.x <= bounds.width && pair.y <= bounds.height;
	if (!withinLocalImage) return null;

	const withinScreenWindow =
		pair.x >= bounds.x &&
		pair.y >= bounds.y &&
		pair.x <= bounds.x + bounds.width &&
		pair.y <= bounds.y + bounds.height;
	if (withinScreenWindow) return null;

	const translated = formatCoordinatePair({ x: bounds.x + pair.x, y: bounds.y + pair.y });
	log.logInfo(`[mcp-client] ${namespacedName}: translated app-cropped coords ${coords} -> ${translated}`);
	return translated;
}

function normalizePeekabooToolArgs(
	alias: string,
	toolName: string,
	args: Record<string, unknown>,
	client: Client,
	namespacedName: string,
): Record<string, unknown> {
	if (alias !== "peekaboo") return args;

	if (toolName === "click") {
		const coords = getStringArg(args, "coords");
		if (!coords) return args;
		const translated = maybeTranslateAppCroppedCoordinate(coords, client, namespacedName);
		return translated ? { ...args, coords: translated } : args;
	}

	if (toolName === "move") {
		const to = getStringArg(args, "to");
		if (to) {
			const translated = maybeTranslateAppCroppedCoordinate(to, client, namespacedName);
			if (translated) return { ...args, to: translated };
		}

		const coordinates = getStringArg(args, "coordinates");
		if (coordinates) {
			const translated = maybeTranslateAppCroppedCoordinate(coordinates, client, namespacedName);
			if (translated) return { ...args, coordinates: translated };
		}
	}

	return args;
}

function withOptionalSnapshot(args: Record<string, unknown>, moveArgs: Record<string, unknown>): Record<string, unknown> {
	const snapshot = getStringArg(args, "snapshot");
	return snapshot ? { ...moveArgs, snapshot } : moveArgs;
}

function buildPeekabooPreMoveArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> | null {
	if (toolName === "click") {
		const elementId = getStringArg(args, "on");
		if (elementId) {
			return withOptionalSnapshot(args, {
				id: elementId,
				smooth: true,
				profile: "human",
				duration: 450,
			});
		}

		const coords = getStringArg(args, "coords");
		if (coords) {
			return {
				to: coords,
				smooth: true,
				profile: "human",
				duration: 450,
			};
		}

		return null;
	}

	if (toolName === "type" || toolName === "scroll") {
		const elementId = getStringArg(args, "on");
		if (!elementId) return null;
		return withOptionalSnapshot(args, {
			id: elementId,
			smooth: true,
			profile: "human",
			duration: 350,
		});
	}

	return null;
}

async function maybePreMovePeekabooCursor(
	alias: string,
	toolName: string,
	toolArgs: Record<string, unknown>,
	client: Client,
	namespacedName: string,
	signal?: AbortSignal,
): Promise<void> {
	if (alias !== "peekaboo") return;

	const moveArgs = buildPeekabooPreMoveArgs(toolName, toolArgs);
	if (!moveArgs) return;

	try {
		log.logInfo(`[mcp-client] ${namespacedName}: pre-moving cursor ${JSON.stringify(moveArgs).substring(0, 200)}`);
		const result = await client.callTool({ name: "move", arguments: moveArgs }, undefined, { signal });
		if ("isError" in result && result.isError === true) {
			log.logWarning(`[mcp-client] ${namespacedName}: cursor pre-move returned error`);
		}
		await new Promise((resolve) => setTimeout(resolve, 120));
	} catch (err) {
		if (signal?.aborted) throw err;
		const errMsg = err instanceof Error ? err.message : String(err);
		log.logWarning(`[mcp-client] ${namespacedName}: cursor pre-move failed`, errMsg);
	}
}

function jsonSchemaToTypebox(schema: McpToolDef["inputSchema"]): TSchema {
	const properties: Record<string, TSchema> = {};
	const required = new Set(schema.required || []);

	if (schema.properties) {
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			const prop = propSchema as { type?: string; description?: string };
			let field: TSchema;

			switch (prop.type) {
				case "number":
				case "integer":
					field = Type.Number({ description: prop.description });
					break;
				case "boolean":
					field = Type.Boolean({ description: prop.description });
					break;
				case "array":
					field = Type.Array(Type.Any(), { description: prop.description });
					break;
				case "object":
					field = Type.Any({ description: prop.description });
					break;
				default:
					field = Type.String({ description: prop.description });
					break;
			}

			properties[key] = required.has(key) ? field : Type.Optional(field);
		}
	}

	// Pi requires a "label" parameter on all tools. `show` is local display
	// metadata and must never be forwarded to the MCP server.
	properties.label = requiredToolLabelSchema("Brief description of what you're doing with this tool");
	properties.show = Type.Optional(Type.Boolean({ description: "Surface this safe label only when it is a meaningful progress milestone. Default false." }));

	return Type.Object(properties);
}

export function wrapMcpTool(
	alias: string,
	tool: McpToolDef,
	client: Client,
): AgentTool<any> {
	const namespacedName = `${alias}__${tool.name}`;
	const description = tool.description
		? `[${alias}] ${tool.description}`
		: `[${alias}] ${tool.name}`;
	const enhancedDescription = alias === "peekaboo" && tool.name === "click"
		? `${description}\n\nCoordinate note: raw coordinates are global screen coordinates. Prefer element IDs from see/inspect_ui. If you use coordinates from an app/window screenshot, account for the window origin shown in the UI output.`
		: description;

	return {
		name: namespacedName,
		label: namespacedName,
		description: enhancedDescription,
		parameters: jsonSchemaToTypebox(tool.inputSchema),
		execute: async (
			_toolCallId: string,
			params: unknown,
			signal?: AbortSignal,
			_onUpdate?: unknown,
		): Promise<{ content: (TextContent | ImageContent)[]; details: undefined }> => {
			requireNonblankToolLabel(params, namespacedName);
			const toolArgs = stripToolPresentationArgs(params);
			const normalizedArgs = normalizePeekabooToolArgs(alias, tool.name, toolArgs, client, namespacedName);
			log.logInfo(`[mcp-client] ${namespacedName}: ${JSON.stringify(normalizedArgs).substring(0, 200)}`);

			try {
				if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
				if (isComputerControlHeld(alias)) {
					return {
						content: [{
							type: "text",
							text: "Computer use is paused while the user controls the shared desktop. Wait for them to return control.",
						}],
						details: undefined,
					};
				}
				await maybePreMovePeekabooCursor(alias, tool.name, normalizedArgs, client, namespacedName, signal);
				const result = await client.callTool({ name: tool.name, arguments: normalizedArgs }, undefined, { signal });

				const content: (TextContent | ImageContent)[] = [];
				const textParts: string[] = [];
				if ("content" in result && Array.isArray(result.content)) {
					for (const part of result.content) {
						if (part.type === "text" && "text" in part) {
							const text = part.text as string;
							textParts.push(text);
							content.push({ type: "text", text });
						} else if (
							part.type === "image"
							&& "data" in part
							&& "mimeType" in part
							&& typeof part.data === "string"
							&& typeof part.mimeType === "string"
							&& part.mimeType.startsWith("image/")
						) {
							content.push({ type: "image", data: part.data, mimeType: part.mimeType });
						}
					}
				}

				const text = textParts.length > 0
					? textParts.join("\n")
					: (content.length > 0 ? "MCP tool returned image content" : JSON.stringify(result));
				if (content.length === 0) content.push({ type: "text", text });
				maybeRememberPeekabooObservation(alias, tool.name, client, text);
				const isError = "isError" in result && result.isError === true;

				if (isError) {
					log.logWarning(`[mcp-client] ${namespacedName} returned error`, text.substring(0, 200));
				}

				return {
					content,
					details: undefined,
				};
			} catch (err) {
				if (signal?.aborted) throw err;
				const errMsg = err instanceof Error ? err.message : String(err);
				log.logWarning(`[mcp-client] ${namespacedName} failed`, errMsg);
				return {
					content: [{ type: "text", text: `MCP call failed: ${errMsg}` }],
					details: undefined,
				};
			}
		},
	};
}
