import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HostStore } from "../src/store.mjs";

test("existing principal rows gain a verified contact column without losing state", () => {
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
		assert.throws(
			() => store.setPrincipalEmail("fake-principal", "other@example.com"),
			/principal contact cannot be changed/,
		);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
