import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

interface ToolInfoLike {
	name: string;
	description?: string;
	parameters?: unknown;
	promptGuidelines?: string[];
	sourceInfo?: unknown;
}

export interface ToolSearchRegistry {
	getAllTools(): ToolInfoLike[];
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): void;
}

interface SearchToolsInput {
	query?: string;
	limit?: number;
	activate?: boolean;
	includeActive?: boolean;
	includeCore?: boolean;
}

const CORE_TOOL_NAMES = new Set([
	"attach",
	"bash",
	"edit",
	"list_channels",
	"read",
	"read_thread",
	"react_to_message",
	"search_tools",
	"self_configure",
	"send_message",
	"speak",
	"write",
	"yield_no_action",
]);

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function sourceLabel(sourceInfo: unknown): string | undefined {
	if (!sourceInfo || typeof sourceInfo !== "object") return undefined;
	const source = (sourceInfo as { source?: unknown }).source;
	const path = (sourceInfo as { path?: unknown }).path;
	if (typeof source === "string" && typeof path === "string") return `${source}:${path}`;
	if (typeof source === "string") return source;
	if (typeof path === "string") return path;
	return undefined;
}

function isCoreTool(tool: ToolInfoLike): boolean {
	return CORE_TOOL_NAMES.has(tool.name) || sourceLabel(tool.sourceInfo)?.startsWith("builtin") === true;
}

function normalizedLimit(limit: unknown): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return 8;
	return Math.max(1, Math.min(20, Math.floor(limit)));
}

function toolHaystack(tool: ToolInfoLike): string {
	return [
		tool.name,
		tool.description || "",
		...(tool.promptGuidelines || []),
		sourceLabel(tool.sourceInfo) || "",
	].join("\n").toLowerCase();
}

function scoreTool(tool: ToolInfoLike, query: string): number {
	const q = query.trim().toLowerCase();
	if (!q) return isCoreTool(tool) ? 0 : 1;

	let score = 0;
	const name = tool.name.toLowerCase();
	const description = (tool.description || "").toLowerCase();
	const haystack = toolHaystack(tool);
	const terms = q.split(/\s+/).filter(Boolean);

	if (name === q) score += 100;
	if (name.includes(q)) score += 40;
	if (description.includes(q)) score += 15;

	for (const term of terms) {
		if (name.includes(term)) score += 12;
		if (description.includes(term)) score += 5;
		if (haystack.includes(term)) score += 2;
	}

	return score;
}

function serializeTool(tool: ToolInfoLike, active: boolean) {
	return {
		name: tool.name,
		description: tool.description || tool.name,
		parameters: tool.parameters || { type: "object", properties: {}, additionalProperties: false },
		active,
		source: sourceLabel(tool.sourceInfo) || "custom",
	};
}

export function createSearchToolsTool(getRegistry: () => ToolSearchRegistry | null | undefined): AgentTool<any> {
	return {
		name: "search_tools",
		label: "search_tools",
		description: "Search custom and extension-provided tools that are not in the default tool set. Matching tools are activated by default, so after calling search_tools you can call the returned tool names on the next step.",
		parameters: Type.Object({
			query: Type.String({ description: "Capability to search for, for example DNS, domains, email, calendar, deploy, or screenshots." }),
			limit: Type.Optional(Type.Number({ description: "Maximum tools to return and activate. Defaults to 8, maximum 20." })),
			activate: Type.Optional(Type.Boolean({ description: "Whether to activate matching tools for the next model step. Defaults to true." })),
			includeActive: Type.Optional(Type.Boolean({ description: "Include tools that are already active. Defaults to false." })),
			includeCore: Type.Optional(Type.Boolean({ description: "Include core baked-in tools such as read, write, edit, and bash. Defaults to false." })),
		}),
		execute: async (_id: string, input: unknown) => {
			const registry = getRegistry();
			if (!registry) {
				return textResult(JSON.stringify({
					ok: false,
					error: "Tool registry is not initialized yet.",
				}, null, 2));
			}

			const body = (input && typeof input === "object" ? input : {}) as SearchToolsInput;
			const query = typeof body.query === "string" ? body.query : "";
			const limit = normalizedLimit(body.limit);
			const shouldActivate = body.activate !== false;
			const includeActive = body.includeActive === true;
			const includeCore = body.includeCore === true;
			const active = new Set(registry.getActiveToolNames());

			const matches = registry.getAllTools()
				.filter((tool) => tool.name !== "search_tools")
				.filter((tool) => includeCore || !isCoreTool(tool))
				.filter((tool) => includeActive || !active.has(tool.name))
				.map((tool) => ({ tool, score: scoreTool(tool, query) }))
				.filter((entry) => entry.score > 0)
				.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
				.slice(0, limit)
				.map((entry) => entry.tool);

			if (shouldActivate && matches.length > 0) {
				registry.setActiveToolsByName([...active, ...matches.map((tool) => tool.name)]);
			}

			return textResult(JSON.stringify({
				ok: true,
				query,
				activated: shouldActivate ? matches.map((tool) => tool.name) : [],
				tools: matches.map((tool) => serializeTool(tool, active.has(tool.name))),
				note: matches.length > 0
					? "Returned tools are now callable on the next model step when activate is true."
					: "No matching custom tools found.",
			}, null, 2));
		},
	};
}
