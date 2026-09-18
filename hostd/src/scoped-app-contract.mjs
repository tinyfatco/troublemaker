import { createHash } from "node:crypto";

export const SCOPED_APP_PROTOCOL = "vectors.v1";
export const SCOPED_APP_MAXIMUM_BODY_BYTES = 128 * 1024;
export const SCOPED_APP_MAXIMUM_CONTEXT_BYTES = 64 * 1024;
export const SCOPED_APP_MAXIMUM_ARTIFACT_BYTES = 2 * 1024 * 1024;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ROLES = new Set(["owner", "admin", "member"]);
const OPERATIONS = new Set([
	"capabilities",
	"chat.send",
	"chat.events",
	"chat.cancel",
	"context.read",
	"context.write",
	"scope.revoke",
	"evidence.capture",
	"evidence.read",
	"artifact.read",
]);

export class ScopedAppContractError extends Error {
	constructor(message = "invalid scoped app request") {
		super(message);
		this.name = "ScopedAppContractError";
		this.status = 400;
		this.code = "invalid";
	}
}

function reject() {
	throw new ScopedAppContractError();
}

function exactObject(value, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) reject();
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject();
	return value;
}

function opaqueId(value) {
	if (typeof value !== "string" || !OPAQUE_ID.test(value)) reject();
	return value;
}

function uuid(value) {
	if (typeof value !== "string" || !UUID.test(value)) reject();
	return value.toLowerCase();
}

function integer(value, { minimum = 0 } = {}) {
	if (!Number.isSafeInteger(value) || value < minimum) reject();
	return value;
}

function boundedText(value, maximumCharacters, { minimumCharacters = 0, maximumBytes } = {}) {
	if (
		typeof value !== "string"
		|| value.length < minimumCharacters
		|| value.length > maximumCharacters
		|| (maximumBytes !== undefined && Buffer.byteLength(value, "utf8") > maximumBytes)
	) reject();
	return value;
}

function isoUtc(value) {
	if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) reject();
	return value;
}

export function validateScopedAppScope(value, { now = Date.now(), requireFresh = true } = {}) {
	const scope = exactObject(value, [
		"leaseId",
		"accountId",
		"userId",
		"membershipId",
		"membershipVersion",
		"role",
		"authorizedAt",
		"expiresAt",
	]);
	const normalized = {
		leaseId: uuid(scope.leaseId),
		accountId: opaqueId(scope.accountId),
		userId: opaqueId(scope.userId),
		membershipId: opaqueId(scope.membershipId),
		membershipVersion: integer(scope.membershipVersion, { minimum: 1 }),
		role: ROLES.has(scope.role) ? scope.role : reject(),
		authorizedAt: isoUtc(scope.authorizedAt),
		expiresAt: isoUtc(scope.expiresAt),
	};
	const authorizedAt = Date.parse(normalized.authorizedAt);
	const expiresAt = Date.parse(normalized.expiresAt);
	if (
		expiresAt <= authorizedAt
		|| expiresAt - authorizedAt > 30_000
		|| (requireFresh && (authorizedAt > now + 1_000 || expiresAt <= now))
	) reject();
	return normalized;
}

function validatePayload(operation, value) {
	switch (operation) {
		case "capabilities":
		case "context.read":
			return exactObject(value, []);
		case "chat.send": {
			const payload = exactObject(value, ["turnId", "text"]);
			return {
				turnId: uuid(payload.turnId),
				text: boundedText(payload.text, 16_000, { minimumCharacters: 1 }),
			};
		}
		case "chat.events": {
			const payload = exactObject(value, ["after"]);
			return { after: integer(payload.after) };
		}
		case "chat.cancel": {
			const payload = exactObject(value, ["turnId"]);
			return { turnId: uuid(payload.turnId) };
		}
		case "context.write": {
			const payload = exactObject(value, ["markdown", "expectedRevision", "reviewed"]);
			if (payload.reviewed !== true) reject();
			return {
				markdown: boundedText(payload.markdown, SCOPED_APP_MAXIMUM_CONTEXT_BYTES, {
					maximumBytes: SCOPED_APP_MAXIMUM_CONTEXT_BYTES,
				}),
				expectedRevision: integer(payload.expectedRevision),
				reviewed: true,
			};
		}
		case "scope.revoke": {
			const payload = exactObject(value, ["membershipId", "membershipVersion"]);
			return {
				membershipId: opaqueId(payload.membershipId),
				membershipVersion: integer(payload.membershipVersion, { minimum: 1 }),
			};
		}
		case "evidence.capture": {
			const payload = exactObject(value, ["turnId", "grantId", "sourceUrl", "field", "exactQuote"]);
			if (typeof payload.sourceUrl !== "string") reject();
			let sourceUrl;
			try {
				sourceUrl = new URL(payload.sourceUrl).toString();
			} catch {
				reject();
			}
			return {
				turnId: uuid(payload.turnId),
				grantId: opaqueId(payload.grantId),
				sourceUrl,
				field: boundedText(payload.field, 128, { minimumCharacters: 1 }),
				exactQuote: boundedText(payload.exactQuote, 4_000, { minimumCharacters: 1 }),
			};
		}
		case "evidence.read":
		case "artifact.read": {
			const payload = exactObject(value, ["artifactId"]);
			return { artifactId: opaqueId(payload.artifactId) };
		}
		default:
			reject();
	}
}

export function validateScopedAppEnvelope(value, options = {}) {
	const envelope = exactObject(value, ["version", "requestId", "scope", "operation", "payload"]);
	if (envelope.version !== SCOPED_APP_PROTOCOL || !OPERATIONS.has(envelope.operation)) reject();
	return {
		version: SCOPED_APP_PROTOCOL,
		requestId: uuid(envelope.requestId),
		scope: validateScopedAppScope(envelope.scope, options),
		operation: envelope.operation,
		payload: validatePayload(envelope.operation, envelope.payload),
	};
}

export function validateScopedAppRenewal(value, options = {}) {
	const renewal = exactObject(value, ["version", "scope"]);
	if (renewal.version !== SCOPED_APP_PROTOCOL) reject();
	return {
		version: SCOPED_APP_PROTOCOL,
		scope: validateScopedAppScope(renewal.scope, options),
	};
}

export function scopedAppContextDocument(markdown, revision) {
	boundedText(markdown, SCOPED_APP_MAXIMUM_CONTEXT_BYTES, {
		maximumBytes: SCOPED_APP_MAXIMUM_CONTEXT_BYTES,
	});
	integer(revision);
	return {
		markdown,
		revision,
		sha256: createHash("sha256").update(markdown, "utf8").digest("hex"),
	};
}

export function validateScopedAppContextDocument(value) {
	const document = exactObject(value, ["markdown", "revision", "sha256"]);
	const normalized = scopedAppContextDocument(document.markdown, document.revision);
	if (typeof document.sha256 !== "string" || !SHA256.test(document.sha256) || document.sha256 !== normalized.sha256) {
		reject();
	}
	return normalized;
}
