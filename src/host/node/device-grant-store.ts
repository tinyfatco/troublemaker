import {
	createPublicKey,
	randomUUID,
	verify,
	type KeyObject,
} from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	DEVICE_GRANT_VERSION,
	canonicalDeviceEnrollment,
	canonicalDeviceRequest,
	isSafeDeviceIdentifier,
	normalizeDeviceGrantScopes,
	type CanonicalDeviceRequestInput,
	type DeviceGrantDescriptor,
	type DeviceGrantEnrollmentRequest,
	type DeviceGrantScope,
} from "../../console/device-grants.js";

interface StoredDeviceGrant extends DeviceGrantDescriptor {
	public_key: string;
	revoked_at?: string;
}

interface StoredNonce {
	grant_id: string;
	nonce: string;
	expires_at: string;
}

interface StoreDocument {
	version: 1;
	grants: StoredDeviceGrant[];
	nonces: StoredNonce[];
}

export interface DeviceGrantStoreOptions {
	now?: () => Date;
	grantLifetimeMs?: number;
	nonceLifetimeMs?: number;
	maximumGrants?: number;
	maximumNonces?: number;
}

export class DeviceGrantStore {
	private document: StoreDocument = { version: 1, grants: [], nonces: [] };
	private readonly now: () => Date;
	private readonly grantLifetimeMs: number;
	private readonly nonceLifetimeMs: number;
	private readonly maximumGrants: number;
	private readonly maximumNonces: number;

	constructor(
		private readonly path: string,
		options: DeviceGrantStoreOptions = {},
	) {
		if (!path.startsWith("/")) throw new Error("Device grant store path must be absolute");
		this.now = options.now ?? (() => new Date());
		this.grantLifetimeMs = options.grantLifetimeMs ?? 180 * 24 * 60 * 60 * 1_000;
		this.nonceLifetimeMs = options.nonceLifetimeMs ?? 5 * 60 * 1_000;
		this.maximumGrants = options.maximumGrants ?? 64;
		this.maximumNonces = options.maximumNonces ?? 2_048;
		this.load();
	}

	issue(routeAgentId: string, request: DeviceGrantEnrollmentRequest): DeviceGrantDescriptor {
		const scopes = validateEnrollment(routeAgentId, request);
		const publicKey = publicKeyFromX963(request.public_key);
		const canonical = canonicalDeviceEnrollment(routeAgentId, {
			version: request.version,
			binding_id: request.binding_id,
			subject_agent_id: request.subject_agent_id,
			public_key: request.public_key,
			nonce: request.nonce,
			scopes,
		});
		if (!verifySignature(publicKey, canonical, request.signature)) {
			throw new DeviceGrantStoreError(401, "invalid_enrollment_proof");
		}
		if (!this.claimEnrollmentNonce(request.nonce)) {
			throw new DeviceGrantStoreError(409, "enrollment_replay");
		}

		const now = this.now();
		const grant: StoredDeviceGrant = {
			version: DEVICE_GRANT_VERSION,
			grant_id: randomUUID(),
			binding_id: request.binding_id,
			route_agent_id: routeAgentId,
			subject_agent_id: request.subject_agent_id,
			scopes,
			created_at: now.toISOString(),
			expires_at: new Date(now.getTime() + this.grantLifetimeMs).toISOString(),
			public_key: request.public_key,
		};
		this.document.grants.push(grant);
		this.trim();
		this.persist();
		return descriptor(grant);
	}

	revoke(routeAgentId: string, grantId: string): boolean {
		const grant = this.document.grants.find((candidate) => candidate.grant_id === grantId);
		if (!grant || grant.route_agent_id !== routeAgentId || grant.revoked_at) return false;
		grant.revoked_at = this.now().toISOString();
		this.persist();
		return true;
	}

	getActive(grantId: string): StoredDeviceGrant | null {
		this.pruneExpiredNonces();
		const grant = this.document.grants.find((candidate) => candidate.grant_id === grantId);
		if (!grant || grant.revoked_at) return null;
		if (Date.parse(grant.expires_at) <= this.now().getTime()) return null;
		return grant;
	}

