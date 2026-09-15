import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";

const DEFAULT_LABEL_DESCRIPTION = "Strongly recommended: brief, safe, human-readable description of what this tool call is doing. If omitted or blank, the runtime uses the tool name so execution still proceeds.";
const wrappedTools = new WeakSet<object>();

/**
 * Compatibility name retained for extensions. The label is deliberately
 * optional and permissive; execution always has a readable runtime fallback.
 */
export function requiredToolLabelSchema(description = DEFAULT_LABEL_DESCRIPTION): TSchema {
	return Type.Optional(Type.String({ description: encouragedDescription(description) }));
}

/** Add an encouraged, non-fatal presentation label to an object-shaped schema. */
export function addRequiredToolLabelToSchema<T>(schema: T): T {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return Type.Object({ label: requiredToolLabelSchema() }) as T;
	}

	const record = schema as Record<string, unknown>;
	const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
		? record.properties as Record<string, unknown>
		: {};
	const existingLabel = properties.label && typeof properties.label === "object" && !Array.isArray(properties.label)
		? properties.label as Record<string, unknown>
		: {};
	const description = typeof existingLabel.description === "string" && existingLabel.description.trim()
		? encouragedDescription(existingLabel.description)
		: DEFAULT_LABEL_DESCRIPTION;
	const required = Array.isArray(record.required)
		? record.required.filter((entry): entry is string => typeof entry === "string" && entry !== "label")
		: [];

	return {
		...record,
		type: "object",
		properties: {
			...properties,
			label: requiredToolLabelSchema(description),
		},
		required,
	} as T;
}

/** Resolve a safe display label without ever rejecting an otherwise valid call. */
export function requireNonblankToolLabel(params: unknown, toolName = "Tool"): string {
	const label = params && typeof params === "object" && !Array.isArray(params)
		? (params as Record<string, unknown>).label
		: undefined;
	if (typeof label === "string" && label.trim()) return label.trim();
	return readableToolName(toolName);
}

/**
 * Encourage the label in model-facing schemas and inject a readable fallback
 * at the execution boundary. Mutating in place also covers tools registered by
 * Pi extensions after the base tool array was created.
 */
export function enforceRequiredToolLabel<T extends AgentTool<any>>(tool: T): T {
	if (wrappedTools.has(tool as object)) return tool;

	tool.parameters = addRequiredToolLabelToSchema(tool.parameters);
	const originalPrepare = tool.prepareArguments;
	if (originalPrepare) {
		tool.prepareArguments = ((input: unknown) => {
			const prepared = originalPrepare.call(tool, input);
			return withResolvedToolLabel(prepared, tool.name);
		}) as typeof tool.prepareArguments;
	}

	const originalExecute = tool.execute;
	tool.execute = (async (...args: unknown[]) => {
		const resolved = [...args];
		resolved[1] = withResolvedToolLabel(args[1], tool.name);
		return (originalExecute as (...executeArgs: unknown[]) => unknown).apply(tool, resolved);
	}) as typeof tool.execute;

	wrappedTools.add(tool as object);
	return tool;
}

export function enforceRequiredToolLabels<T extends AgentTool<any>>(tools: T[]): T[] {
	return tools.map((tool) => enforceRequiredToolLabel(tool));
}

/** Remove local presentation metadata before an outbound MCP call. */
export function stripToolPresentationArgs(params: unknown): Record<string, unknown> {
	const source = params && typeof params === "object" && !Array.isArray(params)
		? params as Record<string, unknown>
		: {};
	const { label: _label, show: _show, ...forwarded } = source;
	return forwarded;
}

function withResolvedToolLabel(params: unknown, toolName: string): Record<string, unknown> {
	const source = params && typeof params === "object" && !Array.isArray(params)
		? params as Record<string, unknown>
		: {};
	return { ...source, label: requireNonblankToolLabel(source, toolName) };
}

function encouragedDescription(description: string): string {
	const trimmed = description.trim();
	if (/strongly recommended/i.test(trimmed)) return trimmed;
	return `${trimmed} Strongly recommended, but omission or blank text never blocks execution.`;
}

export function readableToolName(toolName: string): string {
	const leaf = toolName.split("__").at(-1) || toolName;
	const words = leaf.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Tool";
	return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
