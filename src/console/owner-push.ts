import { createHash } from "node:crypto";

export const OWNER_PUSH_VERSION = 1 as const;
export const OWNER_PUSH_CAPABILITY = "owner_push_v1" as const;
export const OWNER_PUSH_CONTEXT_KINDS = ["conversation", "task", "relationship"] as const;
export const OWNER_PUSH_CATEGORY = "COMPUTER_OWNER_UPDATE_V1" as const;

export type OwnerPushContextKind = typeof OWNER_PUSH_CONTEXT_KINDS[number];
export type OwnerPushEnvironment = "sandbox" | "production";
export type OwnerPushReadState = "unread" | "read" | "opened";
export type OwnerPushAcknowledgmentState = Exclude<OwnerPushReadState, "unread">;
export type OwnerPushAuthoritativeEventKind = "completion" | "action";

export interface OwnerPushContext {
	kind: OwnerPushContextKind;
	context_id: string;
	relationship_id: string;
	anchor_id?: string;
}

export interface OwnerPushDeviceRegistration {
	version: typeof OWNER_PUSH_VERSION;
	installation_id: string;
	binding_id: string;
	route_agent_id: string;
	subject_agent_id: string;
	device_token: string;
	environment: OwnerPushEnvironment;
	supported_contexts: OwnerPushContextKind[];
}

export interface OwnerPushEnvelope {
	version: typeof OWNER_PUSH_VERSION;
	notification_id: string;
	binding_id: string;
	route_agent_id: string;
	subject_agent_id: string;
	event_id: string;
	context: OwnerPushContext;
}

/**
 * Content-free event accepted only from a separately authenticated server
 * producer after the completion or action has become authoritative.
 */
export interface OwnerPushAuthoritativeEvent {
	version: typeof OWNER_PUSH_VERSION;
	kind: OwnerPushAuthoritativeEventKind;
	envelope: OwnerPushEnvelope;
}

/** A monotonic state reconciliation from one exact registered installation. */
export interface OwnerPushAcknowledgment {
	version: typeof OWNER_PUSH_VERSION;
	notification_id: string;
	installation_id: string;
	binding_id: string;
	state: OwnerPushAcknowledgmentState;
}

export interface OwnerPushAPNSPayload {
	aps: {
		alert: { title: "Computer"; body: "New private update" };
		category: typeof OWNER_PUSH_CATEGORY;
		"thread-id": string;
	};
	computer_owner_push: OwnerPushEnvelope;
}

export interface OwnerPushTransportRequest {
	deviceToken: string;
	environment: OwnerPushEnvironment;
	collapseId: string;
	payload: OwnerPushAPNSPayload;
}

export interface OwnerPushTransportResult {
	accepted: boolean;
	permanentTokenFailure?: boolean;
	status?: number;
	reason?: string;
}

export interface OwnerPushTransport {
	send(request: OwnerPushTransportRequest): Promise<OwnerPushTransportResult>;
}

export interface OwnerPushContextAuthorization {
	routeAgentId: string;
	subjectAgentId: string;
	bindingId: string;
	context: OwnerPushContext;
}

export type OwnerPushContextVerifier = (
	authorization: OwnerPushContextAuthorization,
) => boolean | Promise<boolean>;

