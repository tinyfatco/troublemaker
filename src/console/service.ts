import { join } from "path";
import { resolveMacOSComputerAutoSpeech } from "../context.js";
import { readLocalTenantProfile, type LocalTenantProfile } from "../local/tenant-profile.js";
import type { WorkspaceStore } from "../storage/workspace.js";
import type {
	ConsoleAgentsResponse,
	ConsoleFilesResponse,
	ConsoleSession,
	ConsoleStatus,
} from "./types.js";

export class ConsoleError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

interface WorkspaceConfig {
	display_mode: "terminal" | "desktop";
	agent_name: string;
	macos_computer_auto_speech: boolean;
}

type PublicWorkspaceConfig = Pick<WorkspaceConfig, "display_mode" | "agent_name">;

export class ConsoleService {
	constructor(
		private readonly workspace: WorkspaceStore,
		private readonly env: Record<string, string | undefined> = process.env,
	) {}

	getSession(): ConsoleSession {
		const profile = this.readProfile();
		return {
			mode: profile.mode,
			agent_id: profile.localAgentId,
			local_agent_id: profile.localAgentId,
			cloud_agent_id: profile.cloudAgentId,
			tenant_id: profile.tenantId,
			cloud_base_url: profile.cloudBaseUrl,
			profile: profile.profileName || null,
			capabilities: {
				awareness: true,
				files: true,
				messages: true,
				terminal: true,
				desktop: profile.displayMode === "desktop",
				voice: true,
				fleet: profile.profileActive,
			},
		};
	}

	getAgents(): ConsoleAgentsResponse {
		const profile = this.readProfile();
		return {
			scope: "active",
			count: 1,
			agents: [{
				id: profile.localAgentId,
				local_agent_id: profile.localAgentId,
				cloud_agent_id: profile.cloudAgentId,
				tenant_id: profile.tenantId,
				cloud_base_url: profile.cloudBaseUrl,
				name: profile.agentName,
				enabled: true,
				archived_at: null,
				runtime: "troublemaker",
				provider: profile.mode,
				state: "active",
				last_activity_at: null,
				current_task: null,
			}],
		};
	}

	getStatus(): ConsoleStatus {
		const config = this.readWorkspaceConfig();
		if (!config) {
			throw new ConsoleError(503, "Workspace not ready");
		}
		const profile = this.readProfile(config);

		return {
			agent_id: profile.localAgentId,
			local_agent_id: profile.localAgentId,
			cloud_agent_id: profile.cloudAgentId,
			tenant_id: profile.tenantId,
			cloud_base_url: profile.cloudBaseUrl,
			profile: profile.profileName || null,
			mode: profile.mode,
			runtime: "troublemaker",
			workspace_ready: true,
			display_mode: profile.displayMode,
			agent_name: profile.agentName,
			client_preferences: {
				macos_computer_auto_speech: config.macos_computer_auto_speech,
			},
			capabilities: {
				awareness: true,
				files: true,
				messages: true,
				terminal: true,
				desktop: profile.displayMode === "desktop",
				voice: true,
			},
		};
	}

	getConfig(): PublicWorkspaceConfig {
		const config = this.readWorkspaceConfig();
		if (!config) {
			throw new ConsoleError(503, "Workspace not ready");
		}
		return {
			display_mode: config.display_mode,
			agent_name: config.agent_name,
		};
	}

	listFiles(path: string): ConsoleFilesResponse {
		const stat = this.workspace.stat(path);
		if (!stat) throw new ConsoleError(404, "Directory not found");
		if (stat.type !== "directory") throw new ConsoleError(400, "Not a directory");

		const files = this.workspace.list(path);
		files.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return { files };
	}

	readFile(path: string): string {
		if (!path) throw new ConsoleError(400, "Missing path parameter");

		const stat = this.workspace.stat(path);
		if (!stat) throw new ConsoleError(404, "File not found");
		if (stat.type === "directory") throw new ConsoleError(400, "Path is a directory, use /api/files");
		if (stat.size > 5 * 1024 * 1024) throw new ConsoleError(413, "File too large (>5MB)");

		const content = this.workspace.readText(path);
		if (content === null) throw new ConsoleError(404, "File not found");
		return content;
	}

	writeFile(path: string, content: string): void {
		if (!path || typeof content !== "string") {
			throw new ConsoleError(400, "Missing path or content");
		}
		this.workspace.writeText(path, content);
	}

	uploadFile(targetDir: string, filename: string, data: Uint8Array): string {
		const safeName = filename.replace(/[/\\]/g, "_").replace(/\.{2,}/g, ".");
		if (!safeName) throw new ConsoleError(400, "Invalid filename");
		const relPath = join(targetDir || "attachments", safeName);
		this.workspace.writeBytes(relPath, data);
		return relPath;
	}

	private readProfile(_config?: WorkspaceConfig): LocalTenantProfile {
		return readLocalTenantProfile(this.workspace, this.env);
	}

	private readWorkspaceConfig(): WorkspaceConfig | null {
		try {
			const raw = this.workspace.readText("settings.json");
			if (!raw) return null;
			const settings = JSON.parse(raw);
			return {
				display_mode: settings.display_mode === "desktop" ? "desktop" : "terminal",
				agent_name: settings.name || "agent",
				macos_computer_auto_speech: resolveMacOSComputerAutoSpeech(settings),
			};
		} catch {
			return null;
		}
	}
}
