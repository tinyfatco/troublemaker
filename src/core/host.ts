import type { AwarenessStore } from "../storage/awareness.js";
import type { EventStore } from "../storage/events.js";
import type { SettingsStore } from "../storage/settings.js";
import type { WorkspaceStore } from "../storage/workspace.js";

export interface HostCapabilities {
	awareness: boolean;
	files: boolean;
	messages: boolean;
	terminal: boolean;
	desktop: boolean;
	voice: boolean;
	shell: boolean;
	fleet?: boolean;
}

export interface ExecutionService {
	exec(command: string, options?: { timeout?: number; signal?: AbortSignal }): Promise<{
		stdout: string;
		stderr: string;
		code: number;
	}>;
	getWorkspacePath(hostPath: string): string;
}

export interface HostServices {
	capabilities: HostCapabilities;
	workspace: WorkspaceStore;
	awareness: AwarenessStore;
	settings: SettingsStore;
	events?: EventStore;
	executor?: ExecutionService;
	env(name: string): string | undefined;
	now(): Date;
	randomUUID(): string;
	fetch: typeof fetch;
}
