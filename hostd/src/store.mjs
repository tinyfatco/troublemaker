import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

function now() {
	return new Date().toISOString();
}

function future(seconds) {
	return new Date(Date.now() + seconds * 1000).toISOString();
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
				display_label TEXT,
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

			CREATE TABLE IF NOT EXISTS route_participants (
				source TEXT NOT NULL,
				provider_thread_id TEXT NOT NULL,
				principal_hash TEXT NOT NULL,
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				PRIMARY KEY (source, provider_thread_id, principal_hash),
				FOREIGN KEY (source, provider_thread_id)
					REFERENCES routes(source, provider_thread_id)
					ON DELETE CASCADE
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

			CREATE TABLE IF NOT EXISTS rocket_chat_bindings (
					context_id TEXT PRIMARY KEY,
					contact_id TEXT UNIQUE,
					room_id TEXT NOT NULL UNIQUE,
					room_name TEXT NOT NULL UNIQUE,
					bot_user_id TEXT UNIQUE,
					bot_username TEXT UNIQUE,
					channel_display_name TEXT,
				attention_mode TEXT NOT NULL DEFAULT 'ambient',
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				FOREIGN KEY (context_id) REFERENCES contexts(id)
			);

			CREATE TABLE IF NOT EXISTS zulip_bindings (
				context_id TEXT PRIMARY KEY,
				channel_id INTEGER NOT NULL UNIQUE,
				channel_name TEXT NOT NULL UNIQUE,
				agent_user_id INTEGER NOT NULL,
				projector_user_id INTEGER NOT NULL,
				attention_mode TEXT NOT NULL DEFAULT 'ambient',
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				FOREIGN KEY (context_id) REFERENCES contexts(id)
			);

			CREATE TABLE IF NOT EXISTS rocket_chat_omnichannel_conversations (
				context_id TEXT NOT NULL,
				source TEXT NOT NULL,
				provider_thread_id TEXT NOT NULL,
				visitor_token TEXT NOT NULL,
				visitor_id TEXT NOT NULL,
				contact_id TEXT NOT NULL,
				room_id TEXT NOT NULL UNIQUE,
				status TEXT NOT NULL DEFAULT 'open',
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				PRIMARY KEY (source, provider_thread_id),
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
				awareness_sequence INTEGER,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				last_error TEXT,
				received_at TEXT NOT NULL,
				completed_at TEXT,
				UNIQUE (source, provider_message_id)
			);

			CREATE TABLE IF NOT EXISTS scheduled_prompts (
				context_id TEXT NOT NULL,
				target_id TEXT NOT NULL,
				filename TEXT NOT NULL,
				source_sha256 TEXT NOT NULL,
				generation INTEGER NOT NULL,
				kind TEXT NOT NULL,
				status TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				canonical_slot_at TEXT,
				next_fire_at TEXT,
				last_indexed_at TEXT NOT NULL,
				last_materialized_at TEXT,
				last_error TEXT,
				archive_outcome TEXT,
				archived_at TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (context_id, filename),
				FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
			);

			CREATE INDEX IF NOT EXISTS scheduled_prompts_due_index
				ON scheduled_prompts(status, next_fire_at);

			CREATE TABLE IF NOT EXISTS outbox (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				idempotency_key TEXT NOT NULL UNIQUE,
				target_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				provider_thread_id TEXT NOT NULL,
				body_sha256 TEXT,
				status TEXT NOT NULL,
				provider_message_id TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				completed_at TEXT
			);

			CREATE TABLE IF NOT EXISTS phone_conversations (
				thread_target TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				provider_thread_id TEXT NOT NULL UNIQUE,
				principal_hash TEXT NOT NULL,
				target_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				contact_ciphertext TEXT NOT NULL,
				contact_last_four TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'active',
				created_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				FOREIGN KEY (principal_hash) REFERENCES principals(id)
			);

			CREATE TABLE IF NOT EXISTS phone_opt_outs (
				principal_hash TEXT PRIMARY KEY,
				opted_out INTEGER NOT NULL,
				observed_at TEXT NOT NULL,
				FOREIGN KEY (principal_hash) REFERENCES principals(id)
			);

			CREATE TABLE IF NOT EXISTS relationship_attributions (
				claim_key TEXT PRIMARY KEY,
				source TEXT NOT NULL,
				campaign_id TEXT NOT NULL,
				relationship_key TEXT NOT NULL,
				observed_at TEXT NOT NULL,
				UNIQUE(source, campaign_id, relationship_key)
			);

			CREATE TABLE IF NOT EXISTS relationship_event_outbox (
				idempotency_key TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				relationship_key TEXT NOT NULL,
				payload_json TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending'
					CHECK(status IN ('pending', 'sending', 'retry', 'delivered', 'terminal')),
				attempts INTEGER NOT NULL DEFAULT 0,
				available_at TEXT NOT NULL,
				lease_expires_at TEXT,
				receipt_id TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				delivered_at TEXT,
				UNIQUE(kind, relationship_key)
			);

			CREATE INDEX IF NOT EXISTS relationship_event_outbox_due
				ON relationship_event_outbox(kind, status, available_at);

			CREATE TABLE IF NOT EXISTS gmail_drafts (
				provider_draft_id TEXT PRIMARY KEY,
				target_id TEXT NOT NULL,
				context_id TEXT NOT NULL,
				principal_hash TEXT NOT NULL,
				contact_address TEXT NOT NULL,
				to_addresses_json TEXT NOT NULL DEFAULT '[]',
				cc_addresses_json TEXT NOT NULL DEFAULT '[]',
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

			CREATE TABLE IF NOT EXISTS control_notifications (
				id TEXT PRIMARY KEY,
				event_id TEXT NOT NULL UNIQUE,
				context_id TEXT NOT NULL,
				sequence INTEGER,
				status TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				available_at TEXT NOT NULL,
				provider_post_id TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT,
				FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS awareness_sequences (
				context_id TEXT PRIMARY KEY,
				last_sequence INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS rocket_chat_posts (
				event_id TEXT PRIMARY KEY,
				context_id TEXT NOT NULL,
				sequence INTEGER NOT NULL,
				thread_id TEXT,
				text_sha256 TEXT NOT NULL,
				status TEXT NOT NULL,
				provider_message_id TEXT,
				last_error TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				completed_at TEXT,
				UNIQUE(context_id, sequence),
				FOREIGN KEY (context_id) REFERENCES contexts(id)
			);
		`);
		this.migrate();
	}

	migrate() {
		const columns = (table) => new Set(
			this.database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
		);
		const add = (table, definition) => {
			const name = definition.split(/\s+/, 1)[0];
			if (!columns(table).has(name)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
		};
		add("principals", "email_address TEXT");
		add("principals", "display_label TEXT");
		add("contexts", "last_started_at TEXT");
		add("contexts", "last_stopped_at TEXT");
		add("contexts", "runtime_version TEXT");
		add("mattermost_bindings", "attention_mode TEXT NOT NULL DEFAULT 'ambient'");
			add("mattermost_bindings", "channel_display_name TEXT");
			add("rocket_chat_bindings", "contact_id TEXT");
			add("rocket_chat_bindings", "bot_user_id TEXT");
			add("rocket_chat_bindings", "bot_username TEXT");
		add("control_notifications", "sequence INTEGER");
		add("events", "awareness_sequence INTEGER");
		add("events", "payload_json TEXT");
		add("events", "available_at TEXT");
		add("events", "lease_token TEXT");
		add("events", "lease_expires_at TEXT");
		add("events", "accepted_at TEXT");
		add("events", "started_at TEXT");
		add("events", "updated_at TEXT");
		add("outbox", "body_sha256 TEXT");
		add("gmail_drafts", "to_addresses_json TEXT NOT NULL DEFAULT '[]'");
		add("gmail_drafts", "cc_addresses_json TEXT NOT NULL DEFAULT '[]'");
		const legacyDraftRecipients = this.database.prepare(`
			SELECT provider_draft_id AS providerDraftId, contact_address AS contactAddress
			FROM gmail_drafts WHERE to_addresses_json = '[]'
		`).all();
		const bindLegacyDraftRecipient = this.database.prepare(`
			UPDATE gmail_drafts SET to_addresses_json = ? WHERE provider_draft_id = ?
		`);
		for (const draft of legacyDraftRecipients) {
			bindLegacyDraftRecipient.run(JSON.stringify([draft.contactAddress]), draft.providerDraftId);
		}
		this.database.exec(`
			UPDATE events SET status = 'queued' WHERE status = 'pending';
			UPDATE events SET status = 'queued', lease_token = NULL, lease_expires_at = NULL
				WHERE status = 'delivering';
			UPDATE events SET available_at = COALESCE(available_at, received_at),
				updated_at = COALESCE(updated_at, received_at);
			UPDATE events AS event
			SET awareness_sequence = (
				SELECT COUNT(*)
				FROM events AS prior
				WHERE prior.context_id = event.context_id
					AND (
						prior.received_at < event.received_at
						OR (prior.received_at = event.received_at AND prior.id <= event.id)
					)
			)
			WHERE awareness_sequence IS NULL;
			UPDATE events SET status = 'dead',
				last_error = 'legacy event has no durable payload'
				WHERE payload_json IS NULL AND status IN ('queued', 'failed');
			INSERT OR IGNORE INTO route_participants(
				source, provider_thread_id, principal_hash, created_at, last_seen_at
			)
			SELECT source, provider_thread_id, principal_hash, created_at, last_seen_at
			FROM routes;
			CREATE INDEX IF NOT EXISTS events_dispatch_index
				ON events(status, available_at, received_at);
			CREATE INDEX IF NOT EXISTS events_context_status_index
				ON events(context_id, status);
			UPDATE control_notifications SET status = 'queued', available_at = updated_at
				WHERE status = 'sending';
			UPDATE control_notifications AS notification
			SET sequence = (
				SELECT event.awareness_sequence FROM events AS event
				WHERE event.id = notification.event_id
			);
			INSERT INTO awareness_sequences(context_id, last_sequence)
			SELECT context_id, MAX(awareness_sequence)
			FROM events
			WHERE awareness_sequence IS NOT NULL
			GROUP BY context_id
			ON CONFLICT(context_id) DO UPDATE SET
				last_sequence = MAX(last_sequence, excluded.last_sequence);
			CREATE INDEX IF NOT EXISTS control_notifications_dispatch_index
				ON control_notifications(status, available_at, created_at);
			CREATE UNIQUE INDEX IF NOT EXISTS control_notifications_context_sequence
				ON control_notifications(context_id, sequence);
			CREATE UNIQUE INDEX IF NOT EXISTS events_context_awareness_sequence
				ON events(context_id, awareness_sequence);
			UPDATE rocket_chat_posts SET status = 'failed',
				last_error = COALESCE(last_error, 'host restarted during Rocket.Chat post')
				WHERE status = 'sending';
				CREATE UNIQUE INDEX IF NOT EXISTS rocket_chat_bindings_contact
					ON rocket_chat_bindings(contact_id) WHERE contact_id IS NOT NULL;
				CREATE UNIQUE INDEX IF NOT EXISTS rocket_chat_bindings_bot_user
					ON rocket_chat_bindings(bot_user_id) WHERE bot_user_id IS NOT NULL;
				CREATE UNIQUE INDEX IF NOT EXISTS rocket_chat_bindings_bot_username
					ON rocket_chat_bindings(bot_username) WHERE bot_username IS NOT NULL;
			CREATE INDEX IF NOT EXISTS gmail_drafts_context
				ON gmail_drafts(context_id, status, updated_at);
			CREATE INDEX IF NOT EXISTS phone_conversations_context
				ON phone_conversations(context_id, last_seen_at);
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

	ensurePrincipal(principalHash, emailAddress, displayLabel) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO principals(
				id, email_address, display_label, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				email_address = COALESCE(principals.email_address, excluded.email_address),
				display_label = COALESCE(principals.display_label, excluded.display_label),
				last_seen_at = excluded.last_seen_at
		`).run(
			principalHash,
			emailAddress ?? null,
			displayLabel ?? null,
			timestamp,
			timestamp,
		);
		return this.database.prepare(`
			SELECT id, email_address AS emailAddress, display_label AS displayLabel,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM principals WHERE id = ?
		`).get(principalHash);
	}

	getPrincipal(principalHash) {
		return this.database.prepare(`
			SELECT id, email_address AS emailAddress, display_label AS displayLabel,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM principals WHERE id = ?
		`).get(principalHash);
	}

	setPrincipalLabel(principalHash, displayLabel) {
		const current = this.ensurePrincipal(principalHash);
		if (current.displayLabel) return current;
		this.database.prepare(`
			UPDATE principals SET display_label = ?, last_seen_at = ? WHERE id = ?
		`).run(displayLabel, now(), principalHash);
		return this.getPrincipal(principalHash);
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
				p.email_address AS emailAddress, p.display_label AS displayLabel,
				r.project_slug AS projectSlug
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
		this.database.exec("BEGIN IMMEDIATE");
		try {
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
			this.database.prepare(`
				INSERT INTO route_participants(
					source, provider_thread_id, principal_hash, created_at, last_seen_at
				) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(source, provider_thread_id, principal_hash) DO UPDATE SET
					last_seen_at = excluded.last_seen_at
			`).run(source, providerThreadId, principalHash, timestamp, timestamp);
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
		return this.getRoute(source, providerThreadId);
	}

	hasRouteParticipant(source, providerThreadId, principalHash) {
		return Boolean(this.database.prepare(`
			SELECT 1 FROM route_participants
			WHERE source = ? AND provider_thread_id = ? AND principal_hash = ?
		`).get(source, providerThreadId, principalHash));
	}

	touchRouteParticipant(source, providerThreadId, principalHash) {
		this.database.prepare(`
			UPDATE route_participants SET last_seen_at = ?
			WHERE source = ? AND provider_thread_id = ? AND principal_hash = ?
		`).run(now(), source, providerThreadId, principalHash);
	}

	addRouteParticipant(source, providerThreadId, principalHash) {
		const route = this.getRoute(source, providerThreadId);
		if (!route) throw new Error("cannot add a participant to an unknown route");
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO route_participants(
				source, provider_thread_id, principal_hash, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(source, provider_thread_id, principal_hash) DO UPDATE SET
				last_seen_at = excluded.last_seen_at
		`).run(source, providerThreadId, principalHash, timestamp, timestamp);
	}

	getRouteForContext(contextId) {
		return this.database.prepare(`
			SELECT source, provider_thread_id AS providerThreadId,
				principal_hash AS principalHash, project_slug AS projectSlug,
				target_id AS targetId, context_id AS contextId,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM routes WHERE context_id = ? ORDER BY last_seen_at DESC LIMIT 1
		`).get(contextId);
	}

	getPhoneConversation(threadTarget) {
		return this.database.prepare(`
			SELECT thread_target AS threadTarget, provider,
				provider_thread_id AS providerThreadId,
				principal_hash AS principalHash, target_id AS targetId,
				context_id AS contextId, contact_ciphertext AS contactCiphertext,
				contact_last_four AS contactLastFour, status,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM phone_conversations WHERE thread_target = ?
		`).get(threadTarget);
	}

	getPhoneConversationByProviderThread(providerThreadId) {
		return this.database.prepare(`
			SELECT thread_target AS threadTarget, provider,
				provider_thread_id AS providerThreadId,
				principal_hash AS principalHash, target_id AS targetId,
				context_id AS contextId, contact_ciphertext AS contactCiphertext,
				contact_last_four AS contactLastFour, status,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM phone_conversations WHERE provider_thread_id = ?
		`).get(providerThreadId);
	}

	upsertPhoneConversation({
		threadTarget,
		provider,
		providerThreadId,
		principalHash,
		targetId,
		contextId,
		contactCiphertext,
		contactLastFour,
	}) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO phone_conversations(
				thread_target, provider, provider_thread_id, principal_hash,
				target_id, context_id, contact_ciphertext, contact_last_four,
				status, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
			ON CONFLICT(thread_target) DO UPDATE SET
				last_seen_at = excluded.last_seen_at
		`).run(
			threadTarget,
			provider,
			providerThreadId,
			principalHash,
			targetId,
			contextId,
			contactCiphertext,
			contactLastFour,
			timestamp,
			timestamp,
		);
		const stored = this.getPhoneConversation(threadTarget);
		if (
			!stored
			|| stored.provider !== provider
			|| stored.providerThreadId !== providerThreadId
			|| stored.principalHash !== principalHash
			|| stored.targetId !== targetId
			|| stored.contextId !== contextId
			|| stored.contactCiphertext !== contactCiphertext
			|| stored.contactLastFour !== contactLastFour
		) {
			throw new Error("phone conversation conflicts with existing route");
		}
		return stored;
	}

	setPhoneOptOut(principalHash, optedOut) {
		this.database.prepare(`
			INSERT INTO phone_opt_outs(principal_hash, opted_out, observed_at)
			VALUES (?, ?, ?)
			ON CONFLICT(principal_hash) DO UPDATE SET
				opted_out = excluded.opted_out,
				observed_at = excluded.observed_at
		`).run(principalHash, optedOut ? 1 : 0, now());
	}

	isPhoneOptedOut(principalHash) {
		return this.database.prepare(`
			SELECT opted_out AS optedOut FROM phone_opt_outs WHERE principal_hash = ?
		`).get(principalHash)?.optedOut === 1;
	}

	getRelationshipEventOutbox(idempotencyKey) {
		return this.database.prepare(`
			SELECT idempotency_key AS idempotencyKey, kind,
				relationship_key AS relationshipKey, payload_json AS payloadJson,
				status, attempts, available_at AS availableAt,
				lease_expires_at AS leaseExpiresAt, receipt_id AS receiptId,
				last_error AS lastError, created_at AS createdAt,
				updated_at AS updatedAt, delivered_at AS deliveredAt
			FROM relationship_event_outbox WHERE idempotency_key = ?
		`).get(idempotencyKey);
	}

	listRelationshipEventOutbox() {
		return this.database.prepare(`
			SELECT idempotency_key AS idempotencyKey, kind,
				relationship_key AS relationshipKey, payload_json AS payloadJson,
				status, attempts, available_at AS availableAt,
				lease_expires_at AS leaseExpiresAt, receipt_id AS receiptId,
				last_error AS lastError, created_at AS createdAt,
				updated_at AS updatedAt, delivered_at AS deliveredAt
			FROM relationship_event_outbox ORDER BY created_at, idempotency_key
		`).all();
	}

	listRelationshipAttributions() {
		return this.database.prepare(`
			SELECT claim_key AS claimKey, source, campaign_id AS campaignId,
				relationship_key AS relationshipKey, observed_at AS observedAt
			FROM relationship_attributions ORDER BY observed_at, claim_key
		`).all();
	}

	insertRelationshipAttribution(record) {
		if (
			typeof record?.claimKey !== "string"
			|| !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,239}$/.test(record.claimKey)
		) throw new Error("relationship attribution claim key is invalid");
		if (
			typeof record.source !== "string"
			|| !/^[a-z][a-z0-9._-]{0,63}$/.test(record.source)
		) throw new Error("relationship attribution source is invalid");
		if (
			typeof record.campaignId !== "string"
			|| !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(record.campaignId)
		) throw new Error("relationship attribution campaign is invalid");
		if (
			typeof record.relationshipKey !== "string"
			|| !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,239}$/.test(record.relationshipKey)
		) throw new Error("relationship attribution key is invalid");
		if (
			typeof record.observedAt !== "string"
			|| !Number.isFinite(Date.parse(record.observedAt))
		) throw new Error("relationship attribution observation time is invalid");
		const result = this.database.prepare(`
			INSERT INTO relationship_attributions(
				claim_key, source, campaign_id, relationship_key, observed_at
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT DO NOTHING
		`).run(
			record.claimKey,
			record.source,
			record.campaignId,
			record.relationshipKey,
			record.observedAt,
		);
		return result.changes === 1;
	}

	insertRelationshipEventOutbox(record) {
		if (
			typeof record?.eventId !== "string"
			|| !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,239}$/.test(record.eventId)
		) throw new Error("relationship event ID is invalid");
		if (
			typeof record.kind !== "string"
			|| !/^[a-z][a-z0-9._-]{0,63}$/.test(record.kind)
		) throw new Error("relationship event kind is invalid");
		if (
			typeof record.relationshipKey !== "string"
			|| !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,239}$/.test(record.relationshipKey)
		) throw new Error("relationship event key is invalid");
		const payloadJson = JSON.stringify(record.payload);
		if (!payloadJson || Buffer.byteLength(payloadJson, "utf8") > 8 * 1024) {
			throw new Error("relationship event payload exceeds its privacy-safe limit");
		}
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO relationship_event_outbox(
				idempotency_key, kind, relationship_key, payload_json,
				status, attempts, available_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
			ON CONFLICT(kind, relationship_key) DO NOTHING
		`).run(
			record.eventId,
			record.kind,
			record.relationshipKey,
			payloadJson,
			timestamp,
			timestamp,
			timestamp,
		);
		return this.getRelationshipEventOutbox(record.eventId);
	}

	claimRelationshipEventOutbox({ kind, maximumAttempts = 12, leaseSeconds = 60 }) {
		const timestamp = now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database.prepare(`
				UPDATE relationship_event_outbox
				SET status = CASE WHEN attempts >= ? THEN 'terminal' ELSE 'retry' END,
					available_at = ?, lease_expires_at = NULL,
					last_error = COALESCE(last_error, 'delivery lease expired'), updated_at = ?
				WHERE kind = ? AND status = 'sending' AND lease_expires_at <= ?
				`).run(maximumAttempts, timestamp, timestamp, kind, timestamp);
				this.database.prepare(`
					UPDATE relationship_event_outbox
					SET status = 'terminal', available_at = ?, lease_expires_at = NULL,
						last_error = COALESCE(last_error, 'maximum delivery attempts exhausted'),
						updated_at = ?
					WHERE kind = ? AND status IN ('pending', 'retry') AND attempts >= ?
				`).run(timestamp, timestamp, kind, maximumAttempts);
				const due = this.database.prepare(`
				SELECT idempotency_key AS idempotencyKey
				FROM relationship_event_outbox
				WHERE kind = ? AND status IN ('pending', 'retry')
					AND attempts < ? AND available_at <= ?
				ORDER BY created_at, idempotency_key LIMIT 1
			`).get(kind, maximumAttempts, timestamp);
			if (!due) {
				this.database.exec("COMMIT");
				return undefined;
			}
			this.database.prepare(`
				UPDATE relationship_event_outbox
				SET status = 'sending', attempts = attempts + 1,
					lease_expires_at = ?, last_error = NULL, updated_at = ?
				WHERE idempotency_key = ?
			`).run(future(leaseSeconds), timestamp, due.idempotencyKey);
			this.database.exec("COMMIT");
			return this.getRelationshipEventOutbox(due.idempotencyKey);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	completeRelationshipEventOutbox(idempotencyKey, receiptId) {
		const timestamp = now();
		this.database.prepare(`
			UPDATE relationship_event_outbox
			SET status = 'delivered', receipt_id = ?, lease_expires_at = NULL,
				last_error = NULL, delivered_at = ?, updated_at = ?
			WHERE idempotency_key = ? AND status = 'sending'
		`).run(receiptId ? String(receiptId).slice(0, 240) : null, timestamp, timestamp, idempotencyKey);
		return this.getRelationshipEventOutbox(idempotencyKey);
	}

	failRelationshipEventOutbox(idempotencyKey, error, {
		maximumAttempts = 12,
		retryDelaySeconds = 30,
	} = {}) {
		const current = this.getRelationshipEventOutbox(idempotencyKey);
		if (!current || current.status !== "sending") return current;
		const terminal = current.attempts >= maximumAttempts;
		this.database.prepare(`
			UPDATE relationship_event_outbox
			SET status = ?, available_at = ?, lease_expires_at = NULL,
				last_error = ?, updated_at = ?
			WHERE idempotency_key = ? AND status = 'sending'
		`).run(
			terminal ? "terminal" : "retry",
			future(terminal ? 0 : retryDelaySeconds),
			String(error).slice(0, 1000),
			now(),
			idempotencyKey,
		);
		return this.getRelationshipEventOutbox(idempotencyKey);
	}

	getLatestContextEventPayload(contextId, source) {
		return this.database.prepare(`
			SELECT payload_json AS payloadJson
			FROM events
			WHERE context_id = ? AND source = ? AND payload_json IS NOT NULL
			ORDER BY received_at DESC
			LIMIT 1
		`).get(contextId, source);
	}

	touchRoute(source, threadId) {
		this.database.prepare(`
			UPDATE routes SET last_seen_at = ? WHERE source = ? AND provider_thread_id = ?
		`).run(now(), source, threadId);
	}

	getContext(id) {
		return this.database.prepare(`
			SELECT id, target_id AS targetId, driver, runtime_name AS runtimeName,
				port, status, created_at AS createdAt, last_seen_at AS lastSeenAt,
				last_started_at AS lastStartedAt, last_stopped_at AS lastStoppedAt,
				runtime_version AS runtimeVersion
			FROM contexts WHERE id = ?
		`).get(id);
	}

	listContexts() {
		return this.database.prepare(`
			SELECT id, target_id AS targetId, driver, runtime_name AS runtimeName,
				port, status, created_at AS createdAt, last_seen_at AS lastSeenAt,
				last_started_at AS lastStartedAt, last_stopped_at AS lastStoppedAt,
				runtime_version AS runtimeVersion
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
			UPDATE contexts SET runtime_name = ?, port = ?, status = ?, last_seen_at = ?,
				last_started_at = ?, last_stopped_at = ?, runtime_version = ?
			WHERE id = ?
		`).run(
			updates.runtimeName ?? current.runtimeName ?? null,
			updates.port ?? current.port ?? null,
			updates.status ?? current.status,
			updates.touch === false ? current.lastSeenAt : now(),
			updates.lastStartedAt ?? current.lastStartedAt ?? null,
			updates.lastStoppedAt ?? current.lastStoppedAt ?? null,
			updates.runtimeVersion ?? current.runtimeVersion ?? null,
			id,
		);
		return this.getContext(id);
	}

	getMattermostBinding(contextId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, team_id AS teamId, channel_id AS channelId,
				bot_user_id AS botUserId, bot_username AS botUsername,
				channel_display_name AS channelDisplayName, attention_mode AS attentionMode,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM mattermost_bindings WHERE context_id = ?
		`).get(contextId);
	}

	getMattermostBindingByChannel(channelId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, team_id AS teamId, channel_id AS channelId,
				bot_user_id AS botUserId, bot_username AS botUsername,
				channel_display_name AS channelDisplayName, attention_mode AS attentionMode,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM mattermost_bindings WHERE channel_id = ?
		`).get(channelId);
	}

	upsertMattermostBinding({
		contextId,
		teamId,
		channelId,
		channelDisplayName,
		botUserId,
		botUsername,
		attentionMode = "ambient",
	}) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO mattermost_bindings(
				context_id, team_id, channel_id, bot_user_id, bot_username,
				channel_display_name, attention_mode, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(context_id) DO UPDATE SET
				team_id = excluded.team_id,
				channel_id = excluded.channel_id,
				channel_display_name = excluded.channel_display_name,
				bot_user_id = excluded.bot_user_id,
				bot_username = excluded.bot_username,
				last_seen_at = excluded.last_seen_at
		`).run(
			contextId,
			teamId,
			channelId,
			botUserId,
			botUsername,
			channelDisplayName ?? null,
			attentionMode,
			timestamp,
			timestamp,
		);
		return this.getMattermostBinding(contextId);
	}

	setMattermostAttention(contextId, mode) {
		if (!["ambient", "mentions-only"].includes(mode)) {
			throw new Error("Mattermost attention mode must be ambient or mentions-only");
		}
		this.database.prepare(`
			UPDATE mattermost_bindings SET attention_mode = ?, last_seen_at = ? WHERE context_id = ?
		`).run(mode, now(), contextId);
		return this.getMattermostBinding(contextId);
	}

	setMattermostChannelDisplayName(contextId, displayName) {
		this.database.prepare(`
			UPDATE mattermost_bindings
			SET channel_display_name = ?, last_seen_at = ?
			WHERE context_id = ?
		`).run(displayName, now(), contextId);
		return this.getMattermostBinding(contextId);
	}

	getRocketChatBinding(contextId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, contact_id AS contactId,
				room_id AS roomId, room_name AS roomName,
				bot_user_id AS botUserId, bot_username AS botUsername,
				channel_display_name AS channelDisplayName, attention_mode AS attentionMode,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM rocket_chat_bindings WHERE context_id = ?
		`).get(contextId);
	}

	getZulipBinding(contextId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, channel_id AS channelId,
				channel_name AS channelName, agent_user_id AS agentUserId,
				projector_user_id AS projectorUserId, attention_mode AS attentionMode,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM zulip_bindings WHERE context_id = ?
		`).get(contextId);
	}

	getZulipBindingByChannel(channelId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, channel_id AS channelId,
				channel_name AS channelName, agent_user_id AS agentUserId,
				projector_user_id AS projectorUserId, attention_mode AS attentionMode,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM zulip_bindings WHERE channel_id = ?
		`).get(Number(channelId));
	}

	upsertZulipBinding({
		contextId,
		channelId,
		channelName,
		agentUserId,
		projectorUserId,
		attentionMode = "ambient",
	}) {
		if (!["ambient", "mentions-only"].includes(attentionMode)) {
			throw new Error("Zulip attention mode must be ambient or mentions-only");
		}
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO zulip_bindings(
				context_id, channel_id, channel_name, agent_user_id,
				projector_user_id, attention_mode, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(context_id) DO UPDATE SET
				channel_id = excluded.channel_id,
				channel_name = excluded.channel_name,
				agent_user_id = excluded.agent_user_id,
				projector_user_id = excluded.projector_user_id,
				last_seen_at = excluded.last_seen_at
		`).run(
			contextId,
			Number(channelId),
			channelName,
			Number(agentUserId),
			Number(projectorUserId),
			attentionMode,
			timestamp,
			timestamp,
		);
		return this.getZulipBinding(contextId);
	}

	setZulipAttention(contextId, mode) {
		if (!["ambient", "mentions-only"].includes(mode)) {
			throw new Error("Zulip attention mode must be ambient or mentions-only");
		}
		const result = this.database.prepare(`
			UPDATE zulip_bindings SET attention_mode = ?, last_seen_at = ? WHERE context_id = ?
		`).run(mode, now(), contextId);
		if (result.changes !== 1) throw new Error(`unknown Zulip context ${contextId}`);
		return this.getZulipBinding(contextId);
	}

	getRocketChatBindingByRoom(roomId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, contact_id AS contactId,
				room_id AS roomId, room_name AS roomName,
				bot_user_id AS botUserId, bot_username AS botUsername,
				channel_display_name AS channelDisplayName, attention_mode AS attentionMode,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM rocket_chat_bindings WHERE room_id = ?
		`).get(roomId);
	}

	upsertRocketChatBinding({
		contextId,
		contactId,
		roomId,
		roomName,
		botUserId,
		botUsername,
		channelDisplayName,
		attentionMode = "ambient",
	}) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO rocket_chat_bindings(
				context_id, contact_id, room_id, room_name, bot_user_id, bot_username,
				channel_display_name, attention_mode, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(context_id) DO UPDATE SET
				contact_id = excluded.contact_id,
				room_id = excluded.room_id,
				room_name = excluded.room_name,
				bot_user_id = excluded.bot_user_id,
				bot_username = excluded.bot_username,
				channel_display_name = excluded.channel_display_name,
				last_seen_at = excluded.last_seen_at
		`).run(
			contextId,
			contactId ?? null,
			roomId,
			roomName,
			botUserId ?? null,
			botUsername ?? null,
			channelDisplayName ?? null,
			attentionMode,
			timestamp,
			timestamp,
		);
		return this.getRocketChatBinding(contextId);
	}

	setRocketChatAttention(contextId, mode) {
		if (!["ambient", "mentions-only"].includes(mode)) {
			throw new Error("Rocket.Chat attention mode must be ambient or mentions-only");
		}
		this.database.prepare(`
			UPDATE rocket_chat_bindings SET attention_mode = ?, last_seen_at = ? WHERE context_id = ?
		`).run(mode, now(), contextId);
		return this.getRocketChatBinding(contextId);
	}

	setRocketChatChannelDisplayName(contextId, displayName) {
		this.database.prepare(`
			UPDATE rocket_chat_bindings
			SET channel_display_name = ?, last_seen_at = ?
			WHERE context_id = ?
		`).run(displayName, now(), contextId);
		return this.getRocketChatBinding(contextId);
	}

	getRocketChatOmnichannelConversation(source, providerThreadId) {
		return this.database.prepare(`
			SELECT context_id AS contextId, source,
				provider_thread_id AS providerThreadId,
				visitor_token AS visitorToken, visitor_id AS visitorId,
				contact_id AS contactId, room_id AS roomId, status,
				created_at AS createdAt, last_seen_at AS lastSeenAt
			FROM rocket_chat_omnichannel_conversations
			WHERE source = ? AND provider_thread_id = ?
		`).get(source, providerThreadId);
	}

	upsertRocketChatOmnichannelConversation({
		contextId,
		source,
		providerThreadId,
		visitorToken,
		visitorId,
		contactId,
		roomId,
		status = "open",
	}) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO rocket_chat_omnichannel_conversations(
				context_id, source, provider_thread_id, visitor_token,
				visitor_id, contact_id, room_id, status, created_at, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(source, provider_thread_id) DO UPDATE SET
				context_id = excluded.context_id,
				visitor_token = excluded.visitor_token,
				visitor_id = excluded.visitor_id,
				contact_id = excluded.contact_id,
				room_id = excluded.room_id,
				status = excluded.status,
				last_seen_at = excluded.last_seen_at
		`).run(
			contextId,
			source,
			providerThreadId,
			visitorToken,
			visitorId,
			contactId,
			roomId,
			status,
			timestamp,
			timestamp,
		);
		return this.getRocketChatOmnichannelConversation(source, providerThreadId);
	}

	getRocketChatPost(eventId) {
		return this.database.prepare(`
			SELECT event_id AS eventId, context_id AS contextId, sequence,
				thread_id AS threadId, text_sha256 AS textSha256, status,
				provider_message_id AS providerMessageId, last_error AS lastError,
				created_at AS createdAt, updated_at AS updatedAt,
				completed_at AS completedAt
			FROM rocket_chat_posts
			WHERE event_id = ?
		`).get(eventId);
	}

	startRocketChatPost({ eventId, contextId, threadId, textSha256 }) {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.getRocketChatPost(eventId);
			if (existing) {
				if (
					existing.contextId !== contextId
					|| existing.threadId !== (threadId ?? null)
					|| existing.textSha256 !== textSha256
				) {
					throw new Error("Rocket.Chat event ID conflicts with an existing post");
				}
				if (existing.status === "completed" || existing.status === "sending") {
					this.database.exec("COMMIT");
					return { ...existing, claimed: false };
				}
				this.database.prepare(`
					UPDATE rocket_chat_posts
					SET status = 'sending', last_error = NULL, updated_at = ?
					WHERE event_id = ?
				`).run(now(), eventId);
				this.database.exec("COMMIT");
				return { ...this.getRocketChatPost(eventId), claimed: true };
			}
			const timestamp = now();
			const sequence = this.nextAwarenessSequence(contextId);
			this.database.prepare(`
				INSERT INTO rocket_chat_posts(
					event_id, context_id, sequence, thread_id, text_sha256,
					status, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)
			`).run(
				eventId,
				contextId,
				sequence,
				threadId ?? null,
				textSha256,
				timestamp,
				timestamp,
			);
			this.database.exec("COMMIT");
			return { ...this.getRocketChatPost(eventId), claimed: true };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	completeRocketChatPost(eventId, providerMessageId) {
		const timestamp = now();
		this.database.prepare(`
			UPDATE rocket_chat_posts
			SET status = 'completed', provider_message_id = ?, last_error = NULL,
				completed_at = ?, updated_at = ?
			WHERE event_id = ? AND status = 'sending'
		`).run(providerMessageId, timestamp, timestamp, eventId);
		return this.getRocketChatPost(eventId);
	}

	failRocketChatPost(eventId, error) {
		this.database.prepare(`
			UPDATE rocket_chat_posts
			SET status = 'failed', last_error = ?, updated_at = ?
			WHERE event_id = ? AND status = 'sending'
		`).run(String(error).slice(0, 1000), now(), eventId);
		return this.getRocketChatPost(eventId);
	}

	nextAwarenessSequence(contextId) {
		this.database.prepare(`
			INSERT INTO awareness_sequences(context_id, last_sequence)
			VALUES (?, 0)
			ON CONFLICT(context_id) DO NOTHING
		`).run(contextId);
		return this.database.prepare(`
			UPDATE awareness_sequences
			SET last_sequence = last_sequence + 1
			WHERE context_id = ?
			RETURNING last_sequence AS sequence
		`).get(contextId).sequence;
	}

	getScheduledPrompt(contextId, filename) {
		return this.database.prepare(`
			SELECT context_id AS contextId, target_id AS targetId, filename,
				source_sha256 AS sourceSha256, generation, kind, status,
				payload_json AS payloadJson, canonical_slot_at AS canonicalSlotAt,
				next_fire_at AS nextFireAt, last_indexed_at AS lastIndexedAt,
				last_materialized_at AS lastMaterializedAt, last_error AS lastError,
				archive_outcome AS archiveOutcome, archived_at AS archivedAt,
				created_at AS createdAt, updated_at AS updatedAt
			FROM scheduled_prompts WHERE context_id = ? AND filename = ?
		`).get(contextId, filename);
	}

	listScheduledPrompts(contextId) {
		const query = contextId === undefined
			? this.database.prepare(`
				SELECT context_id AS contextId, target_id AS targetId, filename,
					source_sha256 AS sourceSha256, generation, kind, status,
					payload_json AS payloadJson, canonical_slot_at AS canonicalSlotAt,
					next_fire_at AS nextFireAt, last_indexed_at AS lastIndexedAt,
					last_materialized_at AS lastMaterializedAt, last_error AS lastError,
					archive_outcome AS archiveOutcome, archived_at AS archivedAt,
					created_at AS createdAt, updated_at AS updatedAt
				FROM scheduled_prompts ORDER BY context_id, filename
			`)
			: this.database.prepare(`
				SELECT context_id AS contextId, target_id AS targetId, filename,
					source_sha256 AS sourceSha256, generation, kind, status,
					payload_json AS payloadJson, canonical_slot_at AS canonicalSlotAt,
					next_fire_at AS nextFireAt, last_indexed_at AS lastIndexedAt,
					last_materialized_at AS lastMaterializedAt, last_error AS lastError,
					archive_outcome AS archiveOutcome, archived_at AS archivedAt,
					created_at AS createdAt, updated_at AS updatedAt
				FROM scheduled_prompts WHERE context_id = ? ORDER BY filename
			`);
		return contextId === undefined ? query.all() : query.all(contextId);
	}

	upsertScheduledPrompt({
		contextId,
		targetId,
		filename,
		sourceSha256,
		kind,
		status,
		payload,
		canonicalSlotAt,
		nextFireAt,
		lastError,
	}) {
		const timestamp = now();
		const existing = this.getScheduledPrompt(contextId, filename);
		if (!existing) {
			this.database.prepare(`
				INSERT INTO scheduled_prompts(
					context_id, target_id, filename, source_sha256, generation,
					kind, status, payload_json, canonical_slot_at, next_fire_at,
					last_indexed_at, last_error, created_at, updated_at
				) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).run(
				contextId,
				targetId,
				filename,
				sourceSha256,
				kind,
				status,
				JSON.stringify(payload),
				canonicalSlotAt,
				nextFireAt,
				timestamp,
				lastError ? String(lastError).slice(0, 1000) : null,
				timestamp,
				timestamp,
			);
			return this.getScheduledPrompt(contextId, filename);
		}
		if (existing.sourceSha256 === sourceSha256) {
			const rearm = ["disarmed", "throttled"].includes(existing.status) && status === "armed";
			this.database.prepare(`
				UPDATE scheduled_prompts SET target_id = ?, last_indexed_at = ?,
					status = CASE WHEN ? THEN 'armed' ELSE status END,
					last_error = CASE WHEN ? THEN NULL ELSE last_error END,
					updated_at = ?
				WHERE context_id = ? AND filename = ?
			`).run(targetId, timestamp, rearm ? 1 : 0, rearm ? 1 : 0, timestamp, contextId, filename);
			return this.getScheduledPrompt(contextId, filename);
		}
		this.database.prepare(`
			UPDATE scheduled_prompts SET target_id = ?, source_sha256 = ?,
				generation = generation + 1, kind = ?, status = ?, payload_json = ?,
				canonical_slot_at = ?, next_fire_at = ?, last_indexed_at = ?,
				last_materialized_at = NULL, last_error = ?, archive_outcome = NULL,
				archived_at = NULL, updated_at = ?
			WHERE context_id = ? AND filename = ?
		`).run(
			targetId,
			sourceSha256,
			kind,
			status,
			JSON.stringify(payload),
			canonicalSlotAt,
			nextFireAt,
			timestamp,
			lastError ? String(lastError).slice(0, 1000) : null,
			timestamp,
			contextId,
			filename,
		);
		return this.getScheduledPrompt(contextId, filename);
	}

	disarmMissingScheduledPrompts(contextId, filenames) {
		const seen = new Set(filenames);
		let changes = 0;
		for (const schedule of this.listScheduledPrompts(contextId)) {
			if (seen.has(schedule.filename) || !["armed", "throttled", "invalid", "runtime-owned"].includes(schedule.status)) continue;
			changes += this.database.prepare(`
				UPDATE scheduled_prompts SET status = 'disarmed', next_fire_at = NULL,
					last_error = 'source file is absent', updated_at = ?
				WHERE context_id = ? AND filename = ? AND generation = ?
			`).run(now(), contextId, schedule.filename, schedule.generation).changes;
		}
		return changes;
	}

	disarmScheduledPrompt(schedule, error) {
		this.database.prepare(`
			UPDATE scheduled_prompts SET status = 'disarmed', next_fire_at = NULL,
				last_error = ?, updated_at = ?
			WHERE context_id = ? AND filename = ? AND generation = ? AND status = 'armed'
		`).run(
			String(error).slice(0, 1000),
			now(),
			schedule.contextId,
			schedule.filename,
			schedule.generation,
		);
		return this.getScheduledPrompt(schedule.contextId, schedule.filename);
	}

	listDueScheduledPrompts(timestamp = now(), limit = 32, contextIds) {
		if (contextIds !== undefined && !Array.isArray(contextIds)) {
			throw new Error("scheduled contextIds must be an array");
		}
		if (contextIds?.length === 0) return [];
		const placeholders = contextIds?.map(() => "?").join(", ");
		const contextClause = contextIds ? `AND context_id IN (${placeholders})` : "";
		return this.database.prepare(`
			SELECT context_id AS contextId, target_id AS targetId, filename,
				source_sha256 AS sourceSha256, generation, kind, status,
				payload_json AS payloadJson, canonical_slot_at AS canonicalSlotAt,
				next_fire_at AS nextFireAt, last_indexed_at AS lastIndexedAt,
				last_materialized_at AS lastMaterializedAt, last_error AS lastError,
				archive_outcome AS archiveOutcome, archived_at AS archivedAt,
				created_at AS createdAt, updated_at AS updatedAt
			FROM scheduled_prompts
			WHERE status = 'armed' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
				${contextClause}
			ORDER BY next_fire_at, context_id, filename
			LIMIT ?
		`).all(timestamp, ...(contextIds || []), limit);
	}

	materializeScheduledPrompt({
		schedule,
		occurrenceId,
		canonicalSlotAt,
		fireAt,
		nextCanonicalSlotAt,
		nextFireAt,
		completeSchedule,
	}) {
		const timestamp = now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const current = this.getScheduledPrompt(schedule.contextId, schedule.filename);
			if (
				!current
				|| current.status !== "armed"
				|| current.generation !== schedule.generation
				|| current.sourceSha256 !== schedule.sourceSha256
				|| current.canonicalSlotAt !== schedule.canonicalSlotAt
				|| current.nextFireAt !== schedule.nextFireAt
			) {
				this.database.exec("COMMIT");
				return null;
			}
			const awarenessSequence = this.nextAwarenessSequence(schedule.contextId);
			const payload = {
				schedule: {
					filename: schedule.filename,
					generation: schedule.generation,
					canonicalSlotAt,
					fireAt,
				},
				event: JSON.parse(schedule.payloadJson),
			};
			const inserted = this.database.prepare(`
				INSERT INTO events(
					id, source, provider_message_id, provider_thread_id,
					principal_hash, target_id, context_id, awareness_sequence, status,
					payload_json, received_at, available_at, updated_at
				) VALUES (?, 'scheduled-prompt', ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
				ON CONFLICT(source, provider_message_id) DO NOTHING
			`).run(
				occurrenceId,
				occurrenceId,
				`attention:${schedule.filename}`,
				`scheduled:${schedule.contextId}`,
				schedule.targetId,
				schedule.contextId,
				awarenessSequence,
				JSON.stringify(payload),
				timestamp,
				timestamp,
				timestamp,
			);
			if (inserted.changes !== 1) {
				throw new Error("scheduled occurrence conflicts with durable event state");
			}
			this.database.prepare(`
				UPDATE scheduled_prompts SET status = ?, canonical_slot_at = ?,
					next_fire_at = ?, last_materialized_at = ?, last_error = NULL,
					updated_at = ?
				WHERE context_id = ? AND filename = ? AND generation = ?
			`).run(
				completeSchedule ? "completed" : "armed",
				nextCanonicalSlotAt,
				nextFireAt,
				timestamp,
				timestamp,
				schedule.contextId,
				schedule.filename,
				schedule.generation,
			);
			this.database.exec("COMMIT");
			return this.getEventByProviderMessage("scheduled-prompt", occurrenceId);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	advanceScheduledPrompt(schedule, next, lastError = null) {
		this.database.prepare(`
			UPDATE scheduled_prompts SET canonical_slot_at = ?, next_fire_at = ?,
				last_error = ?, updated_at = ?
			WHERE context_id = ? AND filename = ? AND generation = ? AND status = 'armed'
		`).run(
			new Date(next.slotMs).toISOString(),
			new Date(next.fireMs).toISOString(),
			lastError,
			now(),
			schedule.contextId,
			schedule.filename,
			schedule.generation,
		);
		return this.getScheduledPrompt(schedule.contextId, schedule.filename);
	}

	expireScheduledPrompt(schedule, error) {
		this.database.prepare(`
			UPDATE scheduled_prompts SET status = 'expired', next_fire_at = NULL,
				last_error = ?, updated_at = ?
			WHERE context_id = ? AND filename = ? AND generation = ? AND status = 'armed'
		`).run(String(error).slice(0, 1000), now(), schedule.contextId, schedule.filename, schedule.generation);
		return this.getScheduledPrompt(schedule.contextId, schedule.filename);
	}

	noteScheduledPromptError(schedule, error) {
		this.database.prepare(`
			UPDATE scheduled_prompts SET last_error = ?, updated_at = ?
			WHERE context_id = ? AND filename = ? AND generation = ?
		`).run(String(error).slice(0, 1000), now(), schedule.contextId, schedule.filename, schedule.generation);
	}

	markScheduledPromptArchived(schedule, outcome) {
		this.database.prepare(`
			UPDATE scheduled_prompts SET archive_outcome = ?, archived_at = ?, updated_at = ?
			WHERE context_id = ? AND filename = ? AND generation = ?
		`).run(outcome, now(), now(), schedule.contextId, schedule.filename, schedule.generation);
	}

	countRecentScheduledEvents(contextId, since) {
		return this.database.prepare(`
			SELECT COUNT(*) AS count FROM events
			WHERE source = 'scheduled-prompt' AND context_id = ? AND received_at >= ?
		`).get(contextId, since).count;
	}

	markEventUncertain(id, error, leaseToken) {
		const event = this.getEvent(id);
		if (!event || (leaseToken && event.leaseToken !== leaseToken)) return event;
		this.database.prepare(`
			UPDATE events SET status = 'uncertain', last_error = ?, lease_token = NULL,
				lease_expires_at = NULL, updated_at = ?
			WHERE id = ? AND status IN ('leased', 'accepted', 'running')
		`).run(String(error).slice(0, 1000), now(), id);
		return this.getEvent(id);
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
				target_id AS targetId, context_id AS contextId,
				awareness_sequence AS awarenessSequence, status, attempts,
				last_error AS lastError, received_at AS receivedAt, completed_at AS completedAt,
				payload_json AS payloadJson, available_at AS availableAt,
				lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
				accepted_at AS acceptedAt, started_at AS startedAt, updated_at AS updatedAt
			FROM events WHERE source = ? AND provider_message_id = ?
		`).get(source, messageId);
	}

	getEvent(id) {
		return this.database.prepare(`
			SELECT id, source, provider_message_id AS providerMessageId,
				provider_thread_id AS providerThreadId, principal_hash AS principalHash,
				target_id AS targetId, context_id AS contextId,
				awareness_sequence AS awarenessSequence, status, attempts,
				last_error AS lastError, received_at AS receivedAt, completed_at AS completedAt,
				payload_json AS payloadJson, available_at AS availableAt,
				lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
				accepted_at AS acceptedAt, started_at AS startedAt, updated_at AS updatedAt
			FROM events WHERE id = ?
		`).get(id);
	}

	listRetryableEvents() {
		return this.database.prepare(`
			SELECT id, source, provider_message_id AS providerMessageId,
				provider_thread_id AS providerThreadId, principal_hash AS principalHash,
				target_id AS targetId, context_id AS contextId,
				awareness_sequence AS awarenessSequence, status, attempts,
				last_error AS lastError, received_at AS receivedAt, completed_at AS completedAt,
				payload_json AS payloadJson, available_at AS availableAt,
				lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
				accepted_at AS acceptedAt, started_at AS startedAt, updated_at AS updatedAt
			FROM events WHERE status IN ('queued', 'failed')
			ORDER BY received_at
		`).all();
	}

	upsertEvent(event) {
		const existing = this.getEventByProviderMessage(event.source, event.providerMessageId);
		if (existing) return existing;
		const timestamp = now();
		const awarenessSequence = this.nextAwarenessSequence(event.contextId);
		this.database.prepare(`
			INSERT INTO events(
				id, source, provider_message_id, provider_thread_id,
				principal_hash, target_id, context_id, awareness_sequence, status, payload_json,
				received_at, available_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
			ON CONFLICT(source, provider_message_id) DO NOTHING
		`).run(
			event.id,
			event.source,
			event.providerMessageId,
			event.providerThreadId,
			event.principalHash,
			event.targetId,
			event.contextId,
			awarenessSequence,
			event.payload === undefined ? null : JSON.stringify(event.payload),
			timestamp,
			timestamp,
			timestamp,
		);
		return this.getEventByProviderMessage(event.source, event.providerMessageId);
	}

	insertControlNotification(event, stored) {
		const timestamp = now();
		this.database.prepare(`
			INSERT INTO control_notifications(
				id, event_id, context_id, sequence, status, available_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
			ON CONFLICT(event_id) DO NOTHING
		`).run(
			`${event.source}:${event.providerMessageId}`,
			stored.id,
			stored.contextId,
			stored.awarenessSequence,
			timestamp,
			timestamp,
			timestamp,
		);
	}

	upsertEventWithControlNotification(event) {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const stored = this.upsertEvent(event);
			this.insertControlNotification(event, stored);
			this.database.exec("COMMIT");
			return stored;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	upsertPhoneInbound({ conversation, event, attributionClaim, relationshipEvent }) {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const existingEvent = this.getEventByProviderMessage(event.source, event.providerMessageId);
			const previousRelationship = this.getPhoneConversation(conversation.threadTarget);
			const previousInbound = this.database.prepare(`
				SELECT 1 FROM events
				WHERE source = 'phone' AND provider_thread_id = ?
				LIMIT 1
			`).get(conversation.providerThreadId);
			const storedConversation = this.upsertPhoneConversation(conversation);
			const storedEvent = this.upsertEvent(event);
			this.insertControlNotification(event, storedEvent);
			let relationshipEventQueued = false;
			if (
				relationshipEvent
				&& attributionClaim
				&& !existingEvent
				&& !previousRelationship
				&& !previousInbound
			) {
				const relationshipKey = `phone:${storedConversation.threadTarget}`;
				const attributionAccepted = this.insertRelationshipAttribution({
					...attributionClaim,
					relationshipKey,
				});
				if (!attributionAccepted) {
					this.database.exec("COMMIT");
					return {
						conversation: storedConversation,
						event: storedEvent,
						relationshipEventQueued: false,
					};
				}
				const queued = this.insertRelationshipEventOutbox({
					...relationshipEvent,
					relationshipKey,
				});
				if (!queued) throw new Error("relationship event could not be queued");
				relationshipEventQueued = queued?.idempotencyKey === relationshipEvent.eventId;
			}
			this.database.exec("COMMIT");
			return {
				conversation: storedConversation,
				event: storedEvent,
				relationshipEventQueued,
			};
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	getControlNotification(id) {
		return this.database.prepare(`
			SELECT notification.id, notification.event_id AS eventId,
				notification.context_id AS contextId, notification.status,
				notification.sequence,
				notification.attempts, notification.available_at AS availableAt,
				notification.provider_post_id AS providerPostId,
				notification.last_error AS lastError,
				notification.created_at AS createdAt,
				notification.updated_at AS updatedAt,
				notification.completed_at AS completedAt,
				event.source, event.provider_message_id AS providerMessageId,
				event.provider_thread_id AS providerThreadId,
				event.principal_hash AS principalHash,
				event.payload_json AS payloadJson
			FROM control_notifications notification
			JOIN events event ON event.id = notification.event_id
			WHERE notification.id = ?
		`).get(id);
	}

	claimControlNotification(maximumAttempts = 10) {
		const timestamp = now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.database.prepare(`
				SELECT id FROM control_notifications
				WHERE status IN ('queued', 'failed')
					AND attempts < ?
					AND available_at <= ?
				ORDER BY created_at
				LIMIT 1
			`).get(maximumAttempts, timestamp);
			if (!row) {
				this.database.exec("COMMIT");
				return null;
			}
			this.database.prepare(`
				UPDATE control_notifications
				SET status = 'sending', attempts = attempts + 1,
					last_error = NULL, updated_at = ?
				WHERE id = ? AND status IN ('queued', 'failed')
			`).run(timestamp, row.id);
			this.database.exec("COMMIT");
			return this.getControlNotification(row.id);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	completeControlNotification(id, providerPostId) {
		this.database.prepare(`
			UPDATE control_notifications
			SET status = 'completed', provider_post_id = ?, last_error = NULL,
				completed_at = ?, updated_at = ?
			WHERE id = ? AND status = 'sending'
		`).run(providerPostId, now(), now(), id);
		return this.getControlNotification(id);
	}

	failControlNotification(id, error, maximumAttempts = 10) {
		const current = this.getControlNotification(id);
		if (!current) return null;
		const status = current.attempts >= maximumAttempts ? "dead" : "failed";
		const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, current.attempts - 1)));
		this.database.prepare(`
			UPDATE control_notifications
			SET status = ?, available_at = ?, last_error = ?, updated_at = ?
			WHERE id = ? AND status = 'sending'
		`).run(status, future(delaySeconds), String(error).slice(0, 1000), now(), id);
		return this.getControlNotification(id);
	}

	claimNextEvent({
		leaseSeconds = 60,
		maximumAttempts = 5,
		maximumActiveContexts = Number.MAX_SAFE_INTEGER,
	} = {}) {
		const timestamp = now();
		const leaseToken = randomUUID();
		const contextLimit = Math.max(1, Math.floor(maximumActiveContexts));
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.database.prepare(`
				SELECT candidate.id,
					EXISTS (
						SELECT 1 FROM events running
						WHERE running.context_id = candidate.context_id
							AND running.status = 'running'
					) AS append_to_running
				FROM events candidate
				WHERE candidate.status IN ('queued', 'failed')
					AND candidate.attempts < ?
					AND candidate.available_at <= ?
					AND NOT EXISTS (
						SELECT 1 FROM events delivering
						WHERE delivering.context_id = candidate.context_id
							AND delivering.id != candidate.id
							AND delivering.status IN ('leased', 'accepted')
					)
					AND (
						EXISTS (
							SELECT 1 FROM events running
							WHERE running.context_id = candidate.context_id
								AND running.status = 'running'
						)
						OR (
							SELECT COUNT(DISTINCT active.context_id)
							FROM events active
							WHERE active.status IN ('leased', 'accepted', 'running')
						) < ?
					)
				ORDER BY candidate.received_at
				LIMIT 1
			`).get(maximumAttempts, timestamp, contextLimit);
			if (!row) {
				this.database.exec("COMMIT");
				return null;
			}
			this.database.prepare(`
				UPDATE events SET status = 'leased', attempts = attempts + 1,
					lease_token = ?, lease_expires_at = ?, last_error = NULL,
					updated_at = ?
				WHERE id = ? AND status IN ('queued', 'failed')
			`).run(leaseToken, future(leaseSeconds), timestamp, row.id);
			this.database.exec("COMMIT");
			return {
				...this.getEvent(row.id),
				deliveryMode: row.append_to_running ? "steer" : "turn",
			};
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	acceptEvent(id, leaseToken, leaseSeconds = 900) {
		this.database.prepare(`
			UPDATE events SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?),
				lease_expires_at = ?, updated_at = ?, last_error = NULL
			WHERE id = ? AND lease_token = ? AND status = 'leased'
		`).run(now(), future(leaseSeconds), now(), id, leaseToken);
		return this.getEvent(id);
	}

	heartbeatEvent(id, leaseToken, leaseSeconds = 900) {
		this.database.prepare(`
			UPDATE events SET status = 'running', accepted_at = COALESCE(accepted_at, ?),
				started_at = COALESCE(started_at, ?),
				lease_expires_at = ?, updated_at = ?
			WHERE id = ? AND lease_token = ? AND status IN ('leased', 'accepted', 'running')
		`).run(now(), now(), future(leaseSeconds), now(), id, leaseToken);
		return this.getEvent(id);
	}

	completeEvent(id, leaseToken) {
		if (!leaseToken) return this.getEvent(id);
		const result = this.database.prepare(`
			UPDATE events SET status = 'completed', completed_at = ?, updated_at = ?,
				lease_token = NULL, lease_expires_at = NULL, last_error = NULL
			WHERE id = ? AND lease_token = ?
				AND status IN ('leased', 'accepted', 'running')
		`).run(now(), now(), id, leaseToken);
		const event = this.getEvent(id);
		if (result.changes && event) {
			this.updateContext(event.contextId, {
				status: this.getContext(event.contextId)?.status ?? "online",
			});
		}
		return event;
	}

	failEvent(id, error, leaseToken, retrySeconds = 15, maximumAttempts = 5) {
		const event = this.getEvent(id);
		if (!event || (leaseToken && event.leaseToken !== leaseToken)) return event;
		const status = event.attempts >= maximumAttempts ? "dead" : "failed";
		this.database.prepare(`
			UPDATE events SET status = ?, last_error = ?, available_at = ?,
				lease_token = NULL, lease_expires_at = NULL, updated_at = ?
			WHERE id = ?
		`).run(status, String(error).slice(0, 1000), future(retrySeconds), now(), id);
		return this.getEvent(id);
	}

	recoverExpiredEvents(maximumAttempts = 5) {
		const timestamp = now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const uncertain = this.database.prepare(`
				UPDATE events SET status = 'uncertain', lease_token = NULL,
					lease_expires_at = NULL,
					last_error = 'runtime became unreachable after reporting running', updated_at = ?
				WHERE status = 'running' AND lease_expires_at < ?
			`).run(timestamp, timestamp).changes;
			const exhaustedQueued = this.database.prepare(`
				UPDATE events SET status = 'dead', lease_token = NULL,
					lease_expires_at = NULL,
					last_error = COALESCE(last_error, 'maximum delivery attempts exhausted before running'),
					updated_at = ?
				WHERE status IN ('queued', 'failed') AND attempts >= ?
			`).run(timestamp, maximumAttempts).changes;
			const exhaustedExpired = this.database.prepare(`
				UPDATE events SET status = 'dead', lease_token = NULL,
					lease_expires_at = NULL,
					last_error = COALESCE(last_error, 'delivery lease expired before running after maximum attempts'),
					updated_at = ?
				WHERE status IN ('leased', 'accepted') AND lease_expires_at < ?
					AND attempts >= ?
			`).run(timestamp, timestamp, maximumAttempts).changes;
			const recovered = this.database.prepare(`
				UPDATE events SET status = 'queued', available_at = ?, lease_token = NULL,
					lease_expires_at = NULL, last_error = 'delivery lease expired before running', updated_at = ?
				WHERE status IN ('leased', 'accepted') AND lease_expires_at < ?
					AND attempts < ?
			`).run(timestamp, timestamp, timestamp, maximumAttempts).changes;
			this.database.exec("COMMIT");
			return { recovered, uncertain, exhausted: exhaustedQueued + exhaustedExpired };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	countActiveEvents() {
		return this.database.prepare(`
			SELECT COUNT(*) AS count FROM events WHERE status IN ('leased', 'accepted', 'running')
		`).get().count;
	}

	countActiveContexts() {
		return this.database.prepare(`
			SELECT COUNT(DISTINCT context_id) AS count
			FROM events
			WHERE status IN ('leased', 'accepted', 'running')
		`).get().count;
	}

	hasActiveEvent(contextId) {
		return Boolean(this.database.prepare(`
			SELECT 1 FROM events
			WHERE context_id = ? AND status IN ('leased', 'accepted', 'running')
		`).get(contextId));
	}

	hasRunningEvent(contextId, excludedEventId) {
		return Boolean(this.database.prepare(`
			SELECT 1 FROM events
			WHERE context_id = ? AND status = 'running'
				AND (? IS NULL OR id != ?)
		`).get(contextId, excludedEventId ?? null, excludedEventId ?? null));
	}

	getOutbox(idempotencyKey) {
		return this.database.prepare(`
			SELECT id, idempotency_key AS idempotencyKey, target_id AS targetId,
				context_id AS contextId, provider_thread_id AS providerThreadId,
				body_sha256 AS bodySha256,
				status, provider_message_id AS providerMessageId, last_error AS lastError,
				created_at AS createdAt, completed_at AS completedAt
			FROM outbox WHERE idempotency_key = ?
		`).get(idempotencyKey);
	}

	startOutbox({ idempotencyKey, targetId, contextId, providerThreadId, bodySha256 }) {
		const inserted = this.database.prepare(`
			INSERT INTO outbox(
				idempotency_key, target_id, context_id, provider_thread_id,
				body_sha256, status, created_at
			) VALUES (?, ?, ?, ?, ?, 'sending', ?)
			ON CONFLICT(idempotency_key) DO NOTHING
		`).run(
			idempotencyKey,
			targetId,
			contextId,
			providerThreadId,
			bodySha256 ?? null,
			now(),
		);
		if (!inserted.changes) {
			const existing = this.getOutbox(idempotencyKey);
			if (
				!existing
				|| existing.targetId !== targetId
				|| existing.contextId !== contextId
				|| existing.providerThreadId !== providerThreadId
				|| (bodySha256 !== undefined && existing.bodySha256 !== bodySha256)
			) {
				throw new Error("outbox idempotency key conflicts with existing delivery");
			}
			const claimedRetry = this.database.prepare(`
				UPDATE outbox SET status = 'sending', last_error = NULL
				WHERE idempotency_key = ? AND status = 'failed'
			`).run(idempotencyKey);
			return { ...this.getOutbox(idempotencyKey), claimed: Boolean(claimedRetry.changes) };
		}
		return { ...this.getOutbox(idempotencyKey), claimed: true };
	}

	completeOutbox(idempotencyKey, providerMessageId) {
		this.database.prepare(`
			UPDATE outbox SET status = 'completed', provider_message_id = ?,
				completed_at = ?, last_error = NULL
			WHERE idempotency_key = ?
		`).run(providerMessageId, now(), idempotencyKey);
		return this.getOutbox(idempotencyKey);
	}

	completePhoneOutboxWithLedger(idempotencyKey, providerMessageId, ledgerEvent) {
		const timestamp = now();
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const updated = this.database.prepare(`
				UPDATE outbox SET status = 'completed', provider_message_id = ?,
					completed_at = ?, last_error = NULL
				WHERE idempotency_key = ? AND status = 'sending'
			`).run(providerMessageId, timestamp, idempotencyKey);
			if (updated.changes !== 1) {
				throw new Error("phone outbox is no longer claimable");
			}
			this.insertCompletedLedgerEventWithControlNotification(ledgerEvent, timestamp);
			this.database.exec("COMMIT");
			return this.getOutbox(idempotencyKey);
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	failOutbox(idempotencyKey, error) {
		this.database.prepare(`
			UPDATE outbox SET status = 'failed', last_error = ? WHERE idempotency_key = ?
		`).run(String(error).slice(0, 1000), idempotencyKey);
	}

	markOutboxUncertain(idempotencyKey, error) {
		this.database.prepare(`
			UPDATE outbox SET status = 'uncertain', last_error = ?
			WHERE idempotency_key = ? AND status = 'sending'
		`).run(String(error).slice(0, 1000), idempotencyKey);
		return this.getOutbox(idempotencyKey);
	}

	updatePhoneOutboxStatus(providerMessageId, status) {
		if (!["queued", "sent", "delivered", "failed", "rejected"].includes(status)) {
			throw new Error("unsupported phone delivery status");
		}
		this.database.prepare(`
			UPDATE outbox
			SET status = CASE
					WHEN status = 'uncertain' AND ? IN ('queued', 'sent', 'delivered') THEN 'completed'
					WHEN ? IN ('failed', 'rejected') THEN ?
					ELSE status
				END,
				last_error = CASE WHEN ? IN ('failed', 'rejected') THEN ? ELSE last_error END,
				completed_at = CASE WHEN ? IN ('queued', 'sent', 'delivered')
					THEN COALESCE(completed_at, ?) ELSE completed_at END
			WHERE provider_message_id = ?
		`).run(
			status,
			status,
			status,
			status,
			`provider reported ${status}`,
			status,
			now(),
			providerMessageId,
		);
	}

	getGmailDraft(providerDraftId) {
		const row = this.database.prepare(`
			SELECT provider_draft_id AS providerDraftId, target_id AS targetId,
				context_id AS contextId, principal_hash AS principalHash,
				contact_address AS contactAddress, to_addresses_json AS toAddressesJson,
				cc_addresses_json AS ccAddressesJson, mode,
				provider_thread_id AS providerThreadId,
				reply_to_message_id AS replyToMessageId, subject,
				body_sha256 AS bodySha256, status,
				provider_message_id AS providerMessageId,
				created_at AS createdAt, updated_at AS updatedAt, sent_at AS sentAt
			FROM gmail_drafts WHERE provider_draft_id = ?
		`).get(providerDraftId);
		if (!row) return undefined;
		let toAddresses;
		let ccAddresses;
		try {
			toAddresses = JSON.parse(row.toAddressesJson);
			ccAddresses = JSON.parse(row.ccAddressesJson);
		} catch {
			throw new Error("stored Gmail draft recipient binding is invalid");
		}
		if (!Array.isArray(toAddresses) || toAddresses.length === 0
			|| toAddresses.some((address) => typeof address !== "string")) {
			throw new Error("stored Gmail draft To binding is invalid");
		}
		if (!Array.isArray(ccAddresses) || ccAddresses.some((address) => typeof address !== "string")) {
			throw new Error("stored Gmail draft Cc binding is invalid");
		}
		const {
			toAddressesJson: _toAddressesJson,
			ccAddressesJson: _ccAddressesJson,
			...draft
		} = row;
		return { ...draft, toAddresses, ccAddresses };
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
					contact_address, to_addresses_json, cc_addresses_json, mode, provider_thread_id,
					reply_to_message_id, subject, body_sha256, status,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
			`).run(
				draft.providerDraftId,
				draft.targetId,
				draft.contextId,
				draft.principalHash,
				draft.contactAddress,
				JSON.stringify(draft.toAddresses),
				JSON.stringify(draft.ccAddresses ?? []),
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

	insertCompletedLedgerEventWithControlNotification(event, timestamp) {
		const payloadJson = event.payload === undefined ? null : JSON.stringify(event.payload);
		let stored = this.getEventByProviderMessage(event.source, event.providerMessageId);
		if (!stored) {
			const awarenessSequence = this.nextAwarenessSequence(event.contextId);
			this.database.prepare(`
				INSERT INTO events(
					id, source, provider_message_id, provider_thread_id,
					principal_hash, target_id, context_id, awareness_sequence, status, payload_json,
					received_at, available_at, updated_at, completed_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
			`).run(
				event.id,
				event.source,
				event.providerMessageId,
				event.providerThreadId,
				event.principalHash,
				event.targetId,
				event.contextId,
				awarenessSequence,
				payloadJson,
				timestamp,
				timestamp,
				timestamp,
				timestamp,
			);
			stored = this.getEventByProviderMessage(event.source, event.providerMessageId);
		}
		if (!stored
			|| stored.status !== "completed"
			|| stored.providerThreadId !== event.providerThreadId
			|| stored.principalHash !== event.principalHash
			|| stored.targetId !== event.targetId
			|| stored.contextId !== event.contextId
			|| stored.payloadJson !== payloadJson) {
			throw new Error("ledger event conflicts with existing provider state");
		}
		this.database.prepare(`
			INSERT INTO control_notifications(
				id, event_id, context_id, sequence, status, available_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
			ON CONFLICT(event_id) DO NOTHING
		`).run(
			`${event.source}:${event.providerMessageId}`,
			stored.id,
			stored.contextId,
			stored.awarenessSequence,
			timestamp,
			timestamp,
			timestamp,
		);
		return stored;
	}

	recordCompletedLedgerEvent(event) {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const timestamp = now();
			const payloadJson = event.payload === undefined ? null : JSON.stringify(event.payload);
			let stored = this.getEventByProviderMessage(event.source, event.providerMessageId);
			if (!stored) {
				const awarenessSequence = this.nextAwarenessSequence(event.contextId);
				this.database.prepare(`
					INSERT INTO events(
						id, source, provider_message_id, provider_thread_id,
						principal_hash, target_id, context_id, awareness_sequence, status, payload_json,
						received_at, available_at, updated_at, completed_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
				`).run(
					event.id,
					event.source,
					event.providerMessageId,
					event.providerThreadId,
					event.principalHash,
					event.targetId,
					event.contextId,
					awarenessSequence,
					payloadJson,
					timestamp,
					timestamp,
					timestamp,
					timestamp,
				);
				stored = this.getEventByProviderMessage(event.source, event.providerMessageId);
			}
			if (!stored
				|| stored.status !== "completed"
				|| stored.providerThreadId !== event.providerThreadId
				|| stored.principalHash !== event.principalHash
				|| stored.targetId !== event.targetId
				|| stored.contextId !== event.contextId
				|| stored.payloadJson !== payloadJson) {
				throw new Error("ledger event conflicts with existing provider state");
			}
			this.database.exec("COMMIT");
			return stored;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	recordCompletedLedgerEventWithControlNotification(event) {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const stored = this.insertCompletedLedgerEventWithControlNotification(event, now());
			this.database.exec("COMMIT");
			return stored;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	completeGmailDraftSend(
		idempotencyKey,
		providerDraftId,
		providerMessageId,
		providerThreadId,
		ledgerEvent,
	) {
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
			if (ledgerEvent) {
				this.insertCompletedLedgerEventWithControlNotification(ledgerEvent, timestamp);
			}
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

	status(maxConcurrent = 6) {
		const activeEvents = this.countActiveEvents();
		const activeContexts = this.countActiveContexts();
		const queue = this.database.prepare(`
			SELECT COUNT(*) AS count, MIN(received_at) AS oldest
			FROM events WHERE status IN ('queued', 'failed')
		`).get();
		return {
			lastSuccessfulPollAt: this.getMeta("gmail:last_successful_poll_at") ?? null,
			lastPollError: this.getMeta("gmail:last_poll_error") || null,
			principals: this.database.prepare("SELECT COUNT(*) AS count FROM principals").get().count,
			projects: this.database.prepare("SELECT COUNT(*) AS count FROM projects").get().count,
			routes: this.database.prepare("SELECT COUNT(*) AS count FROM routes").get().count,
			contexts: this.database.prepare("SELECT COUNT(*) AS count FROM contexts").get().count,
			mattermostBindings: this.database.prepare("SELECT COUNT(*) AS count FROM mattermost_bindings").get().count,
			rocketChatBindings: this.database.prepare("SELECT COUNT(*) AS count FROM rocket_chat_bindings").get().count,
			zulipBindings: this.database.prepare("SELECT COUNT(*) AS count FROM zulip_bindings").get().count,
			rocketChatPosts: this.database.prepare("SELECT COUNT(*) AS count FROM rocket_chat_posts").get().count,
			maxConcurrent,
			activeContexts,
			activeEvents,
			availableSlots: Math.max(0, maxConcurrent - activeContexts),
			queuedEvents: queue.count,
			oldestQueuedAt: queue.oldest ?? null,
			deadEvents: this.database.prepare(`
				SELECT COUNT(*) AS count FROM events WHERE status = 'dead'
			`).get().count,
			uncertainEvents: this.database.prepare(`
				SELECT COUNT(*) AS count FROM events WHERE status = 'uncertain'
			`).get().count,
			scheduledPrompts: this.database.prepare(`
				SELECT COUNT(*) AS count FROM scheduled_prompts
			`).get().count,
			armedScheduledPrompts: this.database.prepare(`
				SELECT COUNT(*) AS count FROM scheduled_prompts WHERE status = 'armed'
			`).get().count,
			invalidScheduledPrompts: this.database.prepare(`
				SELECT COUNT(*) AS count FROM scheduled_prompts WHERE status = 'invalid'
			`).get().count,
			completedScheduledOccurrences: this.database.prepare(`
				SELECT COUNT(*) AS count FROM events
				WHERE source = 'scheduled-prompt' AND status = 'completed'
			`).get().count,
			quarantinedMessages: this.database.prepare(`
				SELECT COUNT(*) AS count FROM seen_messages WHERE disposition LIKE 'quarantined:%'
			`).get().count,
			completedEvents: this.database.prepare(`
				SELECT COUNT(*) AS count FROM events WHERE status = 'completed'
			`).get().count,
				completedOutbox: this.database.prepare(`
					SELECT COUNT(*) AS count FROM outbox WHERE status = 'completed'
				`).get().count,
				uncertainOutbox: this.database.prepare(`
					SELECT COUNT(*) AS count FROM outbox WHERE status = 'uncertain'
				`).get().count,
				phoneConversations: this.database.prepare(`
					SELECT COUNT(*) AS count FROM phone_conversations
				`).get().count,
			gmailDrafts: this.database.prepare(`
				SELECT COUNT(*) AS count FROM gmail_drafts WHERE status = 'draft'
			`).get().count,
			gmailSentDrafts: this.database.prepare(`
				SELECT COUNT(*) AS count FROM gmail_drafts WHERE status = 'sent'
			`).get().count,
			pendingControlNotifications: this.database.prepare(`
				SELECT COUNT(*) AS count FROM control_notifications
				WHERE status IN ('queued', 'sending', 'failed')
			`).get().count,
			deadControlNotifications: this.database.prepare(`
				SELECT COUNT(*) AS count FROM control_notifications WHERE status = 'dead'
			`).get().count,
			completedControlNotifications: this.database.prepare(`
				SELECT COUNT(*) AS count FROM control_notifications WHERE status = 'completed'
			`).get().count,
		};
	}
}