export function isSafeOwnerPushIdentifier(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function parseOwnerPushContext(value: unknown): OwnerPushContext | null {
	if (!isRecord(value)) return null;
	const keys = Object.keys(value).sort();
	const allowed = ["anchor_id", "context_id", "kind", "relationship_id"];
	if (keys.some((key) => !allowed.includes(key))) return null;
	if (!isOwnerPushContextKind(value.kind)
		|| !isSafeOwnerPushIdentifier(value.context_id)
		|| !isSafeOwnerPushIdentifier(value.relationship_id)
		|| (value.anchor_id !== undefined && !isSafeOwnerPushIdentifier(value.anchor_id))) return null;
	return {
		kind: value.kind,
		context_id: value.context_id,
		relationship_id: value.relationship_id,
		...(value.anchor_id ? { anchor_id: value.anchor_id } : {}),
	};
}

export function parseOwnerPushRegistration(value: unknown): OwnerPushDeviceRegistration | null {
	if (!isRecord(value)) return null;
	const allowed = new Set([
		"version", "installation_id", "binding_id", "route_agent_id", "subject_agent_id",
		"device_token", "environment", "supported_contexts",
	]);
	if (Object.keys(value).some((key) => !allowed.has(key))
		|| value.version !== OWNER_PUSH_VERSION
		|| !isSafeOwnerPushIdentifier(value.installation_id)
		|| !isSafeOwnerPushIdentifier(value.binding_id)
		|| !isSafeOwnerPushIdentifier(value.route_agent_id)
		|| !isSafeOwnerPushIdentifier(value.subject_agent_id)
		|| !isOwnerPushDeviceToken(value.device_token)
		|| (value.environment !== "sandbox" && value.environment !== "production")
		|| !isCompleteContextSet(value.supported_contexts)) return null;
	return {
		version: OWNER_PUSH_VERSION,
		installation_id: value.installation_id,
		binding_id: value.binding_id,
		route_agent_id: value.route_agent_id,
		subject_agent_id: value.subject_agent_id,
		device_token: value.device_token,
		environment: value.environment,
		supported_contexts: [...OWNER_PUSH_CONTEXT_KINDS],
	};
}

export function parseOwnerPushEnvelope(value: unknown): OwnerPushEnvelope | null {
	if (!isRecord(value)) return null;
	const allowed = new Set([
		"version", "notification_id", "binding_id", "route_agent_id", "subject_agent_id",
		"event_id", "context",
	]);
	const context = parseOwnerPushContext(value.context);
	if (Object.keys(value).some((key) => !allowed.has(key))
		|| value.version !== OWNER_PUSH_VERSION
		|| !isSafeOwnerPushIdentifier(value.notification_id)
		|| !isSafeOwnerPushIdentifier(value.binding_id)
		|| !isSafeOwnerPushIdentifier(value.route_agent_id)
		|| !isSafeOwnerPushIdentifier(value.subject_agent_id)
		|| !isSafeOwnerPushIdentifier(value.event_id)
		|| !context
		|| value.binding_id !== context.relationship_id) return null;
	return {
		version: OWNER_PUSH_VERSION,
		notification_id: value.notification_id,
		binding_id: value.binding_id,
		route_agent_id: value.route_agent_id,
		subject_agent_id: value.subject_agent_id,
		event_id: value.event_id,
		context,
	};
}

export function parseOwnerPushAuthoritativeEvent(value: unknown): OwnerPushAuthoritativeEvent | null {
	if (!isRecord(value)) return null;
	const keys = Object.keys(value).sort();
	const envelope = parseOwnerPushEnvelope(value.envelope);
	if (keys.join(",") !== "envelope,kind,version"
		|| value.version !== OWNER_PUSH_VERSION
		|| (value.kind !== "completion" && value.kind !== "action")
		|| !envelope) return null;
	return { version: OWNER_PUSH_VERSION, kind: value.kind, envelope };
}

export function parseOwnerPushAcknowledgment(value: unknown): OwnerPushAcknowledgment | null {
	if (!isRecord(value)) return null;
	const keys = Object.keys(value).sort();
	if (keys.join(",") !== "binding_id,installation_id,notification_id,state,version"
		|| value.version !== OWNER_PUSH_VERSION
		|| !isSafeOwnerPushIdentifier(value.notification_id)
		|| !isSafeOwnerPushIdentifier(value.installation_id)
		|| !isSafeOwnerPushIdentifier(value.binding_id)
		|| (value.state !== "read" && value.state !== "opened")) return null;
	return {
		version: OWNER_PUSH_VERSION,
		notification_id: value.notification_id,
		installation_id: value.installation_id,
		binding_id: value.binding_id,
		state: value.state,
	};
}

export function ownerPushRouteFingerprint(envelope: OwnerPushEnvelope): string {
	return [
		envelope.version,
		envelope.notification_id,
		envelope.binding_id,
		envelope.route_agent_id,
		envelope.subject_agent_id,
		envelope.event_id,
		envelope.context.kind,
		envelope.context.context_id,
		envelope.context.relationship_id,
		envelope.context.anchor_id ?? "",
	].join("|");
}

export function ownerPushRegistrationKey(registration: Pick<
	OwnerPushDeviceRegistration,
	"installation_id" | "binding_id" | "route_agent_id" | "subject_agent_id"
>): string {
	return createHash("sha256").update([
		registration.installation_id,
		registration.binding_id,
		registration.route_agent_id,
		registration.subject_agent_id,
	].join("|")).digest("hex");
}

export function ownerPushAPNSPayload(envelopeValue: OwnerPushEnvelope): OwnerPushAPNSPayload {
	const envelope = parseOwnerPushEnvelope(envelopeValue);
	if (!envelope) throw new Error("invalid_owner_push_envelope");
	return {
		aps: {
			alert: { title: "Computer", body: "New private update" },
			category: OWNER_PUSH_CATEGORY,
			"thread-id": envelope.binding_id,
		},
		computer_owner_push: envelope,
	};
}

export function ownerPushPayloadDigest(payload: OwnerPushAPNSPayload): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isOwnerPushContextKind(value: unknown): value is OwnerPushContextKind {
	return typeof value === "string" && (OWNER_PUSH_CONTEXT_KINDS as readonly string[]).includes(value);
}

function isOwnerPushDeviceToken(value: unknown): value is string {
	return typeof value === "string"
		&& value.length >= 32
		&& value.length <= 256
		&& /^[a-f0-9]+$/.test(value);
}

function isCompleteContextSet(value: unknown): value is OwnerPushContextKind[] {
	if (!Array.isArray(value) || value.length !== OWNER_PUSH_CONTEXT_KINDS.length) return false;
	if (!value.every(isOwnerPushContextKind)) return false;
	return new Set(value).size === OWNER_PUSH_CONTEXT_KINDS.length;
}

function isRecord(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
