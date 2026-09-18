import { validateScopedAppScope } from "./scoped-app-contract.mjs";

export const SCOPED_WEBCHAT_PROTOCOL = "vectors.webchat.v1";
export const SCOPED_WEBCHAT_ACTIONS = Object.freeze([
	"bootstrap",
	"status",
	"events",
	"events-stream",
	"live",
	"messages",
	"messages-stop",
]);
export const SCOPED_WEBCHAT_MAXIMUM_BODY_BYTES = 128 * 1024;

const ACTIONS = new Set(SCOPED_WEBCHAT_ACTIONS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPTIONAL_MESSAGE_KEYS = new Set([
	"message",
	"source",
	"sourceEventType",
	"channelId",
	"fresh_context",
	"session_id",
]);

export class ScopedWebchatContractError extends Error {
	constructor(message = "invalid scoped webchat request") {
		super(message);
		this.name = "ScopedWebchatContractError";
		this.status = 400;
		this.code = "invalid";
	}
}

function reject() {
	throw new ScopedWebchatContractError();
}

function exactObject(value, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) reject();
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject();
	return value;
}

function uuid(value) {
	if (typeof value !== "string" || !UUID.test(value)) reject();
	return value.toLowerCase();
}

function optionalInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) reject();
	return value;
}

function optionalText(value, maximumCharacters) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > maximumCharacters) reject();
	return value;
}

function emptyPayload(value) {
	return exactObject(value, []);
}

function eventsPayload(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) reject();
	if (Object.keys(value).some((key) => !["limit", "before"].includes(key))) reject();
	const limit = optionalInteger(value.limit, { minimum: 1, maximum: 100 }) ?? 50;
	const before = optionalInteger(value.before);
	return { limit, ...(before === undefined ? {} : { before }) };
}

function livePayload(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) reject();
	if (Object.keys(value).some((key) => key !== "after")) reject();
	const after = optionalInteger(value.after);
	return after === undefined ? {} : { after };
}

function messagePayload(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) reject();
	if (Object.keys(value).some((key) => !OPTIONAL_MESSAGE_KEYS.has(key))) reject();
	if (typeof value.message !== "string") reject();
	const message = value.message.trim();
	if (!message || message.length > 16_000 || Buffer.byteLength(message, "utf8") > 64 * 1024) reject();
	const source = optionalText(value.source, 128);
	const sourceEventType = optionalText(value.sourceEventType, 128);
	const channelId = optionalText(value.channelId, 256);
	const sessionId = optionalText(value.session_id, 256);
	if (value.fresh_context !== undefined && typeof value.fresh_context !== "boolean") reject();
	return {
		message,
		...(source === undefined ? {} : { source }),
		...(sourceEventType === undefined ? {} : { sourceEventType }),
		...(channelId === undefined ? {} : { channelId }),
		...(value.fresh_context === undefined ? {} : { fresh_context: value.fresh_context }),
		...(sessionId === undefined ? {} : { session_id: sessionId }),
	};
}

function payload(action, value) {
	switch (action) {
		case "bootstrap":
		case "status":
		case "events-stream":
		case "messages-stop":
			return emptyPayload(value);
		case "events":
			return eventsPayload(value);
		case "live":
			return livePayload(value);
		case "messages":
			return messagePayload(value);
		default:
			reject();
	}
}

export function validateScopedWebchatEnvelope(value, action, options = {}) {
	if (!ACTIONS.has(action)) reject();
	const bootstrap = action === "bootstrap";
	const envelope = exactObject(value, bootstrap
		? ["version", "requestId", "scope"]
		: ["version", "requestId", "scope", "agentId", "payload"]);
	if (envelope.version !== SCOPED_WEBCHAT_PROTOCOL) reject();
	let scope;
	try {
		scope = validateScopedAppScope(envelope.scope, options);
	} catch {
		reject();
	}
	return {
		version: SCOPED_WEBCHAT_PROTOCOL,
		requestId: uuid(envelope.requestId),
		scope,
		...(bootstrap ? {} : {
			agentId: uuid(envelope.agentId),
			payload: payload(action, envelope.payload),
		}),
	};
}
