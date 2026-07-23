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
		`);
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

	ensurePrincipal(principalHash) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO principals(id, created_at, last_seen_at) VALUES (?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
		`).run(principalHash, timestamp, timestamp);
		return this.database.prepare(`
			SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM principals WHERE id = ?
		`).get(principalHash);
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

	status() {
		return {
			lastSuccessfulPollAt: this.getMeta("gmail:last_successful_poll_at") ?? null,
			principals: this.database.prepare("SELECT COUNT(*) AS count FROM principals").get().count,
			projects: this.database.prepare("SELECT COUNT(*) AS count FROM projects").get().count,
			routes: this.database.prepare("SELECT COUNT(*) AS count FROM routes").get().count,
			contexts: this.database.prepare("SELECT COUNT(*) AS count FROM contexts").get().count,
			pendingEvents: this.database.prepare(`
				SELECT COUNT(*) AS count FROM events WHERE status IN ('pending', 'delivering', 'failed')
			`).get().count,
			completedEvents: this.database.prepare(`
				SELECT COUNT(*) AS count FROM events WHERE status = 'completed'
			`).get().count,
			completedOutbox: this.database.prepare(`
				SELECT COUNT(*) AS count FROM outbox WHERE status = 'completed'
			`).get().count,
		};
	}
}
