import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COMPACTION } from "../src/context.js";
import { measureContextComposition } from "../src/compaction-observability.js";
import { parseStructuredCheckpoint } from "../src/extensions/structured-compaction.js";
import {
	resolveRuntimeContextIdentity,
	sameRuntimeContext,
	UNIFIED_RUNTIME_CONTEXT_KEY,
} from "../src/runtime-context.js";
import { SessionContextProjector } from "../src/session-context-projection.js";
import { boundToolResultToArtifact } from "../src/tools/tool-result-artifacts.js";

const workspace = "/workspace";
const first = resolveRuntimeContextIdentity(workspace, { channel: "25", threadTs: "2026-08-07" }, "zulip");
const same = resolveRuntimeContextIdentity(workspace, { channel: "25", threadTs: " 2026-08-07 " }, "zulip");
const caseVariant = resolveRuntimeContextIdentity(workspace, { channel: "25", threadTs: "BUILD" }, "zulip");
const normalizedCase = resolveRuntimeContextIdentity(workspace, { channel: "25", threadTs: "build" }, "zulip");
const second = resolveRuntimeContextIdentity(workspace, { channel: "25", threadTs: "2026-08-08" }, "zulip");
const otherStream = resolveRuntimeContextIdentity(workspace, { channel: "26", threadTs: "2026-08-07" }, "zulip");
const dm = resolveRuntimeContextIdentity(workspace, { channel: "dm:8,12" }, "zulip");
const slack = resolveRuntimeContextIdentity(workspace, { channel: "C0123456789", threadTs: "1700000000.000100" }, "slack");

assert.equal(first.kind, "zulip-topic");
assert.equal(first.key, same.key, "topic whitespace normalizes to the same durable context");
assert.equal(caseVariant.key, normalizedCase.key, "Zulip topic case does not fork accidental duplicate contexts");
assert.notEqual(first.key, second.key, "new topic creates a new runtime context");
assert.notEqual(first.key, otherStream.key, "same topic name in another stream remains isolated");
assert.match(first.awarenessDir, /awareness\/threads\/zulip\/stream-25\/[a-f0-9]{24}$/);
assert.equal(dm.key, UNIFIED_RUNTIME_CONTEXT_KEY, "Zulip DMs retain unified awareness");
assert.equal(slack.key, UNIFIED_RUNTIME_CONTEXT_KEY, "non-Zulip transports retain unified awareness");
assert.equal(sameRuntimeContext(workspace, { channel: "25", threadTs: "Build" }, "zulip", { channel: "25", threadTs: "build" }, "zulip"), true);
assert.equal(sameRuntimeContext(workspace, { channel: "25", threadTs: "Build" }, "zulip", { channel: "25", threadTs: "Review" }, "zulip"), false);

const projector = new SessionContextProjector();
const full = projector.project({ Attending: "example", Channels: "25 #example-project", Memory: "alpha" });
assert.equal(full.mode, "full");
assert.match(full.text, /<session_context hash=/);
assert.match(full.text, /alpha/);
const reference = projector.project({ Attending: "example", Channels: "25 #example-project", Memory: "alpha" });
assert.equal(reference.mode, "reference");
assert.ok(reference.text.length < 180, "unchanged session context becomes a small hash reference");
assert.doesNotMatch(reference.text, /alpha/);
const delta = projector.project({ Attending: "example", Channels: "25 #example-project", Memory: "beta" });
assert.equal(delta.mode, "delta");
assert.deepEqual(delta.changedSections, ["Memory"]);
assert.match(delta.text, /beta/);
assert.doesNotMatch(delta.text, /25 #example-project/, "unchanged mappings are not reinjected in a delta");
projector.reset();
assert.equal(projector.project({ Attending: "example", Channels: "25 #example-project", Memory: "beta" }).mode, "full");

assert.equal(DEFAULT_COMPACTION.thresholdPercent, 0.75);
assert.equal(DEFAULT_COMPACTION.keepRecentTokens, 60_000);

const temp = mkdtempSync(join(tmpdir(), "tool-result-artifact-"));
try {
	const small = boundToolResultToArtifact({ workspaceDir: temp, toolName: "read", toolCallId: "call-small", result: "ok", maxInlineChars: 2_000 });
	assert.equal(small.result, "ok");
	assert.equal(small.artifact, undefined);

	const largeText = `${"a".repeat(18_000)}${"z".repeat(10_000)}TAIL-MARKER`;
	const large = boundToolResultToArtifact({ workspaceDir: temp, toolName: "read", toolCallId: "call-large", result: largeText, maxInlineChars: 4_000 });
	assert.ok(large.artifact);
	const artifactPath = join(temp, large.artifact!.path);
	assert.equal(readFileSync(artifactPath, "utf8"), largeText);
	assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
	assert.equal(large.artifact!.sha256, createHash("sha256").update(largeText).digest("hex"));
	assert.match(String(large.result), /Full output: awareness\/artifacts\/tool-results/);
	assert.match(String(large.result), /TAIL-MARKER/);
	assert.ok(String(large.result).length < 5_000, "large output is bounded in model context");
} finally {
	rmSync(temp, { recursive: true, force: true });
}

const composition = measureContextComposition([
	{ role: "user", content: `<session_context hash="one">stable</session_context>\n<delivery_context>route</delivery_context>\nhello` },
	{ role: "assistant", content: [{ type: "text", text: "response" }] },
	{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
	{ role: "compactionSummary", summary: "checkpoint" },
]);
assert.equal(composition.messageCount, 4);
assert.equal(composition.summaryDepth, 1);
assert.ok(composition.characters.sessionContext > 0);
assert.ok(composition.characters.deliveryContext > 0);
assert.equal(composition.characters.toolResults, "tool output".length);

const validCheckpoint = parseStructuredCheckpoint(`\n\`\`\`json\n${JSON.stringify({
	schemaVersion: 1,
	durableState: {
		goals: [], constraints: [], decisions: [], completed: [], pending: [], blockers: [], artifacts: [], uncertainties: [], superseded: [],
	},
	narrative: "Continue from the typed state.",
})}\n\`\`\``);
assert.ok(validCheckpoint);
assert.equal(parseStructuredCheckpoint('{"schemaVersion":2,"durableState":{},"narrative":"bad"}'), null);
assert.equal(parseStructuredCheckpoint('{"schemaVersion":1,"durableState":{}}'), null);

const cliSource = readFileSync(new URL("../src/host/node/cli.ts", import.meta.url), "utf8");
assert.match(cliSource, /awarenessByContext = new Map/, "host retains one runner per runtime context");
assert.match(cliSource, /activeDeliveryScope\.contextKey !== incomingIdentity\.key/, "cross-context input queues instead of steering");
assert.match(cliSource, /Removed unconditional scheduled compaction file/, "boot removes the legacy daily semantic compaction job");
assert.doesNotMatch(cliSource, /schedule: "0 10 \* \* \*"/, "daily semantic compaction is no longer seeded");

console.log("context threads and compaction optimization: ok");
