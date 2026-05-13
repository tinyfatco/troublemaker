import { join } from "path";
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
}

export class ConsoleService {
	constructor(private readonly workspace: WorkspaceStore) {}

	getSession(): ConsoleSession {
		return {
			mode: "standalone",
			agent_id: "current",
			capabilities: {
				awareness: true,
				files: true,
				messages: true,
				terminal: true,
				desktop: false,
				voice: false,
				fleet: false,
			},
		};
	}

	getAgents(): ConsoleAgentsResponse {
		const config = this.readWorkspaceConfig();
		return {
			scope: "active",
			count: 1,
			agents: [{
				id: "current",
				name: config?.agent_name ?? "agent",
				enabled: true,
				archived_at: null,
				runtime: "troublemaker",
				provider: "standalone",
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

		return {
			agent_id: "current",
			mode: "standalone",
			runtime: "troublemaker",
			workspace_ready: true,
			...config,
			capabilities: {
				awareness: true,
				files: true,
				messages: true,
				terminal: true,
				desktop: config.display_mode === "desktop",
				voice: false,
			},
		};
	}

	getConfig(): WorkspaceConfig {
		const config = this.readWorkspaceConfig();
		if (!config) {
			throw new ConsoleError(503, "Workspace not ready");
		}
		return config;
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

	private readWorkspaceConfig(): WorkspaceConfig | null {
		try {
			const raw = this.workspace.readText("settings.json");
			if (!raw) return null;
			const settings = JSON.parse(raw);
			return {
				display_mode: settings.display_mode === "desktop" ? "desktop" : "terminal",
				agent_name: settings.name || "agent",
			};
		} catch {
			return null;
		}
	}
}
