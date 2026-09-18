import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateRunner } from "../src/agent.js";

const root = mkdtempSync(join(tmpdir(), "local-duplex-transcript-"));
process.env.PI_AGENT_DIR = join(root, "agent-config");
process.env.PI_OFFLINE = "1";

try {
	writeFileSync(join(root, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
	writeFileSync(join(root, "AGENTS.md"), "Synthetic local duplex transcript test.\n");
	const awareness = join(root, "awareness");
	const runner = await getOrCreateRunner({ type: "host" }, awareness, "Be concise.");
	const sessionId = "synthetic-call-1";
	const first = {
		sessionId,
		sequence: 0,
		role: "user" as const,
		text: "Exact synthetic human transcript.",
		timestamp: 1_800_000_000_000,
	};
	const second = {
		sessionId,
		sequence: 1,
		role: "assistant" as const,
		text: "Exact synthetic duplex reply.",
		timestamp: 1_800_000_000_800,
	};

	await runner.appendLocalDuplexTranscript(first);
	await runner.appendLocalDuplexTranscript(second);
	const contextPath = join(awareness, "context.jsonl");
	const initial = readFileSync(contextPath, "utf8");
	assert(initial.includes("Source event: computer_local_duplex_transcript"));
	assert(initial.includes("Exact synthetic human transcript."));
	assert(initial.includes("Exact synthetic duplex reply."));
	assert(!initial.includes("PRIVATE CONTINUITY CHECKPOINT"));

	await runner.appendLocalDuplexTranscript(second);
	assert.equal(readFileSync(contextPath, "utf8"), initial, "an exact retry is idempotent");
	await assert.rejects(
		runner.appendLocalDuplexTranscript({ ...second, text: "Conflicting replay." }),
		/Conflicting local duplex transcript replay/,
	);
	await assert.rejects(
		runner.appendLocalDuplexTranscript({ ...second, sequence: 3, text: "Skipped sequence." }),
		/Out-of-order local duplex transcript: expected 2/,
	);
	await runner.closeLocalDuplexTranscriptSession(sessionId);
	await assert.rejects(
		runner.appendLocalDuplexTranscript({ ...second, sequence: 2, text: "After close." }),
		/Local duplex transcript session is closed/,
	);
	assert.equal(readFileSync(contextPath, "utf8"), initial, "invalid and post-close turns are not durable");

	await runner.appendLocalDuplexTranscript({
		sessionId: "synthetic-live-observation", sequence: 0, role: "user", observation: true,
		text: "[room 10–100ms] Maybe\n[assistant 50–200ms] overlapping fragment",
		timestamp: 1_800_000_002_000,
	});
	const observed = readFileSync(contextPath, "utf8").slice(initial.length);
	assert(observed.includes("NOT a new user request"));
	assert(observed.includes("Room speakers are unverified"));
	assert(observed.includes("[assistant 50–200ms] overlapping fragment"));
	assert(!observed.includes("Directly addressed: yes"));
	await assert.rejects(runner.appendLocalDuplexTranscript({
		sessionId: "synthetic-live-observation", sequence: 1, role: "assistant", observation: true,
		text: "must not become canonical assistant final", timestamp: 1_800_000_003_000,
	}), /Invalid live observation role/);
	console.log("local duplex transcript: ok");
} finally {
	await rm(root, { recursive: true, force: true });
}
