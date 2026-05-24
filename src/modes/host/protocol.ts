import type { BashToolInput, BashToolResult } from "../../core/tool-definitions.js";

export interface HostToolRequest<T = unknown> {
	tool: string;
	args: T;
}

export interface HostToolSuccess<T = unknown> {
	ok: true;
	result: T;
}

export interface HostToolFailure {
	ok: false;
	error: string;
}

export type HostToolResponse<T = unknown> = HostToolSuccess<T> | HostToolFailure;

export type HostBashRequest = HostToolRequest<BashToolInput>;
export type HostBashResponse = HostToolResponse<BashToolResult>;

export function isHostBashRequest(value: unknown): value is HostBashRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as HostToolRequest<Record<string, unknown>>;
	if (request.tool !== "bash") return false;
	const args = request.args;
	return !!args
		&& typeof args === "object"
		&& typeof args.command === "string"
		&& typeof args.label === "string"
		&& (args.timeout === undefined || typeof args.timeout === "number");
}
