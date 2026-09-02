import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { VOICE_LIMITS } from "./voice-session-contract.js";

export const VOICE_RECEIPT_VERSION = "troublemaker.voice-receipt.v1" as const;
export const VOICE_RECEIPT_AUTHORITY_VERSION = "troublemaker.voice-receipt-authority.v1" as const;
export const VOICE_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAXIMUM_VOICE_RECEIPTS_PER_SESSION = 128;
const VOICE_RECEIPT_AUTHORITY_KEY_BYTES = 32;

export interface VoiceReceiptClaim {
	agent_correlation: string;
	request_correlation: string;
}

export interface StoredVoiceReceipt {
	version: typeof VOICE_RECEIPT_VERSION;
	kind: "event_applied";
	agent_correlation: string;
	session_correlation: string;
	request_correlation: string;
	client_sequence: number;
	server_sequence: number;
	recorded_at: string;
	expires_at: string;
	receipt_digest: string;
}

export interface VoiceReceiptEvidence {
	version: typeof VOICE_RECEIPT_VERSION;
	kind: "event_applied";
	session_correlation: string;
	request_correlation: string;
	client_sequence: number;
	server_sequence: number;
	receipt_digest: string;
}

export interface VoiceReceiptLookup {
	session_correlation: string;
	request_correlation: string;
	client_sequence: number;
}

export interface VoiceReceiptAuthorityInput {
	method: "GET" | "POST";
	path_and_query: string;
	body_digest: string;
	agent_correlation: string;
	request_correlation: string;
}

export function parseVoiceReceiptAuthorityKey(value: string | undefined): Uint8Array | undefined {
	const encoded = value?.trim();
	if (!encoded) return undefined;
	if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("Invalid voice receipt authority key");
	const key = Buffer.from(encoded, "base64url");
	if (key.byteLength !== VOICE_RECEIPT_AUTHORITY_KEY_BYTES
		|| key.toString("base64url") !== encoded) {
		throw new Error("Invalid voice receipt authority key");
	}
	return new Uint8Array(key);
}

export function isVoiceReceiptAuthorityKey(value: unknown): value is Uint8Array {
	return value instanceof Uint8Array && value.byteLength === VOICE_RECEIPT_AUTHORITY_KEY_BYTES;
}

