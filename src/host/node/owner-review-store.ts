import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isSafeDeviceIdentifier, sha256Hex } from "../../console/device-grants.js";
import type { OwnerPushContextAuthorization } from "../../console/owner-push.js";
import {
	decodeOwnerReviewMedia, hasExactKeys, isOwnerReviewMediaType, isOwnerReviewText,
	ownerReviewApprovalDigest, parseOwnerReviewApproval, parseOwnerReviewArtifact,
	parseOwnerReviewExecutionRequest, parseOwnerReviewPut, parseOwnerReviewReconciliation,
	sameOwnerReviewBinding, validOwnerReviewBinding,
	type OwnerReviewArtifactVersion, type OwnerReviewBinding, type OwnerReviewDecision,
	type OwnerReviewDecisionRecord, type OwnerReviewExecution, type OwnerReviewMediaType,
	type OwnerReviewWorkItem, type OwnerReviewMutationResult, type OwnerReviewDecisionResult, type OwnerReviewExecutionResult,
} from "../../console/owner-review.js";

interface StoredRevision {
	artifact: OwnerReviewArtifactVersion;
	text: string;
	media_type: OwnerReviewMediaType;
	media_byte_length: number;
	decisions: OwnerReviewDecisionRecord[];
	execution?: OwnerReviewExecution;
}
interface StoredItem extends OwnerReviewBinding {
	work_item_id: string;
	current_revision_id: string;
	revisions: StoredRevision[];
}
interface StoreDocument { version: 1; items: StoredItem[] }

export interface OwnerReviewFileOperations {
	write(path: string, bytes: Uint8Array): void;
	sync(path: string): void;
	rename(from: string, to: string): void;
}
const FILES: OwnerReviewFileOperations = {
	write: (path, bytes) => writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }),
	sync: (path) => { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } },
	rename: renameSync,
};
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_ITEMS = 128;
const MAX_REVISIONS = 64;
const MAX_DECISIONS = 256;

/**
 * Protected immutable artifacts and transactional review receipts. This store
 * never publishes. A durable, single-use execution claim is the only operation
 * that can return may_execute=true; all later attempts require reconciliation.
 */
export class OwnerReviewStore {
	private readonly files: OwnerReviewFileOperations;
	private poisoned = false;
	private readonly path: string;

	constructor(private readonly directory: string, files: Partial<OwnerReviewFileOperations> = {}) {
		if (!isAbsolute(directory)) throw new Error("Owner review store directory must be absolute");
		this.files = { ...FILES, ...files };
		this.path = join(directory, "reviews.json");
		this.ensureDirectory(true);
		if (!existsSync(this.path) && readdirSync(directory).length === 0) {
			const lock = join(directory, "writer.lock");
			let fd: number;
			try { fd = openSync(lock, "wx", 0o600); } catch { throw new OwnerReviewError(503, "owner_review_store_busy"); }
			try {
				if (!existsSync(this.path)) this.atomicWrite(this.path, Buffer.from(JSON.stringify({ version: 1, items: [] })));
			} finally { closeSync(fd); rmSync(lock, { force: true }); }
		}
		this.load();
	}

	put(value: unknown): OwnerReviewMutationResult {
		const request = parseOwnerReviewPut(value);
		if (!request) throw new OwnerReviewError(400, "invalid_owner_review_item");
		return this.transaction<OwnerReviewMutationResult>((document) => {
			let item = document.items.find((entry) => entry.work_item_id === request.artifact.work_item_id);
			if (item && !sameOwnerReviewBinding(item, request)) throw new OwnerReviewError(409, "owner_review_item_conflict");
			const previous = item?.revisions.find((entry) => entry.artifact.revision_id === request.artifact.revision_id);
			if (previous) {
				if (ownerReviewApprovalDigest(previous.artifact) !== ownerReviewApprovalDigest(request.artifact)
					|| previous.text !== request.text || previous.media_type !== request.media_type) {
					throw new OwnerReviewError(409, "owner_review_revision_conflict");
				}
				return { changed: false, result: { disposition: "duplicate" as const, work_item: this.view(item!) } };
			}
			if ((item?.current_revision_id ?? null) !== request.expected_revision_id) throw new OwnerReviewError(409, "owner_review_stale_revision");
			if (item && this.current(item).execution?.state === "uncertain") throw new OwnerReviewError(409, "owner_review_reconciliation_required");
			if (item?.revisions.some((entry) => entry.artifact.media_id === request.artifact.media_id && entry.artifact.media_sha256 !== request.artifact.media_sha256)) {
				throw new OwnerReviewError(409, "owner_review_media_conflict");
			}
			if ((!item && document.items.length >= MAX_ITEMS) || (item && item.revisions.length >= MAX_REVISIONS)) throw new OwnerReviewError(507, "owner_review_capacity_exhausted");
			const bytes = decodeOwnerReviewMedia(request.media_base64)!;
			this.storeMedia(request.artifact.media_sha256, bytes);
			if (!item) {
				item = { binding_id: request.binding_id, route_agent_id: request.route_agent_id, subject_agent_id: request.subject_agent_id,
					work_item_id: request.artifact.work_item_id, current_revision_id: request.artifact.revision_id, revisions: [] };
				document.items.push(item);
			}
			item.revisions.push({ artifact: request.artifact, text: request.text, media_type: request.media_type, media_byte_length: bytes.length, decisions: [] });
			item.current_revision_id = request.artifact.revision_id;
			return { changed: true, result: { disposition: "accepted" as const, work_item: this.view(item) } };
		});
	}

