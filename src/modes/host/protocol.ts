import type { BashToolInput, BashToolResult } from "../../core/tool-definitions.js";

export interface HostToolRequest<T = unknown> {
	tool: string;
	args: T;
	stream?: boolean;
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
export type HostToolExecuteRequest = HostToolRequest<Record<string, unknown>>;
export type HostToolExecuteResponse = HostToolResponse<unknown>;

export function isHostBashRequest(value: unknown): value is HostBashRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as HostToolRequest<Record<string, unknown>>;
	if (request.tool !== "bash") return false;
	const args = request.args;
	return !!args
		&& typeof args === "object"
		&& typeof args.command === "string"
		&& typeof args.label === "string"
		&& (args.timeout === undefined || typeof args.timeout === "number")
		&& (request.stream === undefined || typeof request.stream === "boolean");
}

export function isHostToolExecuteRequest(value: unknown): value is HostToolExecuteRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as HostToolRequest<Record<string, unknown>>;
	return typeof request.tool === "string"
		&& request.tool.trim().length > 0
		&& !!request.args
		&& typeof request.args === "object"
		&& !Array.isArray(request.args);
}
