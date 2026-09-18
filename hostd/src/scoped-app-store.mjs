import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scopedAppContextDocument } from "./scoped-app-contract.mjs";
import { stablePrivateKey } from "./security.mjs";

function now() {
	return new Date().toISOString();
}

function digest(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export class ScopedAppStoreError extends Error {
	constructor(code, status = 409) {
		super(code);
		this.name = "ScopedAppStoreError";
		this.code = code;
		this.status = status;
	}
}

export function scopedAppScopeKeys(routingKey, targetId, scope) {
	const accountKey = stablePrivateKey(routingKey, "scoped-app-account", scope.accountId).slice(0, 40);
	const userKey = stablePrivateKey(routingKey, "scoped-app-user", scope.userId).slice(0, 40);
	const membershipKey = stablePrivateKey(
		routingKey,
		"scoped-app-membership",
		`${scope.accountId}\0${scope.membershipId}`,
	).slice(0, 40);
	const principalKey = stablePrivateKey(
		routingKey,
		"scoped-app-principal",
		`${scope.accountId}\0${scope.userId}`,
	).slice(0, 40);
	return {
		accountKey,
		userKey,
		membershipKey,
		principalKey,
		contextId: `${targetId}:${principalKey}:scoped-app`,
	};
}

export class ScopedAppStore {
	constructor(path, { maximumEventsPerContext = 2_000, maximumActiveTurnsPerContext = 1 } = {}) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.database = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.maximumEventsPerContext = maximumEventsPerContext;
		this.maximumActiveTurnsPerContext = maximumActiveTurnsPerContext;
		this.database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;

			CREATE TABLE IF NOT EXISTS scoped_app_memberships (
				account_key TEXT NOT NULL,
				membership_key TEXT NOT NULL,
				highest_version INTEGER NOT NULL,
				revoked_version INTEGER,
				updated_at TEXT NOT NULL,
				PRIMARY KEY(account_key, membership_key)
			);

			CREATE TABLE IF NOT EXISTS scoped_app_context_documents (
				account_key TEXT PRIMARY KEY,
				revision INTEGER NOT NULL,
				markdown TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS scoped_app_requests (
				request_id TEXT PRIMARY KEY,
				operation TEXT NOT NULL,
				scope_key TEXT NOT NULL,
				body_sha256 TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
				response_json TEXT,
				created_at TEXT NOT NULL,
				completed_at TEXT
			);

			CREATE TABLE IF NOT EXISTS scoped_app_turns (
				context_id TEXT NOT NULL,
				turn_id TEXT NOT NULL,
				account_key TEXT NOT NULL,
				user_key TEXT NOT NULL,
				membership_key TEXT NOT NULL,
				membership_version INTEGER NOT NULL,
				request_sha256 TEXT NOT NULL,
				input_text TEXT NOT NULL,
				status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
				scope_json TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT,
				PRIMARY KEY(context_id, turn_id)
			);

			CREATE INDEX IF NOT EXISTS scoped_app_turns_active
				ON scoped_app_turns(context_id, status);
			CREATE INDEX IF NOT EXISTS scoped_app_turns_membership
				ON scoped_app_turns(account_key, membership_key, status);

			CREATE TABLE IF NOT EXISTS scoped_app_sequences (
				context_id TEXT PRIMARY KEY,
				last_sequence INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS scoped_app_events (
				context_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				turn_id TEXT NOT NULL,
				type TEXT NOT NULL CHECK(type IN ('message', 'status', 'context-proposal', 'evidence', 'revocation')),
				text TEXT,
				data_json TEXT,
				created_at TEXT NOT NULL,
				PRIMARY KEY(context_id, sequence),
				FOREIGN KEY(context_id, turn_id)
					REFERENCES scoped_app_turns(context_id, turn_id)
					ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS scoped_app_evidence (
				artifact_id TEXT PRIMARY KEY,
				context_id TEXT NOT NULL,
				account_key TEXT NOT NULL,
				user_key TEXT NOT NULL,
				turn_id TEXT NOT NULL,
				receipt_json TEXT NOT NULL,
				media_type TEXT NOT NULL CHECK(media_type IN ('image/png', 'image/jpeg')),
				artifact_sha256 TEXT NOT NULL,
				artifact_bytes BLOB NOT NULL,
				created_at TEXT NOT NULL,
				FOREIGN KEY(context_id, turn_id)
					REFERENCES scoped_app_turns(context_id, turn_id)
					ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS scoped_app_evidence_scope
				ON scoped_app_evidence(context_id, account_key, user_key, artifact_id);
		`);
	}

	close() {
		this.database.close();
	}

	transaction(callback) {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = callback();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	acceptMembership(accountKey, membershipKey, membershipVersion) {
		return this.transaction(() => {
			const current = this.database.prepare(`
				SELECT highest_version AS highestVersion, revoked_version AS revokedVersion
				FROM scoped_app_memberships
				WHERE account_key = ? AND membership_key = ?
			`).get(accountKey, membershipKey);
			if (
				current
				&& (current.highestVersion > membershipVersion || (current.revokedVersion ?? 0) >= membershipVersion)
			) throw new ScopedAppStoreError("scope_revoked", 403);
			const timestamp = now();
			this.database.prepare(`
				INSERT INTO scoped_app_memberships(
					account_key, membership_key, highest_version, revoked_version, updated_at
				) VALUES (?, ?, ?, NULL, ?)
				ON CONFLICT(account_key, membership_key) DO UPDATE SET
					highest_version = MAX(highest_version, excluded.highest_version),
					updated_at = excluded.updated_at
			`).run(accountKey, membershipKey, membershipVersion, timestamp);
			return { accepted: true, membershipVersion };
		});
	}

	revokeMembership(accountKey, membershipKey, membershipVersion) {
		return this.transaction(() => {
			const timestamp = now();
			this.database.prepare(`
				INSERT INTO scoped_app_memberships(
					account_key, membership_key, highest_version, revoked_version, updated_at
				) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(account_key, membership_key) DO UPDATE SET
					highest_version = MAX(highest_version, excluded.highest_version),
					revoked_version = MAX(COALESCE(revoked_version, 0), excluded.revoked_version),
					updated_at = excluded.updated_at
			`).run(accountKey, membershipKey, membershipVersion, membershipVersion, timestamp);
			return { revoked: true };
		});
	}

	readContext(accountKey) {
		const row = this.database.prepare(`
			SELECT markdown, revision, sha256
			FROM scoped_app_context_documents WHERE account_key = ?
		`).get(accountKey);
		return row
			? { markdown: row.markdown, revision: row.revision, sha256: row.sha256 }
			: scopedAppContextDocument("", 0);
	}

	writeContext(accountKey, markdown, expectedRevision) {
		return this.transaction(() => {
			const current = this.readContext(accountKey);
			if (current.revision !== expectedRevision) {
				throw new ScopedAppStoreError("context_revision_conflict", 409);
			}
			const document = scopedAppContextDocument(markdown, current.revision + 1);
			this.database.prepare(`
				INSERT INTO scoped_app_context_documents(account_key, revision, markdown, sha256, updated_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(account_key) DO UPDATE SET
					revision = excluded.revision,
					markdown = excluded.markdown,
					sha256 = excluded.sha256,
					updated_at = excluded.updated_at
			`).run(accountKey, document.revision, document.markdown, document.sha256, now());
			return document;
		});
	}

	claimRequest({ requestId, operation, scopeKey, body }) {
		const bodySha256 = digest(body);
		return this.transaction(() => {
			const current = this.database.prepare(`
				SELECT operation, scope_key AS scopeKey, body_sha256 AS bodySha256,
					status, response_json AS responseJson
				FROM scoped_app_requests WHERE request_id = ?
			`).get(requestId);
			if (current) {
				if (current.operation !== operation || current.scopeKey !== scopeKey || current.bodySha256 !== bodySha256) {
					throw new ScopedAppStoreError("request_id_conflict", 409);
				}
				return {
					claimed: false,
					status: current.status,
					response: current.responseJson ? JSON.parse(current.responseJson) : undefined,
				};
			}
			this.database.prepare(`
				INSERT INTO scoped_app_requests(
					request_id, operation, scope_key, body_sha256, status, created_at
				) VALUES (?, ?, ?, ?, 'running', ?)
			`).run(requestId, operation, scopeKey, bodySha256, now());
			return { claimed: true, status: "running" };
		});
	}

	completeRequest(requestId, response) {
		const result = this.database.prepare(`
			UPDATE scoped_app_requests
			SET status = 'completed', response_json = ?, completed_at = ?
			WHERE request_id = ? AND status = 'running'
		`).run(JSON.stringify(response), now(), requestId);
		if (result.changes !== 1) throw new ScopedAppStoreError("request_not_running", 409);
		return response;
	}

	failRequest(requestId) {
		this.database.prepare(`
			UPDATE scoped_app_requests SET status = 'failed', completed_at = ?
			WHERE request_id = ? AND status = 'running'
		`).run(now(), requestId);
	}

	putEvidence({ artifactId, contextId, accountKey, userKey, turnId, receipt, artifact }) {
		return this.transaction(() => {
			const existing = this.database.prepare(`
				SELECT context_id AS contextId, account_key AS accountKey, user_key AS userKey,
					turn_id AS turnId, receipt_json AS receiptJson, media_type AS mediaType,
					artifact_sha256 AS sha256, artifact_bytes AS bytes
				FROM scoped_app_evidence WHERE artifact_id = ?
			`).get(artifactId);
			const receiptJson = JSON.stringify(receipt);
			if (existing) {
				if (
					existing.contextId !== contextId
					|| existing.accountKey !== accountKey
					|| existing.userKey !== userKey
					|| existing.turnId !== turnId
					|| existing.receiptJson !== receiptJson
					|| existing.mediaType !== artifact.mediaType
					|| existing.sha256 !== artifact.sha256
					|| !Buffer.from(existing.bytes).equals(artifact.bytes)
				) throw new ScopedAppStoreError("artifact_id_conflict", 409);
				return receipt;
			}
			this.database.prepare(`
				INSERT INTO scoped_app_evidence(
					artifact_id, context_id, account_key, user_key, turn_id,
					receipt_json, media_type, artifact_sha256, artifact_bytes, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				artifactId,
				contextId,
				accountKey,
				userKey,
				turnId,
				receiptJson,
				artifact.mediaType,
				artifact.sha256,
				artifact.bytes,
				now(),
			);
			return receipt;
		});
	}

	readEvidence(artifactId, contextId, accountKey, userKey) {
		const row = this.database.prepare(`
			SELECT receipt_json AS receiptJson
			FROM scoped_app_evidence
			WHERE artifact_id = ? AND context_id = ? AND account_key = ? AND user_key = ?
		`).get(artifactId, contextId, accountKey, userKey);
		if (!row) throw new ScopedAppStoreError("artifact_not_found", 404);
		const receipt = JSON.parse(row.receiptJson);
		if (receipt.representation === undefined && receipt.originalSourceScreenshot === undefined) {
			return {
				...receipt,
				representation: "derived_quote_rendering",
				originalSourceScreenshot: false,
			};
		}
		if (
			receipt.representation !== "derived_quote_rendering"
			|| receipt.originalSourceScreenshot !== false
		) throw new ScopedAppStoreError("artifact_metadata_invalid", 500);
		return receipt;
	}

	readArtifact(artifactId, contextId, accountKey, userKey) {
		const row = this.database.prepare(`
			SELECT media_type AS mediaType, artifact_sha256 AS sha256, artifact_bytes AS bytes
			FROM scoped_app_evidence
			WHERE artifact_id = ? AND context_id = ? AND account_key = ? AND user_key = ?
		`).get(artifactId, contextId, accountKey, userKey);
		if (!row) throw new ScopedAppStoreError("artifact_not_found", 404);
		return {
			mediaType: row.mediaType,
			base64: Buffer.from(row.bytes).toString("base64"),
			sha256: row.sha256,
		};
	}

	getTurn(contextId, turnId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, turn_id AS turnId, account_key AS accountKey,
				user_key AS userKey, membership_key AS membershipKey,
				membership_version AS membershipVersion, request_sha256 AS requestSha256,
				input_text AS inputText, status, scope_json AS scopeJson,
				last_error AS lastError, created_at AS createdAt,
				updated_at AS updatedAt, completed_at AS completedAt
			FROM scoped_app_turns WHERE context_id = ? AND turn_id = ?
		`).get(contextId, turnId);
	}

	startTurn({ contextId, turnId, accountKey, userKey, membershipKey, membershipVersion, text, scope }) {
		const requestSha256 = digest(text);
		return this.transaction(() => {
			const existing = this.getTurn(contextId, turnId);
			if (existing) {
				if (existing.requestSha256 !== requestSha256) {
					throw new ScopedAppStoreError("turn_id_conflict", 409);
				}
				return { ...existing, duplicate: true };
			}
			const active = this.database.prepare(`
				SELECT COUNT(*) AS count FROM scoped_app_turns
				WHERE context_id = ? AND status IN ('queued', 'running')
			`).get(contextId).count;
			if (active >= this.maximumActiveTurnsPerContext) {
				throw new ScopedAppStoreError("too_many_active_turns", 429);
			}
			const timestamp = now();
			this.database.prepare(`
				INSERT INTO scoped_app_turns(
					context_id, turn_id, account_key, user_key, membership_key,
					membership_version, request_sha256, input_text, status,
					scope_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
			`).run(
				contextId,
				turnId,
				accountKey,
				userKey,
				membershipKey,
				membershipVersion,
				requestSha256,
				text,
				JSON.stringify(scope),
				timestamp,
				timestamp,
			);
			this.appendEventUnlocked(contextId, turnId, "message", text, { role: "user" });
			this.appendEventUnlocked(contextId, turnId, "status", undefined, { status: "queued" });
			return { ...this.getTurn(contextId, turnId), duplicate: false };
		});
	}

	startEvidenceTurn({ contextId, turnId, accountKey, userKey, membershipKey, membershipVersion, request, scope }) {
		const requestSha256 = digest(request);
		return this.transaction(() => {
			const existing = this.getTurn(contextId, turnId);
			if (existing) {
				if (
					existing.requestSha256 !== requestSha256
					|| existing.accountKey !== accountKey
					|| existing.userKey !== userKey
					|| existing.membershipKey !== membershipKey
				) throw new ScopedAppStoreError("turn_id_conflict", 409);
				if (["failed", "cancelled"].includes(existing.status)) {
					this.database.prepare(`
						UPDATE scoped_app_turns
						SET status = 'running', membership_version = ?, scope_json = ?,
							last_error = NULL, updated_at = ?, completed_at = NULL
						WHERE context_id = ? AND turn_id = ?
					`).run(membershipVersion, JSON.stringify(scope), now(), contextId, turnId);
					return { ...this.getTurn(contextId, turnId), duplicate: false, retried: true };
				}
				return { ...existing, duplicate: true };
			}
			const active = this.database.prepare(`
				SELECT COUNT(*) AS count FROM scoped_app_turns
				WHERE context_id = ? AND status IN ('queued', 'running')
			`).get(contextId).count;
			if (active >= this.maximumActiveTurnsPerContext) {
				throw new ScopedAppStoreError("too_many_active_turns", 429);
			}
			const timestamp = now();
			this.database.prepare(`
				INSERT INTO scoped_app_turns(
					context_id, turn_id, account_key, user_key, membership_key,
					membership_version, request_sha256, input_text, status,
					scope_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'running', ?, ?, ?)
			`).run(
				contextId,
				turnId,
				accountKey,
				userKey,
				membershipKey,
				membershipVersion,
				requestSha256,
				JSON.stringify(scope),
				timestamp,
				timestamp,
			);
			return { ...this.getTurn(contextId, turnId), duplicate: false };
		});
	}

	setTurnStatus(contextId, turnId, status, { error, clearScope = false } = {}) {
		return this.transaction(() => {
			const current = this.getTurn(contextId, turnId);
			if (!current) throw new ScopedAppStoreError("turn_not_found", 404);
			if (["completed", "cancelled", "failed"].includes(current.status)) return current;
			const terminal = ["completed", "cancelled", "failed"].includes(status);
			this.database.prepare(`
				UPDATE scoped_app_turns
				SET status = ?, scope_json = CASE WHEN ? THEN NULL ELSE scope_json END,
					last_error = ?, updated_at = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END
				WHERE context_id = ? AND turn_id = ?
			`).run(status, clearScope ? 1 : 0, error ?? null, now(), terminal ? 1 : 0, terminal ? now() : null, contextId, turnId);
			this.appendEventUnlocked(contextId, turnId, "status", undefined, { status });
			return this.getTurn(contextId, turnId);
		});
	}

	appendEvent(contextId, turnId, type, text, data) {
		return this.transaction(() => this.appendEventUnlocked(contextId, turnId, type, text, data));
	}

	appendEventUnlocked(contextId, turnId, type, text, data) {
		this.database.prepare(`
			INSERT INTO scoped_app_sequences(context_id, last_sequence) VALUES (?, 0)
			ON CONFLICT(context_id) DO NOTHING
		`).run(contextId);
		const sequence = this.database.prepare(`
			UPDATE scoped_app_sequences SET last_sequence = last_sequence + 1
			WHERE context_id = ? RETURNING last_sequence AS sequence
		`).get(contextId).sequence;
		this.database.prepare(`
			INSERT INTO scoped_app_events(
				context_id, sequence, turn_id, type, text, data_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(contextId, sequence, turnId, type, text ?? null, data ? JSON.stringify(data) : null, now());
		this.database.prepare(`
			DELETE FROM scoped_app_events
			WHERE context_id = ? AND sequence <= (
				SELECT MAX(sequence) - ? FROM scoped_app_events WHERE context_id = ?
			)
		`).run(contextId, this.maximumEventsPerContext, contextId);
		return { sequence, turnId, type, ...(text === undefined ? {} : { text }), ...(data ? { data } : {}) };
	}

	listEvents(contextId, after, limit = 100) {
		const rows = this.database.prepare(`
			SELECT sequence, turn_id AS turnId, type, text, data_json AS dataJson
			FROM scoped_app_events
			WHERE context_id = ? AND sequence > ?
			ORDER BY sequence LIMIT ?
		`).all(contextId, after, Math.min(100, Math.max(1, limit)));
		const events = rows.map((row) => ({
			sequence: row.sequence,
			turnId: row.turnId,
			type: row.type,
			...(row.text === null ? {} : { text: row.text }),
			...(row.dataJson === null ? {} : { data: JSON.parse(row.dataJson) }),
		}));
		return {
			events,
			nextCursor: events.at(-1)?.sequence ?? after,
		};
	}

	updateTurnScope(contextId, turnId, scope) {
		const result = this.database.prepare(`
			UPDATE scoped_app_turns SET scope_json = ?, updated_at = ?
			WHERE context_id = ? AND turn_id = ? AND status IN ('queued', 'running')
		`).run(JSON.stringify(scope), now(), contextId, turnId);
		if (result.changes !== 1) throw new ScopedAppStoreError("turn_not_active", 409);
		return this.getTurn(contextId, turnId);
	}

	activeTurnsForContext(contextId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, turn_id AS turnId, status
			FROM scoped_app_turns
			WHERE context_id = ? AND status IN ('queued', 'running')
			ORDER BY created_at
		`).all(contextId).map((turn) => ({
			contextId: turn.contextId,
			turnId: turn.turnId,
			status: turn.status,
		}));
	}

	activeTurnsForAccount(accountKey) {
		return this.database.prepare(`
			SELECT context_id AS contextId, turn_id AS turnId, status
			FROM scoped_app_turns
			WHERE account_key = ? AND status IN ('queued', 'running')
			ORDER BY created_at
		`).all(accountKey).map((turn) => ({
			contextId: turn.contextId,
			turnId: turn.turnId,
			status: turn.status,
		}));
	}

	activeTurnsForMembership(accountKey, membershipKey, maximumVersion) {
		return this.database.prepare(`
			SELECT context_id AS contextId, turn_id AS turnId, status
			FROM scoped_app_turns
			WHERE account_key = ? AND membership_key = ? AND membership_version <= ?
				AND status IN ('queued', 'running')
		`).all(accountKey, membershipKey, maximumVersion).map((turn) => ({
			contextId: turn.contextId,
			turnId: turn.turnId,
			status: turn.status,
		}));
	}

	recoverInterruptedTurns() {
		return this.transaction(() => {
			const turns = this.database.prepare(`
				SELECT context_id AS contextId, turn_id AS turnId
				FROM scoped_app_turns WHERE status IN ('queued', 'running')
			`).all();
			for (const turn of turns) {
				this.database.prepare(`
					UPDATE scoped_app_turns
					SET status = 'failed', scope_json = NULL, last_error = 'host_restart',
						updated_at = ?, completed_at = ?
					WHERE context_id = ? AND turn_id = ?
				`).run(now(), now(), turn.contextId, turn.turnId);
				this.appendEventUnlocked(turn.contextId, turn.turnId, "status", undefined, { status: "failed" });
			}
			return turns.map((turn) => ({ contextId: turn.contextId, turnId: turn.turnId }));
		});
	}
}
