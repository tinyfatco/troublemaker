import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function now() {
	return new Date().toISOString();
}

export class HostStore {
	constructor(path) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.database = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			PRAGMA busy_timeout = 5000;

			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS seen_messages (
				source TEXT NOT NULL,
				provider_message_id TEXT NOT NULL,
				disposition TEXT NOT NULL,
				seen_at TEXT NOT NULL,
				PRIMARY KEY (source, provider_message_id)
			);

			CREATE TABLE IF NOT EXISTS principals (
				id TEXT PRIMARY KEY,
				email_address TEXT,
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS projects (
				principal_hash TEXT NOT NULL,
				slug TEXT NOT NULL,
				name TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				PRIMARY KEY (principal_hash, slug),
				FOREIGN KEY (principal_hash) REFERENCES principals(id)
			);

			CREATE TABLE IF NOT EXISTS routes (
				source TEXT NOT NULL,
				provider_thread_id TEXT NOT NULL,
				principal_hash TEXT NOT NULL,
				project_slug TEXT NOT NULL,
				target_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				PRIMARY KEY (source, provider_thread_id),
				FOREIGN KEY (principal_hash) REFERENCES principals(id)
			);

			CREATE TABLE IF NOT EXISTS contexts (
				id TEXT PRIMARY KEY,
				target_id TEXT NOT NULL,
				driver TEXT NOT NULL,
				runtime_name TEXT,
				port INTEGER,
				status TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL
			);

			CREATE UNIQUE INDEX IF NOT EXISTS contexts_port_unique
				ON contexts(port) WHERE port IS NOT NULL;

			CREATE TABLE IF NOT EXISTS mattermost_bindings (
				context_id TEXT PRIMARY KEY,
				team_id TEXT NOT NULL,
				channel_id TEXT NOT NULL UNIQUE,
				bot_user_id TEXT NOT NULL UNIQUE,
				bot_username TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				FOREIGN KEY (context_id) REFERENCES contexts(id)
			);

			CREATE TABLE IF NOT EXISTS events (
				id TEXT PRIMARY KEY,
				source TEXT NOT NULL,
				provider_message_id TEXT NOT NULL,
				provider_thread_id TEXT NOT NULL,
				principal_hash TEXT NOT NULL,
				target_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				received_at TEXT NOT NULL,
				completed_at TEXT,
				UNIQUE (source, provider_message_id)
			);

			CREATE TABLE IF NOT EXISTS outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				idempotency_key TEXT NOT NULL UNIQUE,
				target_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				provider_thread_id TEXT NOT NULL,
				status TEXT NOT NULL,
				provider_message_id TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				completed_at TEXT
			);

			CREATE TABLE IF NOT EXISTS gmail_drafts (
				provider_draft_id TEXT PRIMARY KEY,
				target_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				principal_hash TEXT NOT NULL,
				contact_address TEXT NOT NULL,
				mode TEXT NOT NULL,
				provider_thread_id TEXT NOT NULL,
				reply_to_message_id TEXT,
				subject TEXT NOT NULL,
				body_sha256 TEXT NOT NULL,
				status TEXT NOT NULL,
				provider_message_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				sent_at TEXT
			);

			CREATE INDEX IF NOT EXISTS gmail_drafts_context
				ON gmail_drafts(context_id, status, updated_at);

			CREATE TABLE IF NOT EXISTS gmail_tool_requests (
				idempotency_key TEXT PRIMARY KEY,
				action TEXT NOT NULL,
				target_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				provider_draft_id TEXT,
				status TEXT NOT NULL,
				provider_message_id TEXT,
				provider_thread_id TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				completed_at TEXT
			);
		`);
		const principalColumns = this.database.prepare("PRAGMA table_info(principals)").all();
		if (!principalColumns.some((column) => column.name === "email_address")) {
			this.database.exec("ALTER TABLE principals ADD COLUMN email_address TEXT");
		}
	}

	close() {
		this.database.close();
	}

	getMeta(key) {
		return this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
	}

	setMeta(key, value) {
		this.database.prepare(`
			INSERT INTO meta(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run(key, String(value));
	}

	hasSeen(source, messageId) {
		return Boolean(this.database.prepare(`
			SELECT 1 FROM seen_messages WHERE source = ? AND provider_message_id = ?
		`).get(source, messageId));
	}

