import { createHash } from "node:crypto";

export const DEVICE_GRANT_VERSION = 1 as const;

export const DEVICE_GRANT_SCOPES = [
	"status",
	"events",
	"deliveries",
	"transcriptions",
	"voice_sessions",
	"voice_receipts",
	"messages",
	"stop",
] as const;

export type DeviceGrantScope = typeof DEVICE_GRANT_SCOPES[number];

export type DeviceGrantSurface = "mac" | "iphone" | "watch" | "unspecified";

export interface DeviceGrantEnrollmentRequest {
	version: typeof DEVICE_GRANT_VERSION;
	binding_id: string;
	surface?: Exclude<DeviceGrantSurface, "unspecified">;
	subject_agent_id: string;
	public_key: string;
	nonce: string;
	signature: string;
	scopes: DeviceGrantScope[];
}

export interface DeviceGrantDescriptor {
	version: typeof DEVICE_GRANT_VERSION;
	grant_id: string;
	binding_id: string;
	surface: DeviceGrantSurface;
	route_agent_id: string;
	subject_agent_id: string;
	scopes: DeviceGrantScope[];
	created_at: string;
	expires_at: string;
}

export interface CanonicalDeviceRequestInput {
	method: string;
	pathAndQuery: string;
	timestamp: string;
	nonce: string;
	contentType: string;
	bodyDigest: string;
	subjectAgentId: string;
}

export function canonicalDeviceEnrollment(
	routeAgentId: string,
	request: Omit<DeviceGrantEnrollmentRequest, "signature">,
): string {
	return [
		"troublemaker-device-enrollment-v1",
		routeAgentId,
		request.subject_agent_id,
		request.binding_id,
		request.nonce,
		request.public_key,
		[...request.scopes].sort().join(","),
		...(request.surface ? [request.surface] : []),
	].join("\n");
}

export function canonicalDeviceRequest(input: CanonicalDeviceRequestInput): string {
	return [
		"troublemaker-device-request-v1",
		input.method.toUpperCase(),
		input.pathAndQuery,
		input.timestamp,
		input.nonce,
		input.contentType.trim().toLowerCase(),
		input.bodyDigest.toLowerCase(),
		input.subjectAgentId,
	].join("\n");
}

export function deviceRequestScope(method: string, pathname: string): DeviceGrantScope | null {
	const normalizedMethod = method.toUpperCase();
	if (!/^\/api\/v2\/agents\/[^/]+\/.+$/.test(pathname)) return null;
	const agentRoute = "^/api/v2/agents/[^/]+";
	if (normalizedMethod === "GET" && new RegExp(`${agentRoute}/status$`).test(pathname)) return "status";
	if (normalizedMethod === "GET" && new RegExp(`${agentRoute}/events$`).test(pathname)) return "events";
	if (normalizedMethod === "GET" && new RegExp(`${agentRoute}/live$`).test(pathname)) return "events";
	if (normalizedMethod === "GET" && new RegExp(`${agentRoute}/deliveries$`).test(pathname)) return "deliveries";
	if (normalizedMethod === "POST" && new RegExp(`${agentRoute}/transcriptions$`).test(pathname)) return "transcriptions";
	if (normalizedMethod === "POST"
		&& /^\/api\/v2\/agents\/[^/]+\/voice-sessions$/.test(pathname)) return "voice_sessions";
	if (normalizedMethod === "GET"
		&& /^\/api\/v2\/agents\/[^/]+\/voice-sessions\/[^/]+\/events$/.test(pathname)) return "voice_sessions";
	if (normalizedMethod === "POST"
		&& /^\/api\/v2\/agents\/[^/]+\/voice-sessions\/[^/]+\/(?:events|recording|speech-controls|reconcile)$/.test(pathname)) return "voice_sessions";
	if (normalizedMethod === "GET" && /^\/api\/v2\/agents\/[^/]+\/voice-receipts$/.test(pathname)) return "voice_receipts";
	if (normalizedMethod === "POST" && new RegExp(`${agentRoute}/messages/stop$`).test(pathname)) return "stop";
	if (normalizedMethod === "POST" && new RegExp(`${agentRoute}/messages$`).test(pathname)) return "messages";
	return null;
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function isSafeDeviceIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function isDeviceGrantScope(value: unknown): value is DeviceGrantScope {
	return typeof value === "string" && (DEVICE_GRANT_SCOPES as readonly string[]).includes(value);
}

export function normalizeDeviceGrantScopes(value: unknown): DeviceGrantScope[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > DEVICE_GRANT_SCOPES.length) return null;
	if (!value.every(isDeviceGrantScope)) return null;
	return [...new Set(value)].sort();
}
