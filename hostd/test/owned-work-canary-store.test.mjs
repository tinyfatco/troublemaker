import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { HostStore } from "../src/store.mjs";

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
		source: "zulip", senderId: 42, channelId: "7", topic: "neutral topic",
		bodySha256: "a".repeat(64), expiresAt: new Date(Date.now() + 120_000).toISOString(),
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