	markSeen(source, messageId, disposition) {
		this.database.prepare(`
			INSERT INTO seen_messages(source, provider_message_id, disposition, seen_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(source, provider_message_id) DO UPDATE SET
				disposition = excluded.disposition,
				seen_at = excluded.seen_at
		`).run(source, messageId, disposition, now());
	}

	importSeen(source, messageIds) {
		const insert = this.database.prepare(`
			INSERT OR IGNORE INTO seen_messages(source, provider_message_id, disposition, seen_at)
			VALUES (?, ?, 'legacy', ?)
		`);
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const timestamp = now();
			for (const messageId of messageIds) insert.run(source, messageId, timestamp);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	ensurePrincipal(principalHash, emailAddress) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO principals(id, email_address, created_at, last_seen_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				email_address = COALESCE(principals.email_address, excluded.email_address),
				last_seen_at = excluded.last_seen_at
		`).run(principalHash, emailAddress ?? null, timestamp, timestamp);
		return this.database.prepare(`
			SELECT id, email_address AS emailAddress,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM principals WHERE id = ?
		`).get(principalHash);
	}

	setPrincipalEmail(principalHash, emailAddress) {
		const current = this.ensurePrincipal(principalHash);
		if (current.emailAddress && current.emailAddress !== emailAddress) {
			throw new Error("principal contact cannot be changed");
		}
		this.database.prepare(`
			UPDATE principals SET email_address = ?, last_seen_at = ? WHERE id = ?
		`).run(emailAddress, now(), principalHash);
		return this.ensurePrincipal(principalHash);
	}

	ensureProject(principalHash, slug, name) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO projects(principal_hash, slug, name, created_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(principal_hash, slug) DO UPDATE SET
				name = excluded.name,
				last_seen_at = excluded.last_seen_at
		`).run(principalHash, slug, name, timestamp, timestamp);
		return this.database.prepare(`
			SELECT principal_hash AS principalHash, slug, name,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM projects WHERE principal_hash = ? AND slug = ?
		`).get(principalHash, slug);
	}

	listProjects(principalHash) {
		return this.database.prepare(`
			SELECT principal_hash AS principalHash, slug, name,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM projects WHERE principal_hash = ? ORDER BY slug
		`).all(principalHash);
	}

	getContextScope(contextId, targetId) {
		const rows = this.database.prepare(`
			SELECT DISTINCT r.principal_hash AS principalHash,
				p.email_address AS emailAddress, r.project_slug AS projectSlug
			FROM routes r
			JOIN principals p ON p.id = r.principal_hash
			WHERE r.context_id = ? AND r.target_id = ?
			ORDER BY r.principal_hash, r.project_slug
		`).all(contextId, targetId);
		if (rows.length === 0) return undefined;
		const principalHashes = new Set(rows.map((row) => row.principalHash));
		if (principalHashes.size !== 1) throw new Error("context has inconsistent principal scope");
		return rows[0];
	}

	listRoutesForContext(contextId, targetId) {
		return this.database.prepare(`
			SELECT source, provider_thread_id AS providerThreadId,
				principal_hash AS principalHash, project_slug AS projectSlug,
				target_id AS targetId, context_id AS contextId,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM routes WHERE context_id = ? AND target_id = ?
			ORDER BY last_seen_at DESC
		`).all(contextId, targetId);
	}

	getRoute(source, threadId) {
		return this.database.prepare(`
			SELECT source, provider_thread_id AS providerThreadId,
				principal_hash AS principalHash, project_slug AS projectSlug,
				target_id AS targetId,
				context_id AS contextId, created_at AS createdAt,
				last_seen_at AS lastSeenAt
			FROM routes WHERE source = ? AND provider_thread_id = ?
		`).get(source, threadId);
	}

