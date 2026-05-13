import type { WorkspaceEntry } from "../storage/workspace.js";

export interface ConsoleSession {
	mode: "standalone" | "hosted";
	agent_id: string;
	capabilities: Record<string, boolean>;
}

export interface ConsoleAgent {
	id: string;
	name: string;
	enabled: boolean;
	archived_at: string | null;
	runtime: string;
	provider: string;
	state: string;
	last_activity_at: string | null;
	current_task: string | null;
}

export interface ConsoleStatus {
	agent_id: string;
	mode: "standalone" | "hosted";
	runtime: string;
	workspace_ready: boolean;
	display_mode: "terminal" | "desktop";
	agent_name: string;
	capabilities: Record<string, boolean>;
}

export interface ConsoleAgentsResponse {
	scope: "active" | "fleet";
	count: number;
	agents: ConsoleAgent[];
}

export interface ConsoleFilesResponse {
	files: WorkspaceEntry[];
}
