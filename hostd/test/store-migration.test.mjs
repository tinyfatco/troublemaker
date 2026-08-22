import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HostStore } from "../src/store.mjs";

test("existing principal rows gain verified contact and display columns without losing state", () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-migration-"));
	const path = join(directory, "state.sqlite");
	const legacy = new DatabaseSync(path);
	legacy.exec(`
		CREATE TABLE principals (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		);
		INSERT INTO principals(id, created_at, last_seen_at)
		VALUES ('fake-principal', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
	`);
	legacy.close();

	const store = new HostStore(path);
	try {
		assert.equal(store.ensurePrincipal("fake-principal").emailAddress, null);
		assert.equal(
			store.setPrincipalEmail("fake-principal", "person@example.com").emailAddress,
			"person@example.com",
		);
		assert.equal(
			store.setPrincipalLabel("fake-principal", "Example Person").displayLabel,
			"Example Person",
		);
		assert.equal(
			store.setPrincipalLabel("fake-principal", "Replacement").displayLabel,
			"Example Person",
			"the first verified display label remains stable",
		);
		assert.throws(
			() => store.setPrincipalEmail("fake-principal", "other@example.com"),
			/principal contact cannot be changed/,
		);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("legacy site bindings recover the actor identity that existed before a context rehome", () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-site-actor-migration-"));
	const path = join(directory, "state.sqlite");
	const legacyContextId = "operator:example-principal:intake";
	const currentContextId = "operator:example-principal:relationship";
	const legacy = new DatabaseSync(path);
	legacy.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE contexts (
			id TEXT PRIMARY KEY,
			target_id TEXT NOT NULL,
			driver TEXT NOT NULL,
			runtime_name TEXT,
			port INTEGER,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		);
		CREATE TABLE context_rehomes (
			id TEXT PRIMARY KEY,
			from_context_id TEXT NOT NULL,
			to_context_id TEXT NOT NULL,
			target_id TEXT NOT NULL,
			relationship_id TEXT,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE site_deployment_bindings (
			context_id TEXT NOT NULL,
			site_slug TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			site_id TEXT NOT NULL UNIQUE,
			grant_id TEXT NOT NULL UNIQUE,
			customer_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			project_id TEXT NOT NULL UNIQUE,
			preview_hostname TEXT NOT NULL UNIQUE,
			artifact_kinds_json TEXT NOT NULL,
			allowed_branches_json TEXT NOT NULL,
			status TEXT NOT NULL,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (context_id, site_slug),
			FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
		);
		INSERT INTO contexts(
			id, target_id, driver, runtime_name, port, status, created_at, last_seen_at
		) VALUES (
			'${currentContextId}', 'operator', 'oci', 'relationship-runtime', 32001, 'stopped',
			'2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
		);
		INSERT INTO context_rehomes(
			id, from_context_id, to_context_id, target_id, relationship_id, reason, created_at
		) VALUES (
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${legacyContextId}', '${currentContextId}',
			'operator', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
			'relationship_operator_custody', '2026-01-02T00:00:00.000Z'
		);
		INSERT INTO site_deployment_bindings(
			context_id, site_slug, display_name, site_id, grant_id, customer_id, user_id,
			project_id, preview_hostname, artifact_kinds_json, allowed_branches_json,
			status, created_at, updated_at
		) VALUES
		(
			'${currentContextId}', 'legacy-example', 'Legacy Example',
			'11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
			'33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
			'55555555-5555-4555-8555-555555555555', 'legacy-example.tinyfat.dev',
			'["static"]', '["*"]', 'active',
			'2026-01-01T12:00:00.000Z', '2026-01-01T12:00:00.000Z'
		),
		(
			'${currentContextId}', 'current-example', 'Current Example',
			'66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777',
			'33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
			'88888888-8888-4888-8888-888888888888', 'current-example.tinyfat.dev',
			'["static"]', '["*"]', 'active',
			'2026-01-03T12:00:00.000Z', '2026-01-03T12:00:00.000Z'
		);
	`);
	legacy.close();

	const store = new HostStore(path);
	try {
		assert.equal(
			store.getSiteDeploymentBinding(currentContextId, "legacy-example").actorRef,
			`hostd-context:${createHash("sha256").update(legacyContextId).digest("hex")}`,
		);
		assert.equal(
			store.getSiteDeploymentBinding(currentContextId, "current-example").actorRef,
			`hostd-context:${createHash("sha256").update(currentContextId).digest("hex")}`,
		);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
