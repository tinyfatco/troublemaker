import { sha256Hex, isSafeDeviceIdentifier } from "./device-grants.js";
import { parseOwnerPushEnvelope, type OwnerPushEnvelope } from "./owner-push.js";

export const OWNER_REVIEW_VERSION = 1 as const;
export const OWNER_REVIEW_SCOPE = "owner_review" as const;
export const OWNER_REVIEW_MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const OWNER_REVIEW_MAX_TEXT_BYTES = 128 * 1024;
export const OWNER_REVIEW_MAX_BODY_BYTES = 12 * 1024 * 1024;

/** Matches the native OwnerReviewArtifactVersion CodingKeys and digest, byte for byte. */
export interface OwnerReviewArtifactVersion {
	version: 1;
	work_item_id: string;
	revision_id: string;
	media_id: string;
	media_sha256: string;
	text_sha256: string;
	action: "publish";
	account_id: string;
}

/** Matches the native OwnerReviewApproval. A decision is not an execution request. */
export interface OwnerReviewApproval {
	version: 1;
	approval_id: string;
	artifact_approval_digest: string;
}

export interface OwnerReviewBinding {
	binding_id: string;
	route_agent_id: string;
	subject_agent_id: string;
}

export type OwnerReviewMediaType = "image/png" | "image/jpeg" | "video/mp4" | "application/pdf" | "text/plain";
export type OwnerReviewDecision = "approved" | "rejected";
export type OwnerReviewExecutionState = "uncertain" | "completed" | "not_completed";

export interface OwnerReviewPutRequest extends OwnerReviewBinding {
	version: 1;
	expected_revision_id: string | null;
	artifact: OwnerReviewArtifactVersion;
	text: string;
	media_type: OwnerReviewMediaType;
	media_base64: string;
}

export interface OwnerReviewDecisionRecord {
	decision: OwnerReviewDecision;
	approval: OwnerReviewApproval;
}

export interface OwnerReviewExecution {
	attempt_id: string;
	approval_id: string;
	state: OwnerReviewExecutionState;
	reconciliation_id?: string;
}

export interface OwnerReviewWorkItem extends OwnerReviewBinding {
	version: 1;
	artifact: OwnerReviewArtifactVersion;
	artifact_approval_digest: string;
	text: string;
	media_type: OwnerReviewMediaType;
	media_byte_length: number;
	state: "pending_review" | OwnerReviewDecision | OwnerReviewExecutionState;
	decision?: OwnerReviewDecisionRecord;
	execution?: OwnerReviewExecution;
}

export interface OwnerReviewExecutionRequest extends OwnerReviewBinding {
	version: 1;
	work_item_id: string;
	attempt_id: string;
	approval: OwnerReviewApproval;
}

export interface OwnerReviewReconciliationRequest extends OwnerReviewBinding {
	version: 1;
	work_item_id: string;
	attempt_id: string;
	artifact_approval_digest: string;
	reconciliation_id: string;
	outcome: "completed" | "not_completed";
}

export function parseOwnerReviewArtifact(value: unknown): OwnerReviewArtifactVersion | null {
	if (!hasExactKeys(value, ["version", "work_item_id", "revision_id", "media_id", "media_sha256", "text_sha256", "action", "account_id"])
		|| value.version !== 1 || value.action !== "publish"
		|| ![value.work_item_id, value.revision_id, value.media_id, value.account_id].every(isSafeDeviceIdentifier)
		|| !isOwnerReviewDigest(value.media_sha256) || !isOwnerReviewDigest(value.text_sha256)) return null;
	return { ...value } as unknown as OwnerReviewArtifactVersion;
}

export function parseOwnerReviewApproval(value: unknown): OwnerReviewApproval | null {
	if (!hasExactKeys(value, ["version", "approval_id", "artifact_approval_digest"])
		|| value.version !== 1 || !isSafeDeviceIdentifier(value.approval_id)
		|| !isOwnerReviewDigest(value.artifact_approval_digest)) return null;
	return { ...value } as unknown as OwnerReviewApproval;
}

export function ownerReviewApprovalDigest(value: OwnerReviewArtifactVersion): string {
	const artifact = parseOwnerReviewArtifact(value);
	if (!artifact) throw new Error("invalid_owner_review_artifact");
	return sha256Hex(Buffer.from([
		"computer-owner-review-artifact-v1", String(artifact.version), artifact.work_item_id,
		artifact.revision_id, artifact.media_id, artifact.media_sha256, artifact.text_sha256,
		artifact.action, artifact.account_id,
	].join("\n"), "utf8"));
}

