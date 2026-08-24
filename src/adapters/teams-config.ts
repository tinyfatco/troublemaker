import { cloudFromName, type CloudEnvironment } from "@microsoft/teams.api";

const TEAMS_CONFIGURATION_KEYS = [
	"MOM_TEAMS_CLIENT_ID",
	"MOM_TEAMS_CLIENT_SECRET",
	"MOM_TEAMS_MANAGED_IDENTITY_CLIENT_ID",
	"MOM_TEAMS_TENANT_ID",
	"MOM_TEAMS_CLOUD",
	"MOM_TEAMS_SERVICE_URL",
	"MOM_TEAMS_ALLOWED_TENANTS",
	"MOM_TEAMS_ALLOWED_TEAMS",
	"MOM_TEAMS_ALLOWED_CONVERSATIONS",
	"MOM_TEAMS_ALLOWED_DM_USERS",
	"MOM_TEAMS_CHANNEL_MESSAGES_DIRECT",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TeamsEnvironmentConfiguration {
	clientId: string;
	clientSecret?: string;
	managedIdentityClientId?: "system" | (string & {});
	tenantId: string;
	cloud?: CloudEnvironment;
	serviceUrl?: string;
	allowedTenantIds?: string[];
	allowedTeamIds?: string[];
	allowedConversationIds?: string[];
	allowedDmUsers?: string[];
	directChannelMessages: boolean;
}

export type TeamsEnvironmentResult =
	| { enabled: false; reason: string }
	| { enabled: true; config: TeamsEnvironmentConfiguration };

export function hasTeamsEnvironment(env: NodeJS.ProcessEnv): boolean {
	return TEAMS_CONFIGURATION_KEYS.some((key) => env[key] !== undefined);
}

export function readTeamsEnvironment(env: NodeJS.ProcessEnv): TeamsEnvironmentResult {
	if (!hasTeamsEnvironment(env)) return { enabled: false, reason: "Microsoft Teams is not configured" };

	const clientId = env.MOM_TEAMS_CLIENT_ID?.trim();
	const clientSecret = env.MOM_TEAMS_CLIENT_SECRET?.trim();
	const managedIdentityClientId = env.MOM_TEAMS_MANAGED_IDENTITY_CLIENT_ID?.trim();
	const tenantId = env.MOM_TEAMS_TENANT_ID?.trim();
	if (!clientId || !UUID.test(clientId)) {
		return { enabled: false, reason: "MOM_TEAMS_CLIENT_ID must be a Microsoft application ID" };
	}
	if (!tenantId || !UUID.test(tenantId)) {
		return { enabled: false, reason: "MOM_TEAMS_TENANT_ID must be a Microsoft tenant ID" };
	}
	if (Boolean(clientSecret) === Boolean(managedIdentityClientId)) {
		return { enabled: false, reason: "Configure exactly one Teams client secret or managed identity" };
	}
	if (managedIdentityClientId && managedIdentityClientId !== "system" && !UUID.test(managedIdentityClientId)) {
		return { enabled: false, reason: "MOM_TEAMS_MANAGED_IDENTITY_CLIENT_ID must be system or an application ID" };
	}

	const cloudName = env.MOM_TEAMS_CLOUD?.trim();
	let cloud: CloudEnvironment | undefined;
	try {
		cloud = cloudName ? cloudFromName(cloudName) : undefined;
	} catch {
		return { enabled: false, reason: "MOM_TEAMS_CLOUD must be Public, USGov, USGovDoD, or China" };
	}
	if (cloudName && !cloud) {
		return { enabled: false, reason: "MOM_TEAMS_CLOUD must be Public, USGov, USGovDoD, or China" };
	}
	const direct = env.MOM_TEAMS_CHANNEL_MESSAGES_DIRECT?.trim();
	if (direct !== undefined && direct !== "true" && direct !== "false") {
		return { enabled: false, reason: "MOM_TEAMS_CHANNEL_MESSAGES_DIRECT must be true or false" };
	}
	const serviceUrl = env.MOM_TEAMS_SERVICE_URL?.trim();
	if (serviceUrl && !validHttpsUrl(serviceUrl)) {
		return { enabled: false, reason: "MOM_TEAMS_SERVICE_URL must be an HTTPS URL" };
	}
	const allowedDmUsers = readList(env.MOM_TEAMS_ALLOWED_DM_USERS);
	if (allowedDmUsers?.some((value) => !validPrincipalId(value))) {
		return { enabled: false, reason: "MOM_TEAMS_ALLOWED_DM_USERS accepts provider IDs only" };
	}

	return {
		enabled: true,
		config: {
			clientId,
			...(clientSecret ? { clientSecret } : {}),
			...(managedIdentityClientId ? { managedIdentityClientId: managedIdentityClientId as "system" | (string & {}) } : {}),
			tenantId,
			...(cloud ? { cloud } : {}),
			...(serviceUrl ? { serviceUrl } : {}),
			allowedTenantIds: readList(env.MOM_TEAMS_ALLOWED_TENANTS),
			allowedTeamIds: readList(env.MOM_TEAMS_ALLOWED_TEAMS),
			allowedConversationIds: readList(env.MOM_TEAMS_ALLOWED_CONVERSATIONS),
			allowedDmUsers,
			directChannelMessages: direct === "true",
		},
	};
}

function readList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function validHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

function validPrincipalId(value: string): boolean {
	return UUID.test(value) || /^\d{1,3}:[^\s,]{1,512}$/.test(value);
}
