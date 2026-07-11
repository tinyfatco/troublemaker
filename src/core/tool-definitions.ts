import { Type } from "typebox";

export const DEFAULT_BASH_TIMEOUT_SECONDS = 60;

export const bashToolSchema = Type.Object({
	label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
	show: Type.Optional(Type.Boolean({ description: "Surface this safe label only when it is a meaningful progress milestone. Default false." })),
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 60s). Increase for intentionally long-running commands." })),
});

export interface BashToolInput {
	label: string;
	command: string;
	timeout?: number;
}

export interface BashToolResult {
	stdout: string;
	stderr: string;
	code: number;
}
