import type { RuntimeStreamEvent } from "../core/runtime-contract.js";
import type { TuiAgentProfile } from "./config.js";
import { readRuntimeSse, readSseData } from "./protocol.js";

export interface TuiAgentStatus {
	agentName: string;
	runtime: string;
	mode: string;
	workspaceReady: boolean;
}

interface TuiBacklogResponse {
	lines: string[];
	total: number;
	offset: number;
}

export class TroublemakerTuiClient {
	constructor(private readonly profile: TuiAgentProfile) {}

	async getStatus(signal?: AbortSignal): Promise<TuiAgentStatus> {
		const health = await fetch(this.url("/health"), { signal });
		if (!health.ok) throw new Error(`Health check failed (${health.status})`);
		const response = await fetch(this.url("/api/v2/agents/current/status"), { signal });
		if (!response.ok) throw new Error(`Agent status failed (${response.status})`);
		const raw = await response.json() as Record<string, unknown>;
		return {
			agentName: stringValue(raw.agent_name) || this.profile.name,
			runtime: stringValue(raw.runtime) || "troublemaker",
			mode: stringValue(raw.mode) || "standalone",
			workspaceReady: raw.workspace_ready === true,
		};
	}

	async getBacklog(limit = 40, signal?: AbortSignal): Promise<TuiBacklogResponse> {
		const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
		const response = await fetch(this.url(`/api/v2/agents/current/events?limit=${boundedLimit}`), { signal });
		if (!response.ok) throw new Error(`Agent history failed (${response.status})`);
		const raw = await response.json() as Record<string, unknown>;
		return {
			lines: Array.isArray(raw.lines) ? raw.lines.filter((line): line is string => typeof line === "string") : [],
			total: numberValue(raw.total),
			offset: numberValue(raw.offset),
		};
	}

	async streamMessage(
		message: string,
		onEvent: (event: RuntimeStreamEvent) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<void> {
		const response = await fetch(this.url("/api/v2/agents/current/messages"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message,
				channelId: this.profile.channelId,
				source: "terminal",
				sourceEventType: "terminal_tui",
			}),
			signal,
		});
		for await (const event of readRuntimeSse(response)) {
			await onEvent(event);
		}
	}

	async streamAwareness(
		onLine: (line: string) => void | Promise<void>,
		signal?: AbortSignal,
		onConnected?: () => void | Promise<void>,
	): Promise<void> {
		const response = await fetch(this.url("/awareness/stream"), {
			headers: { Accept: "text/event-stream" },
			signal,
		});
		if (!response.ok || !response.body) {
			for await (const _data of readSseData(response)) {
				// readSseData supplies the canonical status/body error.
			}
			return;
		}
		await onConnected?.();
		for await (const line of readSseData(response)) {
			await onLine(line);
		}
	}

	async stop(signal?: AbortSignal): Promise<void> {
		const response = await fetch(this.url("/api/v2/agents/current/messages/stop"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ channelId: this.profile.channelId }),
			signal,
		});
		if (!response.ok) throw new Error(`Stop request failed (${response.status})`);
	}

	private url(path: string): string {
		return `${this.profile.baseUrl}${path}`;
	}
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
