import type { WorkspaceEntry } from "../storage/workspace.js";

export interface ConsoleSession {
	mode: "standalone" | "hosted" | "local-desktop";
	agent_id: string;
	local_agent_id?: string;
	cloud_agent_id?: string | null;
	tenant_id?: string | null;
	cloud_base_url?: string | null;
	profile?: string | null;
	capabilities: Record<string, boolean>;
}

export interface ConsoleAgent {
	id: string;
	name: string;
	local_agent_id?: string;
	cloud_agent_id?: string | null;
	tenant_id?: string | null;
	cloud_base_url?: string | null;
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
	local_agent_id?: string;
	cloud_agent_id?: string | null;
	tenant_id?: string | null;
	cloud_base_url?: string | null;
	profile?: string | null;
	mode: "standalone" | "hosted" | "local-desktop";
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