	get(binding: OwnerReviewBinding, workItemId: string): OwnerReviewWorkItem {
		return this.transaction((document) => ({ changed: false, result: this.view(this.item(document, binding, workItemId)) }));
	}

	media(binding: OwnerReviewBinding, workItemId: string, revisionId: string): { bytes: Buffer; contentType: string } {
		return this.transaction((document) => {
			const item = this.item(document, binding, workItemId);
			const revision = item.revisions.find((entry) => entry.artifact.revision_id === revisionId);
			if (!revision) throw new OwnerReviewError(404, "owner_review_not_found");
			return { changed: false, result: { bytes: this.verifyMedia(revision), contentType: revision.media_type } };
		});
	}

	decide(binding: OwnerReviewBinding, workItemId: string, value: unknown, decision: OwnerReviewDecision): OwnerReviewDecisionResult {
		const approval = parseOwnerReviewApproval(value);
		if (!approval || (decision !== "approved" && decision !== "rejected")) throw new OwnerReviewError(400, "invalid_owner_review_approval");
		return this.transaction<OwnerReviewDecisionResult>((document) => {
			const item = this.item(document, binding, workItemId);
			const current = this.current(item);
			const previous = item.revisions.flatMap((entry) => entry.decisions).find((entry) => entry.approval.approval_id === approval.approval_id);
			if (previous) {
				if (previous.decision !== decision || previous.approval.artifact_approval_digest !== approval.artifact_approval_digest) throw new OwnerReviewError(409, "owner_review_approval_conflict");
				return { changed: false, result: { disposition: "duplicate" as const, decision: previous, work_item: this.view(item) } };
			}
			if (approval.artifact_approval_digest !== ownerReviewApprovalDigest(current.artifact)) throw new OwnerReviewError(409, "owner_review_stale_revision");
			if (current.execution) throw new OwnerReviewError(409, "owner_review_execution_already_claimed");
			if (current.decisions.length >= MAX_DECISIONS) throw new OwnerReviewError(507, "owner_review_capacity_exhausted");
			this.verifyMedia(current);
			const record = { decision, approval };
			current.decisions.push(record);
			return { changed: true, result: { disposition: "accepted" as const, decision: record, work_item: this.view(item) } };
		});
	}

	claimExecution(value: unknown): OwnerReviewExecutionResult {
		const request = parseOwnerReviewExecutionRequest(value);
		if (!request) throw new OwnerReviewError(400, "invalid_owner_review_execution");
		return this.transaction<OwnerReviewExecutionResult>((document) => {
			const item = this.item(document, request, request.work_item_id);
			const previous = item.revisions.find((entry) => entry.execution?.attempt_id === request.attempt_id);
			if (previous) {
				if (previous.execution!.approval_id !== request.approval.approval_id || ownerReviewApprovalDigest(previous.artifact) !== request.approval.artifact_approval_digest) throw new OwnerReviewError(409, "owner_review_execution_conflict");
				return { changed: false, result: { disposition: "reconcile_required" as const, may_execute: false, work_item: this.view(item) } };
			}
			const current = this.current(item);
			if (current.execution) throw new OwnerReviewError(409, "owner_review_execution_already_claimed");
			const decision = current.decisions.at(-1);
			if (decision?.decision !== "approved" || decision.approval.approval_id !== request.approval.approval_id
				|| request.approval.artifact_approval_digest !== ownerReviewApprovalDigest(current.artifact)) throw new OwnerReviewError(409, "owner_review_approval_required");
			this.verifyMedia(current);
			current.execution = { attempt_id: request.attempt_id, approval_id: request.approval.approval_id, state: "uncertain" };
			return { changed: true, result: { disposition: "claimed" as const, may_execute: true, work_item: this.view(item) } };
		});
	}

