import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { HostStore } from "../src/store.mjs";
import { OWNED_WORK_CANARY_HOLD_META } from "../src/owned-work-canary-hold.mjs";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-owned-work-canary-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const contextId = "operator:neutral:intake";
	store.createContext({ id: contextId, targetId: "operator", driver: "oci", runtimeName: "runtime-neutral", port: 32123 });
	return { store, contextId, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function authorization(deliveryId) {
	return {
		version: 1, nonce: "neutral-nonce", contextId: "operator:neutral:intake", deliveryId,
		source: "zulip", senderId: 42, senderIsBot: true, channelId: "7", topic: "neutral topic",
		bodySha256: "a".repeat(64), phoneConfigSha256: "d".repeat(64),
		phoneHoldStateSha256: "e".repeat(64), expiresAt: new Date(Date.now() + 120_000).toISOString(),
		candidateSha: "b".repeat(40), leaseSeconds: 5, deadlineMs: 90_000,
	};
}

function enqueue(store, contextId, id, payload) {
	return store.upsertEvent({
		id, source: "zulip", providerMessageId: `provider-${id}`, providerThreadId: "channel:7",
		principalHash: "neutral", targetId: "operator", contextId, payload,
	});
}

function leaseDurationSeconds(event) {
	return (Date.parse(event.leaseExpiresAt) - Date.now()) / 1000;
}

test("authorization absence preserves the normal configured lease", () => {
	const subject = fixture();
	try {
		enqueue(subject.store, subject.contextId, "normal-zulip", { message: { id: 1 } });
		const claimed = subject.store.claimNextEvent({ leaseSeconds: 61 });
		assert.equal(claimed.id, "normal-zulip");
		assert.ok(leaseDurationSeconds(claimed) > 59.5);
		assert.ok(leaseDurationSeconds(claimed) <= 61.5);
	} finally { subject.close(); }
});

test("short lease requires the exact atomically consumed delivery authorization", () => {
	const subject = fixture();
	try {
		const deliveryId = "canary-neutral";
		const auth = authorization(deliveryId);
		enqueue(subject.store, subject.contextId, deliveryId, { message: { id: -1 }, ownedWorkCanary: auth });
		subject.store.database.prepare(`
			INSERT INTO owned_work_canary_authorizations(
				delivery_id, authorization_json, lease_seconds, expires_at, consumed_at, consumed_by, created_at
			) VALUES (?, ?, ?, ?, NULL, NULL, ?)
		`).run(deliveryId, JSON.stringify(auth), auth.leaseSeconds, auth.expiresAt, new Date().toISOString());
		assert.throws(() => subject.store.claimNextEvent({ leaseSeconds: 61 }), /not atomically consumed/);
		assert.equal(subject.store.getEvent(deliveryId).attempts, 0);
		subject.store.database.prepare(`
			UPDATE owned_work_canary_authorizations
			SET consumed_at = ?, consumed_by = 'root-coordinator-v1' WHERE delivery_id = ?
		`).run(new Date().toISOString(), deliveryId);
		const claimed = subject.store.claimNextEvent({ leaseSeconds: 61 });
		assert.equal(claimed.id, deliveryId);
		assert.equal(claimed.attempts, 1);
		assert.ok(leaseDurationSeconds(claimed) > 3.5);
		assert.ok(leaseDurationSeconds(claimed) <= 5.5);
	} finally { subject.close(); }
});

test("wrong-delivery authorization cannot grant a short lease", () => {
	const subject = fixture();
	try {
		const deliveryId = "canary-neutral";
		const auth = authorization("different-delivery");
		enqueue(subject.store, subject.contextId, deliveryId, { message: { id: -1 }, ownedWorkCanary: auth });
		subject.store.database.prepare(`
			INSERT INTO owned_work_canary_authorizations(
				delivery_id, authorization_json, lease_seconds, expires_at, consumed_at, consumed_by, created_at
			) VALUES (?, ?, ?, ?, ?, 'root-coordinator-v1', ?)
		`).run(deliveryId, JSON.stringify(auth), auth.leaseSeconds, auth.expiresAt, new Date().toISOString(), new Date().toISOString());
		assert.throws(() => subject.store.claimNextEvent({ leaseSeconds: 61 }), /not atomically consumed/);
		assert.equal(subject.store.getEvent(deliveryId).attempts, 0);
	} finally { subject.close(); }
});

test("accepted cleanup removes only authorization artifacts and preserves canonical evidence byte-for-byte", () => {
	const subject = fixture();
	const databasePath = subject.store.database.prepare("PRAGMA database_list").all().find((row) => row.name === "main").file;
	const ledgerPath = join(databasePath, "..", "zulip-inbound-deliveries.jsonl");
	const deliveryId = "canary-cleanup-neutral";
	try {
		const auth = authorization(deliveryId);
		enqueue(subject.store, subject.contextId, deliveryId, {
			message: { id: -1 },
			ownedWorkCanary: auth,
		});
		const capability = "neutral-capability-value-0123456789abcdef0123456789abcdef";
		subject.store.issueZulipTopicCapability({
			deliveryId,
			contextId: subject.contextId,
			channelId: 7,
			topic: auth.topic,
			capability,
		});
		subject.store.authorizeZulipTopicCapability({
			deliveryId,
			contextId: subject.contextId,
			channelId: 7,
			topic: auth.topic,
			capability,
		});
		subject.store.closeZulipTopicCapability({ deliveryId, contextId: subject.contextId, capability });
		subject.store.database.prepare(`
			INSERT INTO owned_work_canary_authorizations(
				delivery_id,authorization_json,lease_seconds,expires_at,consumed_at,consumed_by,created_at
			) VALUES (?,?,?,?,? ,'root-coordinator-v1',?)
		`).run(deliveryId, JSON.stringify(auth), auth.leaseSeconds, auth.expiresAt, new Date().toISOString(), new Date().toISOString());
		subject.store.database.prepare(`
			UPDATE events SET status='completed',attempts=2,completed_at=?,updated_at=? WHERE id=?
		`).run(new Date().toISOString(), new Date().toISOString(), deliveryId);
		writeFileSync(ledgerPath, [
			JSON.stringify({ deliveryId, claimedAt: new Date().toISOString() }),
			JSON.stringify({ deliveryId, completedAt: new Date().toISOString() }),
		].join("\n") + "\n", { mode: 0o600 });
		subject.store.setMeta(OWNED_WORK_CANARY_HOLD_META, JSON.stringify({ test: "aborted" }));
		const eventBefore = JSON.stringify(subject.store.database.prepare("SELECT * FROM events WHERE id=?").get(deliveryId));
		const capabilityBefore = JSON.stringify(subject.store.database.prepare("SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?").get(deliveryId));
		const sequenceBefore = JSON.stringify(subject.store.database.prepare("SELECT * FROM awareness_sequences WHERE context_id=?").get(subject.contextId));
		const outboxBefore = JSON.stringify(subject.store.database.prepare("SELECT * FROM outbox ORDER BY id").all());
		const ledgerBefore = readFileSync(ledgerPath, "utf8");
		subject.store.close();
		const result = spawnSync("python3", [
			join(import.meta.dirname, "..", "runtime", "owned-work-canary-cleanup.py"),
			"--database", databasePath,
			"--delivery-id", deliveryId,
			"--context-id", subject.contextId,
			"--outcome", "accepted",
		], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const database = new DatabaseSync(databasePath, { readOnly: true });
		assert.equal(JSON.stringify(database.prepare("SELECT * FROM events WHERE id=?").get(deliveryId)), eventBefore);
		assert.equal(JSON.stringify(database.prepare("SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?").get(deliveryId)), capabilityBefore);
		assert.equal(JSON.stringify(database.prepare("SELECT * FROM awareness_sequences WHERE context_id=?").get(subject.contextId)), sequenceBefore);
		assert.equal(JSON.stringify(database.prepare("SELECT * FROM outbox ORDER BY id").all()), outboxBefore);
		assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owned_work_canary_authorizations'").get(), undefined);
		database.close();
		assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore);
	} finally {
		try { subject.store.close(); } catch {}
		rmSync(join(databasePath, ".."), { recursive: true, force: true });
	}
});

test("aborted cleanup drops only temporary authorization after terminal containment", () => {
	const subject = fixture();
	const databasePath = subject.store.database.prepare("PRAGMA database_list").all().find((row) => row.name === "main").file;
	const deliveryId = "canary-aborted-neutral";
	try {
		const auth = authorization(deliveryId);
		enqueue(subject.store, subject.contextId, deliveryId, { message: { id: -2 }, ownedWorkCanary: auth });
		const capability = "neutral-abort-capability-0123456789abcdef0123456789abcdef";
		subject.store.issueZulipTopicCapability({
			deliveryId, contextId: subject.contextId, channelId: 7, topic: auth.topic, capability,
		});
		subject.store.closeZulipTopicCapability({ deliveryId, contextId: subject.contextId, capability });
		subject.store.database.prepare(`
			INSERT INTO owned_work_canary_authorizations(
				delivery_id,authorization_json,lease_seconds,expires_at,consumed_at,consumed_by,created_at
			) VALUES (?,?,?,?,?,'root-coordinator-v1',?)
		`).run(deliveryId, JSON.stringify(auth), auth.leaseSeconds, auth.expiresAt, new Date().toISOString(), new Date().toISOString());
		subject.store.database.prepare(`
			UPDATE events SET status='dead',attempts=1,lease_token=NULL,lease_expires_at=NULL,
				last_error='owned_work_canary_aborted',updated_at=? WHERE id=?
		`).run(new Date().toISOString(), deliveryId);
		subject.store.setMeta(OWNED_WORK_CANARY_HOLD_META, JSON.stringify({ test: "aborted" }));
		const eventBefore = JSON.stringify(subject.store.database.prepare("SELECT * FROM events WHERE id=?").get(deliveryId));
		const capabilityBefore = JSON.stringify(subject.store.database.prepare("SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?").get(deliveryId));
		const sequenceBefore = JSON.stringify(subject.store.database.prepare("SELECT * FROM awareness_sequences WHERE context_id=?").get(subject.contextId));
		const outboxBefore = JSON.stringify(subject.store.database.prepare("SELECT * FROM outbox ORDER BY id").all());
		subject.store.close();
		const result = spawnSync("python3", [
			join(import.meta.dirname, "..", "runtime", "owned-work-canary-cleanup.py"),
			"--database", databasePath,
			"--delivery-id", deliveryId,
			"--context-id", subject.contextId,
			"--outcome", "aborted",
		], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const database = new DatabaseSync(databasePath, { readOnly: true });
		assert.equal(JSON.stringify(database.prepare("SELECT * FROM events WHERE id=?").get(deliveryId)), eventBefore);
		assert.equal(JSON.stringify(database.prepare("SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?").get(deliveryId)), capabilityBefore);
		assert.equal(JSON.stringify(database.prepare("SELECT * FROM awareness_sequences WHERE context_id=?").get(subject.contextId)), sequenceBefore);
		assert.equal(JSON.stringify(database.prepare("SELECT * FROM outbox ORDER BY id").all()), outboxBefore);
		assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='owned_work_canary_authorizations'").get(), undefined);
		database.close();
	} finally {
		try { subject.store.close(); } catch {}
		rmSync(join(databasePath, ".."), { recursive: true, force: true });
	}
});

test("prepare binds an explicit bot-authored mention and exact held-context fingerprints", (t) => {
	if ((process.getuid?.() ?? 1) === 0) return t.skip("prepare intentionally rejects root");
	const subject = fixture();
	const databasePath = subject.store.database.prepare("PRAGMA database_list").all().find((row) => row.name === "main").file;
	const directory = join(databasePath, "..");
	const configPath = join(directory, "config.json");
	const promptPath = join(directory, "prompt.txt");
	const configBytes = Buffer.from(`{"phone":{"deliveryHolds":["${subject.contextId}"]}}`);
	writeFileSync(configPath, configBytes, { mode: 0o640 });
	writeFileSync(promptPath, "neutral diagnostic", { mode: 0o600 });
	subject.store.close();
	const baseArgs = [
		join(import.meta.dirname, "..", "runtime", "owned-work-canary-prepare.py"),
		"--database", databasePath,
		"--config", configPath,
		"--context-id", subject.contextId,
		"--principal-hash", "neutral-principal",
		"--channel-id", "7",
		"--channel-name", "neutral-channel",
		"--topic", "neutral topic",
		"--sender-id", "42",
		"--sender-email", "relay-bot@example.com",
		"--sender-name", "Relay Bot",
		"--agent-name", "Operator",
		"--prompt-file", promptPath,
		"--candidate-sha", "b".repeat(40),
		"--lease-seconds", "5",
		"--deadline-seconds", "90",
	];
	try {
		const missingKind = spawnSync("python3", baseArgs, { encoding: "utf8" });
		assert.notEqual(missingKind.status, 0);
		assert.match(missingKind.stderr, /the following arguments are required: --sender-is-bot/);
		const prepared = spawnSync("python3", [...baseArgs, "--sender-is-bot"], { encoding: "utf8" });
		assert.equal(prepared.status, 0, prepared.stderr);
		const auth = JSON.parse(prepared.stdout);
		assert.equal(auth.senderId, 42);
		assert.equal(auth.senderIsBot, true);
		assert.equal(auth.phoneConfigSha256, createHash("sha256").update(configBytes).digest("hex"));
		const expectedHold = JSON.stringify({
			contextId: subject.contextId,
			held: true,
			deliveryHolds: [subject.contextId],
		});
		assert.equal(auth.phoneHoldStateSha256, createHash("sha256").update(expectedHold).digest("hex"));
		const database = new DatabaseSync(databasePath, { readOnly: true });
		const event = database.prepare("SELECT payload_json,status,attempts FROM events WHERE id=?").get(auth.deliveryId);
		const payload = JSON.parse(event.payload_json);
		assert.equal(event.status, "canary-blocked");
		assert.equal(event.attempts, 0);
		assert.equal(payload.message.sender_id, 42);
		assert.equal(payload.message.sender_is_bot, true);
		assert.equal(payload.message.is_mentioned, true);
		assert.deepEqual(payload.message.flags, ["mentioned"]);
		assert.deepEqual(payload.ownedWorkCanary, auth);
		database.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
