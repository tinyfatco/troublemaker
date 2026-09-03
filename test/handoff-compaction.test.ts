import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	extractStructuredHandoff,
	HANDOFF_CLOSE,
	HANDOFF_OPEN,
	MAX_HANDOFF_ITEMS,
	MAX_HANDOFF_STRING_LENGTH,
	joinPublicHandoffParts,
	projectPublicHandoffText,
	projectPublicHandoffParts,
	handoffInstruction,
	sanitizeHandoffMessage,
	sanitizePrivateHandoffSessionLine,
	readHandoffJournal,
	replayHandoffRotation,
	selectCompleteRecentTail,
	shouldRequestHandoff,
	writeHandoffJournal,
} from "../src/handoff-compaction.js";
import { DEFAULT_COMPACTION, MomSettingsManager } from "../src/context.js";

const captures = JSON.parse(readFileSync(new URL("fixtures/handoff-captured-sessions.json", import.meta.url), "utf8"));
for (const capture of captures) {
	const raw = `${capture.publicText}${HANDOFF_OPEN}${JSON.stringify(capture.handoff)}${HANDOFF_CLOSE}`;
	for (let split = 0; split <= raw.length; split++) {
		const firstProjection = projectPublicHandoffText(raw.slice(0, split));
		const secondProjection = projectPublicHandoffText(raw);
		assert(!firstProjection.includes("troublemaker_private_handoff"), `${capture.name}: delimiter leaked at split ${split}`);
		assert(!firstProjection.includes(capture.handoff.goal), `${capture.name}: private payload leaked at split ${split}`);
		assert.equal(secondProjection, capture.publicText, `${capture.name}: final public text remains exact`);
	}
	const extracted = extractStructuredHandoff(raw);
	assert.deepEqual(extracted, { publicText: capture.publicText, handoff: capture.handoff });
}

assert.equal(projectPublicHandoffText("normal final text", true), "normal final text");
assert.equal(projectPublicHandoffText(`normal${HANDOFF_OPEN.slice(0, -1)}`, true), "normal", "terminal delimiter fragments fail closed");
const splitParts = ["answer", HANDOFF_OPEN.slice(0, 11), HANDOFF_OPEN.slice(11), JSON.stringify(captures[0].handoff), HANDOFF_CLOSE];
assert.deepEqual(projectPublicHandoffParts(splitParts, true), ["answer", "", "", "", ""], "delimiter split across text content parts stays private");
assert.equal(
	joinPublicHandoffParts(["answer", "", `${HANDOFF_OPEN}${JSON.stringify(captures[0].handoff)}${HANDOFF_CLOSE}`], true),
	"answer\n",
	"intentional empty public text blocks preserve established newline semantics before the private boundary",
);
assert.equal(extractStructuredHandoff(`answer${HANDOFF_OPEN}{bad json}${HANDOFF_CLOSE}`), null, "malformed checkpoints fail closed");
const forged = structuredClone(captures[0].handoff);
forged.routing = { channel: "forged-channel", replyTarget: "forged-target" };
const bound = extractStructuredHandoff(
	`answer${HANDOFF_OPEN}${JSON.stringify(forged)}${HANDOFF_CLOSE}`,
	{ channel: "C0123456789", replyTarget: "1700000000.000001" },
);
assert.deepEqual(bound?.handoff.routing, { channel: "C0123456789", replyTarget: "1700000000.000001" }, "trusted runtime routing replaces model-supplied routing");
const oversizedString = structuredClone(captures[0].handoff);
oversizedString.goal = "x".repeat(MAX_HANDOFF_STRING_LENGTH + 1);
assert.equal(extractStructuredHandoff(`${HANDOFF_OPEN}${JSON.stringify(oversizedString)}${HANDOFF_CLOSE}`), null, "oversized strings fail closed");
const oversizedArray = structuredClone(captures[0].handoff);
oversizedArray.constraints = Array.from({ length: MAX_HANDOFF_ITEMS + 1 }, () => "bounded item");
assert.equal(extractStructuredHandoff(`${HANDOFF_OPEN}${JSON.stringify(oversizedArray)}${HANDOFF_CLOSE}`), null, "oversized arrays fail closed");
const oversizedTotal = structuredClone(captures[0].handoff);
oversizedTotal.constraints = Array.from({ length: 20 }, () => "x".repeat(4_000));
assert.equal(extractStructuredHandoff(`${HANDOFF_OPEN}${JSON.stringify(oversizedTotal)}${HANDOFF_CLOSE}`), null, "oversized serialized checkpoints fail closed");
assert.equal(DEFAULT_COMPACTION.mode, "native", "native compaction remains the safe default");
assert.equal(shouldRequestHandoff(164_000, 200_000, 16_000, 20_000), true);
assert.equal(shouldRequestHandoff(163_999, 200_000, 16_000, 20_000), false);