	reconcile(value: unknown): OwnerReviewMutationResult {
		const request = parseOwnerReviewReconciliation(value);
		if (!request) throw new OwnerReviewError(400, "invalid_owner_review_reconciliation");
		return this.transaction<OwnerReviewMutationResult>((document) => {
			const item = this.item(document, request, request.work_item_id);
			const revision = item.revisions.find((entry) => entry.execution?.attempt_id === request.attempt_id);
			if (!revision || ownerReviewApprovalDigest(revision.artifact) !== request.artifact_approval_digest) throw new OwnerReviewError(409, "owner_review_execution_conflict");
			const execution = revision.execution!;
			if (execution.state !== "uncertain") {
				if (execution.state !== request.outcome || execution.reconciliation_id !== request.reconciliation_id) throw new OwnerReviewError(409, "owner_review_reconciliation_conflict");
				return { changed: false, result: { disposition: "duplicate" as const, work_item: this.view(item) } };
			}
			if (item.revisions.some((entry) => entry.execution?.reconciliation_id === request.reconciliation_id)) throw new OwnerReviewError(409, "owner_review_reconciliation_conflict");
			execution.state = request.outcome;
			execution.reconciliation_id = request.reconciliation_id;
			return { changed: true, result: { disposition: "accepted" as const, work_item: this.view(item) } };
		});
	}

	/** Compose with the existing owner-push verifier; no notification content is needed. */
	authorizesContext(value: OwnerPushContextAuthorization): boolean {
		try {
			const item = this.get({ binding_id: value.bindingId, route_agent_id: value.routeAgentId, subject_agent_id: value.subjectAgentId }, value.context.context_id);
			return value.context.kind === "task" && value.context.relationship_id === value.bindingId && value.context.anchor_id === item.artifact.revision_id;
		} catch (error) {
			if (error instanceof OwnerReviewError && error.status === 404) return false;
			throw error;
		}
	}

	private item(document: StoreDocument, binding: OwnerReviewBinding, id: string): StoredItem {
		const item = document.items.find((entry) => entry.work_item_id === id);
		if (!item || !sameOwnerReviewBinding(item, binding)) throw new OwnerReviewError(404, "owner_review_not_found");
		return item;
	}
	private current(item: StoredItem): StoredRevision { return item.revisions.at(-1)!; }
	private view(item: StoredItem): OwnerReviewWorkItem {
		const revision = this.current(item);
		this.verifyMedia(revision);
		const decision = revision.decisions.at(-1);
		return structuredClone({ version: 1, binding_id: item.binding_id, route_agent_id: item.route_agent_id, subject_agent_id: item.subject_agent_id,
			artifact: revision.artifact, artifact_approval_digest: ownerReviewApprovalDigest(revision.artifact),
			text: revision.text, media_type: revision.media_type, media_byte_length: revision.media_byte_length,
			state: revision.execution?.state ?? decision?.decision ?? "pending_review",
			...(decision ? { decision } : {}), ...(revision.execution ? { execution: revision.execution } : {}) });
	}
	private transaction<T>(mutate: (document: StoreDocument) => { changed: boolean; result: T }): T {
		this.ensureAvailable();
		const lock = join(this.directory, "writer.lock");
		let fd: number;
		try { fd = openSync(lock, "wx", 0o600); } catch { throw new OwnerReviewError(503, "owner_review_store_busy"); }
		try {
			const document = this.load();
			const { changed, result } = mutate(document);
			if (changed) {
				const bytes = Buffer.from(JSON.stringify(document));
				if (bytes.length > MAX_DOCUMENT_BYTES) throw new OwnerReviewError(507, "owner_review_capacity_exhausted");
				this.atomicWrite(this.path, bytes);
			}
			return result;
		} finally { closeSync(fd); rmSync(lock, { force: true }); }
	}
	private ensureDirectory(create = false): void {
		try {
			if (create && !existsSync(this.directory)) {
				mkdirSync(this.directory, { mode: 0o700 });
				this.files.sync(dirname(this.directory));
			}
			const stat = lstatSync(this.directory);
			if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("unsafe");
		} catch {
			throw new OwnerReviewError(503, "owner_review_store_unsafe");
		}
	}
	private ensureAvailable(): void {
		if (this.poisoned) throw new OwnerReviewError(503, "owner_review_durability_uncertain");
		this.ensureDirectory();
	}
	private load(): StoreDocument {
		this.ensureAvailable();
		if (!existsSync(this.path)) throw new OwnerReviewError(503, "owner_review_store_unreadable");
		try {
			const bytes = this.readPrivate(this.path, MAX_DOCUMENT_BYTES);
			const document = JSON.parse(bytes.toString("utf8"));
			if (!validDocument(document)) throw new Error("invalid");
			return document;
		} catch { throw new OwnerReviewError(503, "owner_review_store_unreadable"); }
	}
	private readPrivate(path: string, limit: number): Buffer {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > limit) throw new Error("unsafe");
		return readFileSync(path);
	}
	private verifyMedia(revision: StoredRevision): Buffer {
		try {
			const bytes = this.readPrivate(join(this.directory, `${revision.artifact.media_sha256}.blob`), revision.media_byte_length);
			if (bytes.length !== revision.media_byte_length || sha256Hex(bytes) !== revision.artifact.media_sha256) throw new Error("changed");
			return bytes;
		} catch { throw new OwnerReviewError(503, "owner_review_media_unavailable"); }
	}
	private storeMedia(digest: string, bytes: Buffer): void {
		const path = join(this.directory, `${digest}.blob`);
		if (existsSync(path)) {
			try { if (!this.readPrivate(path, bytes.length).equals(bytes)) throw new Error("changed"); }
			catch { throw new OwnerReviewError(503, "owner_review_media_unavailable"); }
			return;
		}
		this.atomicWrite(path, bytes);
	}
	private atomicWrite(path: string, bytes: Buffer): void {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			this.files.write(temporary, bytes);
			this.files.sync(temporary);
			this.files.rename(temporary, path);
			this.files.sync(this.directory);
		} catch {
			this.poisoned = true;
			throw new OwnerReviewError(503, "owner_review_durability_uncertain");
		} finally { rmSync(temporary, { force: true }); }
	}
}