	verifyRequest(
		grantId: string,
		scope: DeviceGrantScope,
		routeAgentId: string,
		input: CanonicalDeviceRequestInput,
		signature: string,
	): DeviceGrantDescriptor {
		const grant = this.getActive(grantId);
		if (!grant) throw new DeviceGrantStoreError(401, "unknown_or_revoked_grant");
		if (grant.route_agent_id !== routeAgentId || grant.subject_agent_id !== input.subjectAgentId) {
			throw new DeviceGrantStoreError(403, "wrong_agent");
		}
		if (!grant.scopes.includes(scope)) throw new DeviceGrantStoreError(403, "scope_denied");

		const timestamp = Number.parseInt(input.timestamp, 10);
		const nowMs = this.now().getTime();
		if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs - timestamp * 1_000) > this.nonceLifetimeMs) {
			throw new DeviceGrantStoreError(401, "stale_request");
		}
		if (!isSafeNonce(input.nonce)) throw new DeviceGrantStoreError(401, "invalid_nonce");
		if (!verifySignature(publicKeyFromX963(grant.public_key), canonicalDeviceRequest(input), signature)) {
			throw new DeviceGrantStoreError(401, "invalid_signature");
		}
		if (!this.claimRequestNonce(grantId, input.nonce)) {
			throw new DeviceGrantStoreError(409, "request_replay");
		}
		return descriptor(grant);
	}

	private claimEnrollmentNonce(nonce: string): boolean {
		return this.claimRequestNonce("enrollment", nonce);
	}

	private claimRequestNonce(grantId: string, nonce: string): boolean {
		this.pruneExpiredNonces();
		if (this.document.nonces.some((entry) => entry.grant_id === grantId && entry.nonce === nonce)) return false;
		this.document.nonces.push({
			grant_id: grantId,
			nonce,
			expires_at: new Date(this.now().getTime() + this.nonceLifetimeMs).toISOString(),
		});
		this.trim();
		this.persist();
		return true;
	}

	private pruneExpiredNonces(): void {
		const now = this.now().getTime();
		this.document.nonces = this.document.nonces.filter((entry) => Date.parse(entry.expires_at) > now);
	}

	private trim(): void {
		this.pruneExpiredNonces();
		if (this.document.grants.length > this.maximumGrants) {
			const revoked = this.document.grants.filter((grant) => grant.revoked_at);
			const active = this.document.grants.filter((grant) => !grant.revoked_at);
			this.document.grants = [...revoked, ...active].slice(-this.maximumGrants);
		}
		if (this.document.nonces.length > this.maximumNonces) {
			this.document.nonces = this.document.nonces.slice(-this.maximumNonces);
		}
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		const stat = lstatSync(this.path);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Device grant store must be a regular file");
		if ((stat.mode & 0o077) !== 0) throw new Error("Device grant store must not be accessible by group or others");
		let parsed: StoreDocument;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoreDocument;
		} catch {
			throw new Error("Device grant store is unreadable");
		}
		if (!isStoreDocument(parsed)) throw new Error("Device grant store is unreadable");
		this.document = parsed;
		this.trim();
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.tmp-${process.pid}`;
		writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.path);
		chmodSync(this.path, 0o600);
	}
}

export class DeviceGrantStoreError extends Error {
	constructor(readonly status: number, readonly code: string) {
		super(code);
	}
}

function validateEnrollment(routeAgentId: string, request: DeviceGrantEnrollmentRequest): DeviceGrantScope[] {
	const scopes = normalizeDeviceGrantScopes(request.scopes);
	if (request.version !== DEVICE_GRANT_VERSION
		|| !isSafeDeviceIdentifier(routeAgentId)
		|| !isSafeDeviceIdentifier(request.binding_id)
		|| !isSafeDeviceIdentifier(request.subject_agent_id)
		|| !isSafeNonce(request.nonce)
		|| !scopes) {
		throw new DeviceGrantStoreError(400, "invalid_enrollment");
	}
	return scopes;
}

function descriptor(grant: StoredDeviceGrant): DeviceGrantDescriptor {
	return {
		version: grant.version,
		grant_id: grant.grant_id,
		binding_id: grant.binding_id,
		route_agent_id: grant.route_agent_id,
		subject_agent_id: grant.subject_agent_id,
		scopes: [...grant.scopes],
		created_at: grant.created_at,
		expires_at: grant.expires_at,
	};
}

function publicKeyFromX963(encoded: string): KeyObject {
	const raw = decodeBase64(encoded, 65);
	if (raw.length !== 65 || raw[0] !== 0x04) throw new DeviceGrantStoreError(400, "invalid_public_key");
	return createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: raw.subarray(1, 33).toString("base64url"),
			y: raw.subarray(33, 65).toString("base64url"),
		},
		format: "jwk",
	});
}

function verifySignature(key: KeyObject, canonical: string, encodedSignature: string): boolean {
	let signature: Buffer;
	try {
		signature = decodeBase64(encodedSignature, 256);
	} catch {
		return false;
	}
	return verify("sha256", Buffer.from(canonical, "utf8"), key, signature);
}

function decodeBase64(value: string, maximumBytes: number): Buffer {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > maximumBytes * 2) {
		throw new DeviceGrantStoreError(400, "invalid_base64");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.length === 0 || decoded.length > maximumBytes) throw new DeviceGrantStoreError(400, "invalid_base64");
	return decoded;
}

function isSafeNonce(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._:-]{16,128}$/.test(value);
}

function isStoreDocument(value: StoreDocument): boolean {
	if (value?.version !== 1 || !Array.isArray(value.grants) || !Array.isArray(value.nonces)) return false;
	const grantIds = new Set<string>();
	for (const grant of value.grants) {
		const scopes = normalizeDeviceGrantScopes(grant?.scopes);
		if (grant?.version !== DEVICE_GRANT_VERSION
			|| !isSafeDeviceIdentifier(grant.grant_id)
			|| grantIds.has(grant.grant_id)
			|| !isSafeDeviceIdentifier(grant.binding_id)
			|| !isSafeDeviceIdentifier(grant.route_agent_id)
			|| !isSafeDeviceIdentifier(grant.subject_agent_id)
			|| !scopes
			|| !isValidDate(grant.created_at)
			|| !isValidDate(grant.expires_at)
			|| (grant.revoked_at !== undefined && !isValidDate(grant.revoked_at))) return false;
		try {
			publicKeyFromX963(grant.public_key);
		} catch {
			return false;
		}
		grantIds.add(grant.grant_id);
	}
	const nonceKeys = new Set<string>();
	for (const nonce of value.nonces) {
		const key = `${nonce?.grant_id}\n${nonce?.nonce}`;
		if (!isSafeDeviceIdentifier(nonce?.grant_id)
			|| !isSafeNonce(nonce?.nonce)
			|| !isValidDate(nonce?.expires_at)
			|| nonceKeys.has(key)) return false;
		nonceKeys.add(key);
	}
	return true;
}

function isValidDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}