export function voiceReceiptBodyDigest(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function voiceReceiptAuthorityProof(
	key: Uint8Array,
	input: VoiceReceiptAuthorityInput,
): string {
	if (!isVoiceReceiptAuthorityKey(key) || !isVoiceReceiptAuthorityInput(input)) {
		throw new Error("Invalid voice receipt authority");
	}
	const digest = createHmac("sha256", key).update([
		VOICE_RECEIPT_AUTHORITY_VERSION,
		input.method,
		input.path_and_query,
		input.body_digest,
		input.agent_correlation,
		input.request_correlation,
	].join("\n"), "utf8").digest("hex");
	return `hmac-sha256:${digest}`;
}

export function verifyVoiceReceiptAuthorityProof(
	key: Uint8Array,
	input: VoiceReceiptAuthorityInput,
	proof: unknown,
): boolean {
	if (typeof proof !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(proof)) return false;
	let expected: string;
	try { expected = voiceReceiptAuthorityProof(key, input); }
	catch { return false; }
	return timingSafeEqual(Buffer.from(proof, "ascii"), Buffer.from(expected, "ascii"));
}

export function voiceReceiptCorrelation(value: string): string {
	return `sha256:${sha256(value).slice(0, 24)}`;
}

export function voiceReceiptAgentCorrelation(routeAgentID: string, subjectAgentID: string): string {
	return `sha256:${sha256([
		"troublemaker.voice-receipt-agent.v1",
		routeAgentID,
		subjectAgentID,
	].join("\n"))}`;
}

export function createStoredVoiceReceipt(input: {
	claim: VoiceReceiptClaim;
	sessionID: string;
	clientSequence: number;
	serverSequence: number;
	recordedAt: Date;
	retentionMs?: number;
}): StoredVoiceReceipt {
	const retentionMs = input.retentionMs ?? VOICE_RECEIPT_RETENTION_MS;
	if (!isVoiceReceiptClaim(input.claim)
		|| !boundedInt(input.clientSequence, 1, VOICE_LIMITS.clientEvents)
		|| !boundedInt(input.serverSequence, 1, VOICE_LIMITS.serverEvents)
		|| !Number.isFinite(input.recordedAt.getTime())
		|| !Number.isSafeInteger(retentionMs) || retentionMs < 1) {
		throw new Error("Invalid voice receipt");
	}
	const recordedAt = input.recordedAt.toISOString();
	const expiresAt = new Date(input.recordedAt.getTime() + retentionMs).toISOString();
	const sessionCorrelation = voiceReceiptCorrelation(input.sessionID);
	const fields = [
		VOICE_RECEIPT_VERSION,
		"event_applied",
		input.claim.agent_correlation,
		sessionCorrelation,
		input.claim.request_correlation,
		String(input.clientSequence),
		String(input.serverSequence),
		recordedAt,
		expiresAt,
	];
	return {
		version: VOICE_RECEIPT_VERSION,
		kind: "event_applied",
		agent_correlation: input.claim.agent_correlation,
		session_correlation: sessionCorrelation,
		request_correlation: input.claim.request_correlation,
		client_sequence: input.clientSequence,
		server_sequence: input.serverSequence,
		recorded_at: recordedAt,
		expires_at: expiresAt,
		receipt_digest: sha256(fields.join("\n")),
	};
}

export function isVoiceReceiptClaim(value: unknown): value is VoiceReceiptClaim {
	return isExactRecord(value, ["agent_correlation", "request_correlation"])
		&& isAgentCorrelation(value.agent_correlation)
		&& isBoundedCorrelation(value.request_correlation);
}

export function isVoiceReceiptAuthorityInput(value: unknown): value is VoiceReceiptAuthorityInput {
	return isExactRecord(value, [
		"agent_correlation", "body_digest", "method", "path_and_query", "request_correlation",
	])
		&& ["GET", "POST"].includes(String(value.method))
		&& typeof value.path_and_query === "string"
		&& value.path_and_query.startsWith("/")
		&& value.path_and_query.length <= 4_096
		&& !/[\r\n]/.test(value.path_and_query)
		&& isDigest(value.body_digest)
		&& isAgentCorrelation(value.agent_correlation)
		&& isBoundedCorrelation(value.request_correlation);
}

export function isVoiceReceiptLookup(value: unknown): value is VoiceReceiptLookup {
	return isExactRecord(value, ["client_sequence", "request_correlation", "session_correlation"])
		&& isBoundedCorrelation(value.session_correlation)
		&& isBoundedCorrelation(value.request_correlation)
		&& boundedInt(value.client_sequence, 1, VOICE_LIMITS.clientEvents);
}

export function isStoredVoiceReceipt(value: unknown): value is StoredVoiceReceipt {
	if (!isExactRecord(value, [
		"agent_correlation", "client_sequence", "expires_at", "kind", "receipt_digest",
		"recorded_at", "request_correlation", "server_sequence", "session_correlation", "version",
	])
		|| value.version !== VOICE_RECEIPT_VERSION
		|| value.kind !== "event_applied"
		|| !isAgentCorrelation(value.agent_correlation)
		|| !isBoundedCorrelation(value.session_correlation)
		|| !isBoundedCorrelation(value.request_correlation)
		|| !boundedInt(value.client_sequence, 1, VOICE_LIMITS.clientEvents)
		|| !boundedInt(value.server_sequence, 1, VOICE_LIMITS.serverEvents)
		|| !isTimestamp(value.recorded_at)
		|| !isTimestamp(value.expires_at)
		|| Date.parse(value.expires_at) <= Date.parse(value.recorded_at)
		|| !isDigest(value.receipt_digest)) return false;
	const fields = [
		value.version,
		value.kind,
		value.agent_correlation,
		value.session_correlation,
		value.request_correlation,
		String(value.client_sequence),
		String(value.server_sequence),
		value.recorded_at,
		value.expires_at,
	];
	return value.receipt_digest === sha256(fields.join("\n"));
}

export function publicVoiceReceipt(receipt: StoredVoiceReceipt): VoiceReceiptEvidence {
	if (!isStoredVoiceReceipt(receipt)) throw new Error("Invalid voice receipt");
	return {
		version: receipt.version,
		kind: receipt.kind,
		session_correlation: receipt.session_correlation,
		request_correlation: receipt.request_correlation,
		client_sequence: receipt.client_sequence,
		server_sequence: receipt.server_sequence,
		receipt_digest: receipt.receipt_digest,
	};
}

export function pruneVoiceReceipts(
	receipts: StoredVoiceReceipt[],
	now: Date,
	maximum = MAXIMUM_VOICE_RECEIPTS_PER_SESSION,
): StoredVoiceReceipt[] {
	if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(maximum) || maximum < 1) {
		throw new Error("Invalid voice receipt retention bounds");
	}
	const accepted: StoredVoiceReceipt[] = [];
	for (const receipt of receipts) {
		if (!isStoredVoiceReceipt(receipt) || Date.parse(receipt.expires_at) <= now.getTime()) continue;
		const existing = accepted.find((candidate) => sameReceiptKey(candidate, receipt));
		if (existing) {
			if (existing.receipt_digest !== receipt.receipt_digest) throw new Error("Conflicting voice receipt");
			continue;
		}
		accepted.push(receipt);
	}
	return accepted.slice(-maximum);
}

export function sameVoiceReceiptKey(
	receipt: StoredVoiceReceipt,
	query: VoiceReceiptLookup,
	agentCorrelation: string,
): boolean {
	return isStoredVoiceReceipt(receipt)
		&& isVoiceReceiptLookup(query)
		&& isAgentCorrelation(agentCorrelation)
		&& receipt.agent_correlation === agentCorrelation
		&& receipt.session_correlation === query.session_correlation
		&& receipt.request_correlation === query.request_correlation
		&& receipt.client_sequence === query.client_sequence;
}

function sameReceiptKey(left: StoredVoiceReceipt, right: StoredVoiceReceipt): boolean {
	return left.agent_correlation === right.agent_correlation
		&& left.session_correlation === right.session_correlation
		&& left.request_correlation === right.request_correlation
		&& left.client_sequence === right.client_sequence;
}

function isExactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value as Record<string, unknown>).sort().join(",") === [...keys].sort().join(",");
}

function isBoundedCorrelation(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{24}$/.test(value);
}

function isAgentCorrelation(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function boundedInt(value: unknown, minimum: number, maximum: number): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