export function parseOwnerReviewPut(value: unknown): OwnerReviewPutRequest | null {
	if (!hasExactKeys(value, ["version", ...BINDING_KEYS, "expected_revision_id", "artifact", "text", "media_type", "media_base64"])
		|| value.version !== 1 || !validOwnerReviewBinding(value)
		|| (value.expected_revision_id !== null && !isSafeDeviceIdentifier(value.expected_revision_id))
		|| !parseOwnerReviewArtifact(value.artifact) || !isOwnerReviewText(value.text)
		|| !isOwnerReviewMediaType(value.media_type) || !decodeOwnerReviewMedia(value.media_base64)) return null;
	const request = value as unknown as OwnerReviewPutRequest;
	if (sha256Hex(Buffer.from(request.text, "utf8")) !== request.artifact.text_sha256
		|| sha256Hex(decodeOwnerReviewMedia(request.media_base64)!) !== request.artifact.media_sha256) return null;
	return structuredClone(request);
}

export function parseOwnerReviewExecutionRequest(value: unknown): OwnerReviewExecutionRequest | null {
	if (!hasExactKeys(value, ["version", ...BINDING_KEYS, "work_item_id", "attempt_id", "approval"])
		|| value.version !== 1 || !validOwnerReviewBinding(value)
		|| !isSafeDeviceIdentifier(value.work_item_id) || !isSafeDeviceIdentifier(value.attempt_id)
		|| !parseOwnerReviewApproval(value.approval)) return null;
	return structuredClone(value) as unknown as OwnerReviewExecutionRequest;
}

export function parseOwnerReviewReconciliation(value: unknown): OwnerReviewReconciliationRequest | null {
	if (!hasExactKeys(value, ["version", ...BINDING_KEYS, "work_item_id", "attempt_id", "artifact_approval_digest", "reconciliation_id", "outcome"])
		|| value.version !== 1 || !validOwnerReviewBinding(value)
		|| ![value.work_item_id, value.attempt_id, value.reconciliation_id].every(isSafeDeviceIdentifier)
		|| !isOwnerReviewDigest(value.artifact_approval_digest)
		|| (value.outcome !== "completed" && value.outcome !== "not_completed")) return null;
	return { ...value } as unknown as OwnerReviewReconciliationRequest;
}

/** Content-free pointer; callers explicitly dispatch through the existing push authority. */
export function ownerReviewNotification(item: OwnerReviewWorkItem, notificationId: string, eventId: string): OwnerPushEnvelope {
	const envelope = parseOwnerPushEnvelope({
		version: 1, notification_id: notificationId, event_id: eventId,
		binding_id: item.binding_id, route_agent_id: item.route_agent_id, subject_agent_id: item.subject_agent_id,
		context: { kind: "task", context_id: item.artifact.work_item_id, relationship_id: item.binding_id, anchor_id: item.artifact.revision_id },
	});
	if (!envelope) throw new Error("invalid_owner_review_notification");
	return envelope;
}

const BINDING_KEYS = ["binding_id", "route_agent_id", "subject_agent_id"];
export function validOwnerReviewBinding(value: Record<string, unknown>): boolean {
	return BINDING_KEYS.every((key) => isSafeDeviceIdentifier(value[key]));
}
export function sameOwnerReviewBinding(a: OwnerReviewBinding, b: OwnerReviewBinding): boolean {
	return a.binding_id === b.binding_id && a.route_agent_id === b.route_agent_id && a.subject_agent_id === b.subject_agent_id;
}
export function isOwnerReviewDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function isOwnerReviewText(value: unknown): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= OWNER_REVIEW_MAX_TEXT_BYTES
		&& Buffer.from(value, "utf8").toString("utf8") === value;
}
export function isOwnerReviewMediaType(value: unknown): value is OwnerReviewMediaType {
	return ["image/png", "image/jpeg", "video/mp4", "application/pdf", "text/plain"].includes(value as string);
}
export function decodeOwnerReviewMedia(value: unknown): Buffer | null {
	if (typeof value !== "string" || !value || value.length > Math.ceil(OWNER_REVIEW_MAX_MEDIA_BYTES / 3) * 4
		|| !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
	const bytes = Buffer.from(value, "base64");
	return bytes.length > 0 && bytes.length <= OWNER_REVIEW_MAX_MEDIA_BYTES && bytes.toString("base64") === value ? bytes : null;
}
export function hasExactKeys(value: unknown, keys: string[], optional: string[] = []): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& keys.every((key) => Object.hasOwn(value, key))
		&& Object.keys(value as object).every((key) => keys.includes(key) || optional.includes(key));
}

export interface OwnerReviewMutationResult {
	disposition: "accepted" | "duplicate";
	work_item: OwnerReviewWorkItem;
}
export interface OwnerReviewDecisionResult extends OwnerReviewMutationResult {
	decision: OwnerReviewDecisionRecord;
}
export type OwnerReviewExecutionResult = {
	disposition: "claimed"; may_execute: true; work_item: OwnerReviewWorkItem;
} | {
	disposition: "reconcile_required"; may_execute: false; work_item: OwnerReviewWorkItem;
};

