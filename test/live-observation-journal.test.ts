import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveObservationJournal } from "../src/live-observation-journal.js";

const root = mkdtempSync(join(tmpdir(), "live-observation-journal-"));
try {
	const file = join(root, "journal.json");
	let release!: () => void;
	const busy = new Promise<void>(resolve => { release = resolve; });
	let closed!: () => void;
	const drained = new Promise<void>(resolve => { closed = resolve; });
	const applied: string[] = [];
	const journal = new LiveObservationJournal(file, {
		append: async turn => { await busy; applied.push(`append:${turn.sequence}`); },
		close: async () => { applied.push("close"); closed(); },
	});
	const turn = { sessionId: "synthetic-live", sequence: 0, role: "user" as const,
		observation: true, text: "[room 1–50ms] unfinished", timestamp: 1_800_000_000_000 };
	journal.accept(turn);
	journal.accept({ ...turn, sequence: 1, text: "[assistant 10–70ms] overlapping" });
	journal.accept(turn); // exact receipt replay is idempotent even while backend is busy
	journal.close(turn.sessionId);
	assert.equal(journal.pendingCount, 3);
	assert.deepEqual(applied, [], "durable acceptance does not wait on running tools or start inference");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	const saved = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(saved.pending.length, 3);
	assert.equal(saved.inFlight, true);
	assert.throws(() => journal.accept({ ...turn, text: "changed replay" }), /Conflicting/);
	assert.throws(() => journal.accept({ ...turn, sequence: 2 }), /closed/);

	// A crash while an append may have committed is quarantined, never blindly
	// replayed. The exact context remains in the owner-only journal for recovery.
	const crashFile = join(root, "crash.json");
	writeFileSync(crashFile, JSON.stringify(saved), { mode: 0o600 });
	let replayed = false;
	const recovered = new LiveObservationJournal(crashFile, {
		append: async () => { replayed = true; }, close: async () => { replayed = true; },
	});
	assert.equal(recovered.healthy, false);
	assert.equal(replayed, false);
	assert.throws(() => recovered.accept(turn), /blocked/);
	assert.equal(recovered.pendingCount, 3);

	release(); await drained; await Promise.resolve();
	assert.deepEqual(applied, ["append:0", "append:1", "close"]);
	assert.equal(journal.pendingCount, 0);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).inFlight, false);
	assert.equal(journal.healthy, true);
	console.log("live observation journal: ok");
} finally { await rm(root, { recursive: true, force: true }); }