const root = mkdtempSync(join(tmpdir(), "troublemaker-handoff-"));
try {
	const settings = new MomSettingsManager(root);
	assert.equal(settings.getCompactionSettings().mode, "native");
	const journalPath = join(root, "journal.json");
	const journal = { version: 1 as const, id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-01-01T00:00:00.000Z", archivePath: join(root, "archive.jsonl"), handoff: captures[0].handoff, tail: [] };
	writeHandoffJournal(journalPath, journal);
	assert.deepEqual(readHandoffJournal(journalPath), journal, "restart journal round-trips exactly");
	const awarenessDir = join(root, "awareness");
	const contextFile = join(awarenessDir, "context.jsonl");
	const source = SessionManager.open(contextFile, awarenessDir);
	source.appendMessage({ role: "user", content: [{ type: "text", text: "archived source" }], timestamp: 1 } as any);
	journal.tail = [
		{ role: "user", content: [{ type: "text", text: "recent" }] },
		{ role: "assistant", content: [{ type: "text", text: "recent answer" }] },
	] as any;
	writeHandoffJournal(journalPath, journal);
	await replayHandoffRotation(contextFile, awarenessDir, journalPath, journal);
	writeHandoffJournal(journalPath, journal); // crash after replay but before journal unlink
	await replayHandoffRotation(contextFile, awarenessDir, journalPath, journal);
	const replayed = SessionManager.open(contextFile, awarenessDir);
	assert.equal(replayed.getEntries().filter((entry) => entry.type === "custom_message").length, 1, "recovery replay is idempotent");
	assert.deepEqual(replayed.buildSessionContext().messages.slice(1), journal.tail, "recovery retains the complete recent tail exactly once");
	assert.equal((replayed.getEntries()[0] as any).display, false, "continuity handoff is hidden from conversation rendering");
} finally {
	await rm(root, { recursive: true, force: true });
}

const messages = [
	{ role: "user", content: [{ type: "text", text: "old" }] },
	{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
	{ role: "user", content: [{ type: "text", text: "recent" }] },
	{ role: "assistant", content: [{ type: "text", text: "recent answer" }] },
] as any;
assert.deepEqual(selectCompleteRecentTail(messages, 1), messages.slice(2), "tail starts at a complete user turn");
const privateInstruction = handoffInstruction("web");
const triggeringUser = { role: "user", content: [{ type: "text", text: "do the substantive work" }] } as any;
const privateAssistant = { role: "assistant", content: [{ type: "text", text: `done${HANDOFF_OPEN}${JSON.stringify(captures[0].handoff)}${HANDOFF_CLOSE}` }] } as any;
const replayTail = selectCompleteRecentTail([triggeringUser, sanitizeHandoffMessage(privateAssistant)], 100);
const replayText = JSON.stringify(replayTail);
assert(!replayText.includes(privateInstruction), "triggering user message and replay tail contain no private instruction");
assert(!replayText.includes(HANDOFF_OPEN) && !replayText.includes(HANDOFF_CLOSE), "replay tail contains no private delimiters");
const persistedLine = JSON.stringify({ type: "message", id: "synthetic", message: privateAssistant });
const publicPersistedLine = sanitizePrivateHandoffSessionLine(persistedLine);
assert(!publicPersistedLine.includes(HANDOFF_OPEN) && !publicPersistedLine.includes(captures[0].handoff.goal), "durable awareness rows expose no handoff bytes");
assert.match(publicPersistedLine, /done/, "durable awareness rows retain exact public response text");
const splitPersistedLine = JSON.stringify({ type: "message", id: "split", message: { role: "assistant", content: [
	{ type: "text", text: `done${HANDOFF_OPEN.slice(0, 9)}` },
	{ type: "text", text: `${HANDOFF_OPEN.slice(9)}${JSON.stringify(captures[0].handoff)}${HANDOFF_CLOSE}` },
] } });
const splitPublicLine = sanitizePrivateHandoffSessionLine(splitPersistedLine);
assert(!splitPublicLine.includes("private_handoff") && !splitPublicLine.includes(captures[0].handoff.goal), "persisted split-part markers are sanitized as one stream");
assert.match(splitPublicLine, /done/, "split-part persisted sanitization retains public text");
for (let length = 1; length < HANDOFF_OPEN.length; length++) {
	const prefix = HANDOFF_OPEN.slice(0, length);
	const malformedCandidate = `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"${prefix}`;
	const malformedPublicLine = sanitizePrivateHandoffSessionLine(malformedCandidate);
	assert(!malformedPublicLine.includes(prefix), `malformed candidate prefix length ${length} fails closed without raw delimiter bytes`);
	assert.match(malformedPublicLine, /private-handoff-redacted/, `malformed candidate prefix length ${length} becomes a safe redaction record`);
}

const agentSource = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
assert.match(agentSource, /base\.mode === "handoff"/, "only handoff mode disables Pi compaction");
assert.match(agentSource, /writeHandoffJournal[\s\S]*resetSessionState\(\)[\s\S]*recoverRotation/, "handoff persists before archive and rotation");
assert.match(agentSource, /sanitizeStreamingMessage\(agentEvent\.message, false\)/, "streaming projection uses private boundary buffering");
assert.doesNotMatch(agentSource, /finalUserMessage \+= `\\n\\n\$\{handoffInstruction/, "private instruction never enters the user transcript");
assert.match(agentSource, /ordinaryRuntimeContext = activeRuntimeContext[\s\S]*activeRuntimeContext = `\$\{ordinaryRuntimeContext\}[\s\S]*finally[\s\S]*activeRuntimeContext = ordinaryRuntimeContext/, "private instruction is scoped to one dynamic system prompt");

console.log("handoff compaction: ok");