	bindRoute({ source, providerThreadId, principalHash, projectSlug, targetId, contextId }) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO routes(
				source, provider_thread_id, principal_hash, project_slug,
				target_id, context_id, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(source, provider_thread_id) DO UPDATE SET
				last_seen_at = excluded.last_seen_at
		`).run(
			source,
			providerThreadId,
			principalHash,
			projectSlug,
			targetId,
			contextId,
			timestamp,
			timestamp,
		);
		return this.getRoute(source, providerThreadId);
	}

	touchRoute(source, threadId) {
		this.database.prepare(`
			UPDATE routes SET last_seen_at = ? WHERE source = ? AND provider_thread_id = ?
		`).run(now(), source, threadId);
	}

	getContext(id) {
		return this.database.prepare(`
			SELECT id, target_id AS targetId, driver, runtime_name AS runtimeName,
				port, status, created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM contexts WHERE id = ?
		`).get(id);
	}

	listContexts() {
		return this.database.prepare(`
			SELECT id, target_id AS targetId, driver, runtime_name AS runtimeName,
				port, status, created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM contexts ORDER BY created_at
		`).all();
	}

	createContext({ id, targetId, driver, runtimeName, port, status = "stopped" }) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO contexts(id, target_id, driver, runtime_name, port, status, created_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(id, targetId, driver, runtimeName ?? null, port ?? null, status, timestamp, timestamp);
		return this.getContext(id);
	}

	updateContext(id, updates) {
		const current = this.getContext(id);
		if (!current) throw new Error(`unknown context ${id}`);
		this.database.prepare(`
			UPDATE contexts SET runtime_name = ?, port = ?, status = ?, last_seen_at = ? WHERE id = ?
		`).run(
			updates.runtimeName ?? current.runtimeName ?? null,
			updates.port ?? current.port ?? null,
			updates.status ?? current.status,
			now(),
			id,
		);
		return this.getContext(id);
	}

	getMattermostBinding(contextId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, team_id AS teamId, channel_id AS channelId,
				bot_user_id AS botUserId, bot_username AS botUsername,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM mattermost_bindings WHERE context_id = ?
		`).get(contextId);
	}

	upsertMattermostBinding({ contextId, teamId, channelId, botUserId, botUsername }) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO mattermost_bindings(
				context_id, team_id, channel_id, bot_user_id, bot_username,
				created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(context_id) DO UPDATE SET
				team_id = excluded.team_id,
				channel_id = excluded.channel_id,
				bot_user_id = excluded.bot_user_id,
				bot_username = excluded.bot_username,
				last_seen_at = excluded.last_seen_at
		`).run(
			contextId,
			teamId,
			channelId,
			botUserId,
			botUsername,
			timestamp,
			timestamp,
		);
		return this.getMattermostBinding(contextId);
	}

	nextAvailablePort(basePort, maxPort) {
		const rows = this.database.prepare(`
			SELECT port FROM contexts WHERE port BETWEEN ? AND ? ORDER BY port
		`).all(basePort, maxPort);
		const used = new Set(rows.map((row) => row.port));
		for (let port = basePort; port <= maxPort; port++) {
			if (!used.has(port)) return port;
		}
		throw new Error(`no context ports available from ${basePort} to ${maxPort}`);
	}

	getEventByProviderMessage(source, messageId) {
		return this.database.prepare(`
			SELECT id, source, provider_message_id AS providerMessageId,
				provider_thread_id AS providerThreadId, principal_hash AS principalHash,
				target_id AS targetId, context_id AS contextId, status, attempts,
				last_error AS lastError, received_at AS receivedAt, completed_at AS completedAt
			FROM events WHERE source = ? AND provider_message_id = ?
		`).get(source, messageId);
	}

	listRetryableEvents() {
		return this.database.prepare(`
			SELECT id, source, provider_message_id AS providerMessageId,
				provider_thread_id AS providerThreadId, principal_hash AS principalHash,
				target_id AS targetId, context_id AS contextId, status, attempts,
				last_error AS lastError, received_at AS receivedAt, completed_at AS completedAt
			FROM events WHERE status IN ('pending', 'delivering', 'failed')
			ORDER BY received_at
		`).all();
	}

	upsertEvent(event) {
		this.database.prepare(`
			INSERT INTO events(
				id, source, provider_message_id, provider_thread_id,
				principal_hash, target_id, context_id, status, received_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
			ON CONFLICT(source, provider_message_id) DO NOTHING
		`).run(
			event.id,
			event.source,
			event.providerMessageId,
			event.providerThreadId,
			event.principalHash,
			event.targetId,
			event.contextId,
			now(),
		);
		return this.getEventByProviderMessage(event.source, event.providerMessageId);
	}

	startEvent(id) {
		this.database.prepare(`
			UPDATE events SET status = 'delivering', attempts = attempts + 1, last_error = NULL
			WHERE id = ?
		`).run(id);
	}

	completeEvent(id) {
		this.database.prepare(`
			UPDATE events SET status = 'completed', completed_at = ?, last_error = NULL WHERE id = ?
		`).run(now(), id);
	}

	failEvent(id, error) {
		this.database.prepare(`
			UPDATE events SET status = 'failed', last_error = ? WHERE id = ?
		`).run(String(error).slice(0, 1000), id);
	}

	getOutbox(idempotencyKey) {
		return this.database.prepare(`
			SELECT id, idempotency_key AS idempotencyKey, target_id AS targetId,
				context_id AS contextId, provider_thread_id AS providerThreadId,
				status, provider_message_id AS providerMessageId, last_error AS lastError,
				created_at AS createdAt, completed_at AS completedAt
			FROM outbox WHERE idempotency_key = ?
		`).get(idempotencyKey);
	}

	startOutbox({ idempotencyKey, targetId, contextId, providerThreadId }) {
		this.database.prepare(`
			INSERT INTO outbox(
				idempotency_key, target_id, context_id, provider_thread_id, status, created_at
			) VALUES (?, ?, ?, ?, 'sending', ?)
			ON CONFLICT(idempotency_key) DO NOTHING
		`).run(idempotencyKey, targetId, contextId, providerThreadId, now());
		return this.getOutbox(idempotencyKey);
	}

	completeOutbox(idempotencyKey, providerMessageId) {
		this.database.prepare(`
			UPDATE outbox SET status = 'completed', provider_message_id = ?,
				completed_at = ?, last_error = NULL
			WHERE idempotency_key = ?
		`).run(providerMessageId, now(), idempotencyKey);
		return this.getOutbox(idempotencyKey);
	}

	failOutbox(idempotencyKey, error) {
		this.database.prepare(`
			UPDATE outbox SET status = 'failed', last_error = ? WHERE idempotency_key = ?
		`).run(String(error).slice(0, 1000), idempotencyKey);
	}

	getGmailDraft(providerDraftId) {
		return this.database.prepare(`
			SELECT provider_draft_id AS providerDraftId, target_id AS targetId,
				context_id AS contextId, principal_hash AS principalHash,
				contact_address AS contactAddress, mode,
				provider_thread_id AS providerThreadId,
				reply_to_message_id AS replyToMessageId, subject,
				body_sha256 AS bodySha256, status,
				provider_message_id AS providerMessageId,
				created_at AS createdAt, updated_at AS updatedAt, sent_at AS sentAt
			FROM gmail_drafts WHERE provider_draft_id = ?
		`).get(providerDraftId);
	}

	getGmailRequest(idempotencyKey) {
		return this.database.prepare(`
			SELECT idempotency_key AS idempotencyKey, action,
				target_id AS targetId, context_id AS contextId,
				provider_draft_id AS providerDraftId, status,
				provider_message_id AS providerMessageId,
				provider_thread_id AS providerThreadId,
				last_error AS lastError, created_at AS createdAt,
				completed_at AS completedAt
			FROM gmail_tool_requests WHERE idempotency_key = ?
		`).get(idempotencyKey);
	}

	startGmailRequest({ idempotencyKey, action, targetId, contextId, providerDraftId }) {
		this.database.prepare(`
			INSERT INTO gmail_tool_requests(
				idempotency_key, action, target_id, context_id,
				provider_draft_id, status, created_at
			) VALUES (?, ?, ?, ?, ?, 'running', ?)
			ON CONFLICT(idempotency_key) DO NOTHING
		`).run(idempotencyKey, action, targetId, contextId, providerDraftId ?? null, now());
		return this.getGmailRequest(idempotencyKey);
	}

	completeGmailDraftCreate(idempotencyKey, draft) {
		const timestamp = now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database.prepare(`
				INSERT INTO gmail_drafts(
					provider_draft_id, target_id, context_id, principal_hash,
					contact_address, mode, provider_thread_id,
					reply_to_message_id, subject, body_sha256, status,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
			`).run(
				draft.providerDraftId,
				draft.targetId,
				draft.contextId,
				draft.principalHash,
				draft.contactAddress,
				draft.mode,
				draft.providerThreadId,
				draft.replyToMessageId ?? null,
				draft.subject,
				draft.bodySha256,
				timestamp,
				timestamp,
			);
			this.database.prepare(`
				UPDATE gmail_tool_requests SET status = 'completed',
					provider_draft_id = ?, provider_thread_id = ?,
					completed_at = ?, last_error = NULL
				WHERE idempotency_key = ?
			`).run(draft.providerDraftId, draft.providerThreadId, timestamp, idempotencyKey);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
		return this.getGmailDraft(draft.providerDraftId);
	}

	completeGmailDraftUpdate(idempotencyKey, providerDraftId, bodySha256, providerThreadId) {
		const timestamp = now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database.prepare(`
				UPDATE gmail_drafts SET body_sha256 = ?, provider_thread_id = ?,
					updated_at = ?
				WHERE provider_draft_id = ? AND status = 'draft'
			`).run(bodySha256, providerThreadId, timestamp, providerDraftId);
			this.database.prepare(`
				UPDATE gmail_tool_requests SET status = 'completed',
					provider_draft_id = ?, provider_thread_id = ?,
					completed_at = ?, last_error = NULL
				WHERE idempotency_key = ?
			`).run(providerDraftId, providerThreadId, timestamp, idempotencyKey);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
		return this.getGmailDraft(providerDraftId);
	}

	markGmailDraftSending(providerDraftId) {
		const result = this.database.prepare(`
			UPDATE gmail_drafts SET status = 'sending', updated_at = ?
			WHERE provider_draft_id = ? AND status = 'draft'
		`).run(now(), providerDraftId);
		return result.changes === 1 ? this.getGmailDraft(providerDraftId) : undefined;
	}

	completeGmailDraftSend(idempotencyKey, providerDraftId, providerMessageId, providerThreadId) {
		const timestamp = now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database.prepare(`
				UPDATE gmail_drafts SET status = 'sent', provider_message_id = ?,
					provider_thread_id = ?, updated_at = ?, sent_at = ?
				WHERE provider_draft_id = ?
			`).run(providerMessageId, providerThreadId, timestamp, timestamp, providerDraftId);
			this.database.prepare(`
				UPDATE gmail_tool_requests SET status = 'completed',
					provider_draft_id = ?, provider_message_id = ?,
					provider_thread_id = ?, completed_at = ?, last_error = NULL
				WHERE idempotency_key = ?
			`).run(providerDraftId, providerMessageId, providerThreadId, timestamp, idempotencyKey);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
		return this.getGmailDraft(providerDraftId);
	}

	failGmailRequest(idempotencyKey, error) {
		this.database.prepare(`
			UPDATE gmail_tool_requests SET status = 'failed', last_error = ?
			WHERE idempotency_key = ?
		`).run(String(error).slice(0, 1000), idempotencyKey);
	}

	markGmailDraftUncertain(providerDraftId) {
		this.database.prepare(`
			UPDATE gmail_drafts SET status = 'uncertain', updated_at = ?
			WHERE provider_draft_id = ? AND status = 'sending'
		`).run(now(), providerDraftId);
		return this.getGmailDraft(providerDraftId);
	}

	status() {
		return {
			lastSuccessfulPollAt: this.getMeta("gmail:last_successful_poll_at") ?? null,
			principals: this.database.prepare("SELECT COUNT(*) AS count FROM principals").get().count,
			projects: this.database.prepare("SELECT COUNT(*) AS count FROM projects").get().count,
			routes: this.database.prepare("SELECT COUNT(*) AS count FROM routes").get().count,
			contexts: this.database.prepare("SELECT COUNT(*) AS count FROM contexts").get().count,
			mattermostBindings: this.database.prepare("SELECT COUNT(*) AS count FROM mattermost_bindings").get().count,
			pendingEvents: this.database.prepare(`
				SELECT COUNT(*) AS count FROM events WHERE status IN ('pending', 'delivering', 'failed')
			`).get().count,
			completedEvents: this.database.prepare(`
				SELECT COUNT(*) AS count FROM events WHERE status = 'completed'
			`).get().count,
			completedOutbox: this.database.prepare(`
				SELECT COUNT(*) AS count FROM outbox WHERE status = 'completed'
			`).get().count,
			gmailDrafts: this.database.prepare(`
				SELECT COUNT(*) AS count FROM gmail_drafts WHERE status = 'draft'
			`).get().count,
			gmailSentDrafts: this.database.prepare(`
				SELECT COUNT(*) AS count FROM gmail_drafts WHERE status = 'sent'
			`).get().count,
		};
	}
}
