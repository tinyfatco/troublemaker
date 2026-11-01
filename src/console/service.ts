import { join } from "path";
import { readLocalTenantProfile, type LocalTenantProfile } from "../local/tenant-profile.js";
import type { WorkspaceStore } from "../storage/workspace.js";
import type {
	ConsoleAgentsResponse,
	ConsoleFilesResponse,
	ConsoleSession,
	ConsoleStatus,
} from "./types.js";

export const CHAT_IMAGE_MAXIMUM_BYTES = 5 * 1024 * 1024;
export const CHAT_IMAGE_MAXIMUM_DIMENSION = 8192;
export const CHAT_IMAGE_MAXIMUM_PIXELS = 40_000_000;

export function chatImageType(bytes: Uint8Array): string | null {
	const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) return "image/gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
	return null;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
	const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
	let offset = 2;
	while (offset + 3 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
		const marker = bytes[offset];
		if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			offset += 1;
			continue;
		}
		if (offset + 2 >= bytes.length) return null;
		const length = (bytes[offset + 1] << 8) | bytes[offset + 2];
		if (length < 2 || offset + length >= bytes.length) return null;
		if (sof.has(marker) && length >= 7) {
			return {
				height: (bytes[offset + 4] << 8) | bytes[offset + 5],
				width: (bytes[offset + 6] << 8) | bytes[offset + 7],
			};
		}
		offset += length + 1;
	}
	return null;
}

export function chatImageDimensions(bytes: Uint8Array, type: string): { width: number; height: number } | null {
	if (type === "image/png" && bytes.length >= 24) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	if (type === "image/gif" && bytes.length >= 10) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	}
	if (type === "image/jpeg") return jpegDimensions(bytes);
	if (type === "image/webp" && bytes.length >= 30) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const chunk = String.fromCharCode(...bytes.slice(12, 16));
		if (chunk === "VP8X") {
			return {
				width: 1 + view.getUint8(24) + (view.getUint8(25) << 8) + (view.getUint8(26) << 16),
				height: 1 + view.getUint8(27) + (view.getUint8(28) << 8) + (view.getUint8(29) << 16),
			};
		}
		if (chunk === "VP8L" && view.getUint8(20) === 0x2f) {
			return {
				width: 1 + view.getUint8(21) + ((view.getUint8(22) & 0x3f) << 8),
				height: 1 + (view.getUint8(22) >> 6) + (view.getUint8(23) << 2) + ((view.getUint8(24) & 0x0f) << 10),
			};
		}
		if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
			return {
				width: view.getUint16(26, true) & 0x3fff,
				height: view.getUint16(28, true) & 0x3fff,
			};
		}
	}
	return null;
}

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

	/** Read a workspace image for the chat, as a data: URL. The type comes from the bytes, never the name. */
	readImage(path: string): { image: string; type: string; bytes: number } {
		if (!path) throw new ConsoleError(400, "Missing path parameter");
		const stat = this.workspace.stat(path);
		if (!stat || stat.type !== "file") throw new ConsoleError(404, "Image not found");
		if (stat.size > CHAT_IMAGE_MAXIMUM_BYTES) throw new ConsoleError(413, "Image too large (>5MB)");
		const bytes = this.workspace.readBytes(path);
		if (!bytes) throw new ConsoleError(404, "Image not found");
		if (bytes.length > CHAT_IMAGE_MAXIMUM_BYTES) throw new ConsoleError(413, "Image too large (>5MB)");
		const type = chatImageType(bytes);
		if (!type) throw new ConsoleError(415, "Not a PNG, JPEG, WebP or GIF image");
		const dimensions = chatImageDimensions(bytes, type);
		if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
			throw new ConsoleError(415, "Image dimensions are invalid");
		}
		if (
			dimensions.width > CHAT_IMAGE_MAXIMUM_DIMENSION
			|| dimensions.height > CHAT_IMAGE_MAXIMUM_DIMENSION
			|| dimensions.width * dimensions.height > CHAT_IMAGE_MAXIMUM_PIXELS
		) throw new ConsoleError(413, "Image dimensions are too large");
		return { image: `data:${type};base64,${Buffer.from(bytes).toString("base64")}`, type, bytes: bytes.length };
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
			};
		} catch {
			return null;
		}
	}
}