export class OwnerReviewError extends Error {
	constructor(readonly status: number, readonly code: string) { super(code); }
}

function validDocument(value: unknown): value is StoreDocument {
	if (!hasExactKeys(value, ["version", "items"]) || value.version !== 1 || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) return false;
	const ids = new Set<string>();
	for (const item of value.items) {
		if (!hasExactKeys(item, ["binding_id", "route_agent_id", "subject_agent_id", "work_item_id", "current_revision_id", "revisions"])
			|| !validOwnerReviewBinding(item) || !isSafeDeviceIdentifier(item.work_item_id) || ids.has(item.work_item_id)
			|| !Array.isArray(item.revisions) || item.revisions.length < 1 || item.revisions.length > MAX_REVISIONS) return false;
		ids.add(item.work_item_id);
		const revisions = new Set<string>();
		const decisions = new Set<string>();
		const attempts = new Set<string>();
		const reconciliations = new Set<string>();
		const media = new Map<string, string>();
		for (const revision of item.revisions) {
			if (!hasExactKeys(revision, ["artifact", "text", "media_type", "media_byte_length", "decisions"], ["execution"])) return false;
			const artifact = parseOwnerReviewArtifact(revision.artifact);
			if (!artifact || artifact.work_item_id !== item.work_item_id || revisions.has(artifact.revision_id)
				|| !isOwnerReviewText(revision.text) || sha256Hex(Buffer.from(revision.text)) !== artifact.text_sha256
				|| !isOwnerReviewMediaType(revision.media_type) || !Number.isSafeInteger(revision.media_byte_length)
				|| (revision.media_byte_length as number) < 1 || (revision.media_byte_length as number) > 8 * 1024 * 1024
				|| !Array.isArray(revision.decisions) || revision.decisions.length > MAX_DECISIONS) return false;
			if (media.has(artifact.media_id) && media.get(artifact.media_id) !== artifact.media_sha256) return false;
			media.set(artifact.media_id, artifact.media_sha256);
			revisions.add(artifact.revision_id);
			for (const decision of revision.decisions) {
				if (!hasExactKeys(decision, ["decision", "approval"]) || !["approved", "rejected"].includes(decision.decision as string)) return false;
				const approval = parseOwnerReviewApproval(decision.approval);
				if (!approval || decisions.has(approval.approval_id) || approval.artifact_approval_digest !== ownerReviewApprovalDigest(artifact)) return false;
				decisions.add(approval.approval_id);
			}
			if (revision.execution !== undefined) {
				const execution = revision.execution;
				const last = revision.decisions.at(-1);
				if (!hasExactKeys(execution, ["attempt_id", "approval_id", "state"], ["reconciliation_id"])
					|| !isSafeDeviceIdentifier(execution.attempt_id) || attempts.has(execution.attempt_id)
					|| last?.decision !== "approved" || execution.approval_id !== last.approval.approval_id
					|| !["uncertain", "completed", "not_completed"].includes(execution.state as string)) return false;
				attempts.add(execution.attempt_id);
				if (execution.state === "uncertain") {
					if (execution.reconciliation_id !== undefined || artifact.revision_id !== item.current_revision_id) return false;
				} else {
					if (!isSafeDeviceIdentifier(execution.reconciliation_id) || reconciliations.has(execution.reconciliation_id)) return false;
					reconciliations.add(execution.reconciliation_id);
				}
			}
		}
		if (item.revisions.at(-1)?.artifact.revision_id !== item.current_revision_id) return false;
	}
	return true;
}
