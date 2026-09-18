import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchScopedEvidenceSource,
	ScopedAppEvidence,
	ScopedAppEvidenceError,
} from "../src/scoped-app-evidence.mjs";

test("evidence source validation rejects local, literal, credentialed, and non-HTTPS URLs before fetch", async () => {
	for (const url of [
		"http://example.com/grants",
		"https://user:secret@example.com/grants",
		"https://127.0.0.1/grants",
		"https://[::1]/grants",
		"https://catalog.internal/grants",
		"https://localhost/grants",
	]) {
		await assert.rejects(
			fetchScopedEvidenceSource(url, "Synthetic quote"),
			(error) => error instanceof ScopedAppEvidenceError && error.status === 400,
		);
	}
});

test("evidence backend activates only for a computer-enabled runtime and preserves verified source input", async () => {
	const calls = [];
	const runtime = {
		async captureScopedEvidence(target, contextId, input) {
			calls.push({ target, contextId, input });
			return { receipt: { artifactId: input.artifactId }, artifact: { bytes: Buffer.from("synthetic") } };
		},
	};
	const target = { id: "example-agent", computer: { enabled: true } };
	const evidence = new ScopedAppEvidence({
		runtime,
		target,
		fetchSource: async (sourceUrl, exactQuote) => ({
			sourceUrl,
			sourceSha256: exactQuote === "Synthetic quote" ? "a".repeat(64) : "b".repeat(64),
		}),
	});
	assert.equal(evidence.available, true);
	assert.deepEqual(
		await evidence.verifySource({ sourceUrl: "https://example.com/grants", exactQuote: "Synthetic quote" }),
		{ sourceUrl: "https://example.com/grants", sourceSha256: "a".repeat(64) },
	);
	await evidence.capture("example-context", { artifactId: "synthetic-artifact" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].contextId, "example-context");
	assert.equal(new ScopedAppEvidence({ runtime, target: { ...target, computer: { enabled: false } } }).available, false);
});
