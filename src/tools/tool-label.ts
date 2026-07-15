import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";

const DEFAULT_LABEL_DESCRIPTION = "Brief, safe, human-readable description of what this tool call is doing";
const wrappedTools = new WeakSet<object>();

export function requiredToolLabelSchema(description = DEFAULT_LABEL_DESCRIPTION): TSchema {
	return Type.String({
		description,
		minLength: 1,
		pattern: "\\S",
	});
}

/** Add a required, nonblank presentation label to an object-shaped tool schema. */
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
		? existingLabel.description
		: DEFAULT_LABEL_DESCRIPTION;
	const required = Array.isArray(record.required)
		? record.required.filter((entry): entry is string => typeof entry === "string")
		: [];

	return {
		...record,
		type: "object",
		properties: {
			...properties,
			label: {
				...existingLabel,
				...requiredToolLabelSchema(description),
			},
		},
		required: Array.from(new Set([...required, "label"])),
	} as T;
}

export function requireNonblankToolLabel(params: unknown, toolName = "Tool"): string {
	const label = params && typeof params === "object" && !Array.isArray(params)
		? (params as Record<string, unknown>).label
		: undefined;
	if (typeof label !== "string" || !label.trim()) {
		throw new Error(`${toolName} requires a nonblank label.`);
	}
	return label.trim();
}

/**
 * Enforce the label contract both in the schema shown to the model and at the
 * execution boundary. Mutating in place also covers tools loaded by the Pi
 * extension registry after the base tool array was created.
 */
export function enforceRequiredToolLabel<T extends AgentTool<any>>(tool: T): T {
	if (wrappedTools.has(tool as object)) return tool;

	tool.parameters = addRequiredToolLabelToSchema(tool.parameters);
	const originalPrepare = tool.prepareArguments;
	if (originalPrepare) {
		tool.prepareArguments = ((input: unknown) => {
			const prepared = originalPrepare.call(tool, input);
			requireNonblankToolLabel(prepared, tool.name);
			return prepared;
		}) as typeof tool.prepareArguments;
	}

	const originalExecute = tool.execute;
	tool.execute = (async (...args: unknown[]) => {
		requireNonblankToolLabel(args[1], tool.name);
		return (originalExecute as (...executeArgs: unknown[]) => unknown).apply(tool, args);
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
