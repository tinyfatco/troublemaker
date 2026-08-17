import { readFileSync } from "fs";
import { join } from "path";

export const COMPUTER_TOOL_MODES = ["cua", "codex-mcp", "off"] as const;
export type ComputerToolMode = typeof COMPUTER_TOOL_MODES[number];

function parseComputerToolMode(value: unknown, source: string): ComputerToolMode | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string" && COMPUTER_TOOL_MODES.includes(value.trim() as ComputerToolMode)) {
		return value.trim() as ComputerToolMode;
	}
	throw new Error(`${source} must be one of: ${COMPUTER_TOOL_MODES.join(", ")}`);
}

function readConfiguredMode(workspaceDir: string): ComputerToolMode | undefined {
	try {
		const settings = JSON.parse(readFileSync(join(workspaceDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return parseComputerToolMode(settings.computerMode, "settings.json computerMode");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) {
			throw new Error(`Cannot resolve computer tools from malformed settings.json: ${error.message}`);
		}
		throw error;
	}
}

/** Explicit environment wins over workspace settings. Generic hosts default off. */
export function resolveComputerToolMode(
	workspaceDir: string,
	environment: NodeJS.ProcessEnv = process.env,
): ComputerToolMode {
	return parseComputerToolMode(environment.TROUBLEMAKER_COMPUTER_MODE, "TROUBLEMAKER_COMPUTER_MODE")
		?? readConfiguredMode(workspaceDir)
		?? "off";
}
