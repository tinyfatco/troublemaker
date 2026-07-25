import type { WorkspaceStore } from "../storage/workspace.js";

export type LocalRuntimeMode = "standalone" | "local-desktop";
export type LocalDisplayMode = "terminal" | "desktop";

export interface LocalTenantProfile {
	mode: LocalRuntimeMode;
	profileName: string;
	localAgentId: string;
	agentName: string;
	displayMode: LocalDisplayMode;
	cloudAgentId: string | null;
	tenantId: string | null;
	cloudBaseUrl: string | null;
	profileActive: boolean;
}

export interface GenericContextConflict {
	conflict: boolean;
	reasons: string[];
}

type Env = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function setting(settings: Record<string, unknown>, camel: string, snake?: string): string | undefined {
	return stringValue(settings[camel]) ?? (snake ? stringValue(settings[snake]) : undefined);
}

function readSettings(workspace: WorkspaceStore): Record<string, unknown> {
	const raw = workspace.readText("settings.json");
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function normalizeDisplayMode(value: unknown): LocalDisplayMode | undefined {
	const normalized = stringValue(value)?.toLowerCase();
	if (normalized === "desktop" || normalized === "terminal") return normalized;
	return undefined;
}

function normalizeProfileName(value: string | undefined): string {
	const raw = value?.trim().toLowerCase();
	if (!raw) return "";
	return raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function fallbackLocalAgentId(cloudAgentId: string | null, profileName: string): string {
	if (cloudAgentId) return cloudAgentId;
	if (profileName) return `local-${profileName}`;
	return "current";
}

export function readLocalTenantProfile(
	workspace: WorkspaceStore,
	env: Env = process.env,
): LocalTenantProfile {
	const settings = readSettings(workspace);
	const profileName = normalizeProfileName(
		env.TROUBLEMAKER_AGENT_PROFILE
			?? setting(settings, "localAgentProfile", "local_agent_profile")
			?? setting(settings, "agentProfile", "agent_profile"),
	);
	const cloudAgentId = stringValue(env.TROUBLEMAKER_CLOUD_AGENT_ID)
		?? setting(settings, "cloudAgentId", "cloud_agent_id")
		?? null;
	const tenantId = stringValue(env.TROUBLEMAKER_TENANT_ID)
		?? setting(settings, "tenantId", "tenant_id")
		?? null;
	const cloudBaseUrl = stringValue(env.TROUBLEMAKER_CLOUD_BASE_URL)
		?? setting(settings, "cloudBaseUrl", "cloud_base_url")
		?? null;
	const appOwned = booleanValue(env.TROUBLEMAKER_APP_OWNED_RUNTIME)
		?? booleanValue(settings.appOwnedRuntime)
		?? false;
	const profileActive = appOwned || !!profileName || !!cloudAgentId || !!tenantId;
	const displayMode = normalizeDisplayMode(env.TROUBLEMAKER_DISPLAY_MODE)
		?? normalizeDisplayMode(settings.display_mode)
		?? normalizeDisplayMode(settings.displayMode)
		?? (profileActive ? "desktop" : "terminal");
	const agentName = stringValue(env.TROUBLEMAKER_AGENT_NAME)
		?? setting(settings, "agentName", "agent_name")
		?? setting(settings, "name")
		?? (profileActive ? "Local Desktop Agent" : "agent");
	const localAgentId = stringValue(env.TROUBLEMAKER_LOCAL_AGENT_ID)
		?? setting(settings, "localAgentId", "local_agent_id")
		?? fallbackLocalAgentId(cloudAgentId, profileName);

	return {
		mode: profileActive ? "local-desktop" : "standalone",
		profileName,
		localAgentId,
		agentName,
		displayMode,
		cloudAgentId,
		tenantId,
		cloudBaseUrl,
		profileActive,
	};
}

export function genericContextConflict(
	profile: LocalTenantProfile,
	workspaceDir: string,
	port: number,
): GenericContextConflict {
	if (!profile.profileActive) return { conflict: false, reasons: [] };
	const reasons: string[] = [];
	if (port === 3002) {
		reasons.push("port_3002_is_reserved_for_generic_localhost_context");
	}
	const normalizedWorkspace = workspaceDir.replace(/\\/g, "/");
	if (/\/Library\/Application Support\/Troublemaker\/Workspace\/?$/.test(normalizedWorkspace)) {
		reasons.push("workspace_is_generic_troublemaker_workspace");
	}
	return { conflict: reasons.length > 0, reasons };
}
