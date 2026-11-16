import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getOrCreateRunner } from "../src/agent.js";
import { ChannelStore } from "../src/store.js";
import type { MomContext } from "../src/adapters/types.js";
import { countPreRunHistoryMessages, projectProviderHistory } from "../src/core/provider-history.js";
import { HANDOFF_CLOSE, HANDOFF_OPEN } from "../src/handoff-compaction.js";

// Pi 1.x rebuilds every provider request from the SessionManager projection,
// so these rules must hold on the request itself, not on agent.state.messages.

// --- Pure projection -------------------------------------------------------
{
	const system = { role: "system", content: "Synthetic prompt" };
	const orphan = { role: "toolResult", toolCallId: "orphan-1", content: [{ type: "text", text: "orphan" }] };
	const user = { role: "user", content: "hello" };
	const inRun = { role: "toolResult", toolCallId: "unmatched-in-run", content: [{ type: "text", text: "in run" }] };
	const projected = projectProviderHistory([system, orphan, user, inRun], 3, false);
	assert.deepEqual(projected.messages, [system, user, inRun], "history is sanitized; messages added during the run are untouched");
	assert.deepEqual(projectProviderHistory([system, orphan, user], undefined, false).messages, [system, user], "unknown boundary sanitizes everything");
}
{
	const system = { role: "system", content: "Synthetic prompt" };
	const turns = Array.from({ length: 40 }, (_, i) => [
		{ role: "user", content: `turn ${i}` },
		{ role: "assistant", content: [{ type: "text", text: `reply ${i}` }] },
	]).flat();
	const projected = projectProviderHistory([system, ...turns], turns.length + 1, true);
	assert.equal(projected.messages[0], system, "concise projection keeps the system message");
	assert(projected.conciseWatch, "concise projection reported");
	assert(projected.messages.length < turns.length, "concise projection drops old turns");
	assert.equal(projected.messages[1]?.role, "user", "kept history starts on a user turn");
	assert.deepEqual(projected.messages.at(-1), turns.at(-1));
}
{
	const projection = { entries: [
		{ sourceEntry: { id: "a" }, messages: [1, 2] },
		{ sourceEntry: { id: "b" }, messages: [3] },
		{ sourceEntry: { id: "c" }, messages: [4] },
	] };
	assert.equal(countPreRunHistoryMessages(projection, null), 0);
	assert.equal(countPreRunHistoryMessages(projection, "b"), 3);
	assert.equal(countPreRunHistoryMessages(projection, "missing"), undefined);
}

// --- Provider-bound requests through the real runner ------------------------
const root = mkdtempSync(join(tmpdir(), "provider-history-"));
process.env.PI_AGENT_DIR = join(root, "agent-config");
process.env.PI_OFFLINE = "1";
delete process.env.TROUBLEMAKER_PROMPT_PROFILE;

type Request = { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
const requests: Request[] = [];
const server = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	requests.push(JSON.parse(body) as Request);
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (choices: unknown[], usage?: unknown) => res.write(`data: ${JSON.stringify({
		id: `example-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "example-model", choices,
		...(usage ? { usage } : {}),
	})}\n\n`);
	send([{ index: 0, delta: { role: "assistant", content: "Fixture reply." }, finish_reason: null }]);
	send([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
	res.end("data: [DONE]\n\n");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const address = server.address();
	assert(address && typeof address !== "string");
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { example: {
		baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "example-key", api: "openai-completions",
		models: [{ id: "example-model", name: "Example", reasoning: false, input: ["text"], contextWindow: 1_000_000,
			maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	writeFileSync(join(root, "settings.json"), JSON.stringify({ defaultProvider: "example", defaultModel: "example-model",
		thinkingLevel: "off", compaction: { enabled: false } }));
	writeFileSync(join(root, "AGENTS.md"), "Only perform the synthetic fixture. No tools or external actions.\n");

	// Seed durable history that needs sanitizing: an orphaned tool result and a
	// private checkpoint, followed by enough turns for the concise_watch bound.
	const awarenessDir = join(root, "awareness");
	mkdirSync(awarenessDir, { recursive: true });
	const seed = SessionManager.open(join(awarenessDir, "context.jsonl"), awarenessDir);
	const ts = 1_700_000_000_000;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (content: unknown[]) => ({ role: "assistant", content, api: "openai-completions", provider: "example",
		model: "example-model", usage, stopReason: "stop", timestamp: ts });
	seed.appendMessage({ role: "user", content: [{ type: "text", text: "OLDEST_HISTORY_MARKER" }], timestamp: ts } as any);
	seed.appendMessage(assistant([{ type: "text", text: "Earlier reply." }]) as any);
	seed.appendMessage({ role: "toolResult", toolCallId: "orphan-call-1", toolName: "bash",
		content: [{ type: "text", text: "ORPHANED_TOOL_RESULT_MARKER" }], isError: false, timestamp: ts } as any);
	seed.appendMessage({ role: "user", content: [{ type: "text", text: "Checkpoint please." }], timestamp: ts } as any);
	seed.appendMessage(assistant([{ type: "text", text: `${HANDOFF_OPEN}PRIVATE_CHECKPOINT_MARKER${HANDOFF_CLOSE}` }]) as any);
	for (let i = 0; i < 40; i++) {
		seed.appendMessage({ role: "user", content: [{ type: "text", text: `Synthetic turn ${i}` }], timestamp: ts } as any);
		seed.appendMessage(assistant([{ type: "text", text: `Synthetic reply ${i}` }]) as any);
	}

	const noop = async () => {};
	const ctx: MomContext = { message: { text: "First fixture", rawText: "First fixture", user: "example-user",
		channel: "example-channel", ts: "1", attachments: [] }, channels: [], users: [], respond: noop,
		sendFinalResponse: noop, respondInThread: noop, setTyping: noop, uploadFile: noop,
		setWorking: noop, deleteMessage: noop, restartWorking: noop };
	const runner = await getOrCreateRunner({ type: "host" }, awarenessDir, "Be concise.");
	const store = new ChannelStore({ workingDir: root, botToken: "" });

	assert.equal((await runner.run(ctx, store)).stopReason, "stop");
	assert.equal(requests.length, 1);
	const full = JSON.stringify(requests[0]!.messages);
	assert(full.includes("OLDEST_HISTORY_MARKER"), "a normal run keeps the full history");
	assert(full.includes("First fixture"), "the current prompt is sent");
	assert(!full.includes("ORPHANED_TOOL_RESULT_MARKER"), "orphaned tool results are sanitized out of the provider request");
	assert(!full.includes("PRIVATE_CHECKPOINT_MARKER"), "private checkpoints are withheld from the provider request");
	assert.equal(requests[0]!.messages[0]?.role, "system", "the system prompt still leads the request");

	ctx.message = { ...ctx.message, text: "Watch fixture", rawText: "Watch fixture", ts: "2", contextProjection: "concise_watch" };
	assert.equal((await runner.run(ctx, store)).stopReason, "stop");
	assert.equal(requests.length, 2);
	const concise = requests[1]!;
	const conciseText = JSON.stringify(concise.messages);
	assert.equal(concise.messages[0]?.role, "system", "concise_watch keeps the system prompt");
	assert(conciseText.includes("Watch fixture"), "concise_watch sends the current prompt");
	assert(conciseText.includes("Synthetic reply 39"), "concise_watch keeps the most recent history");
	assert(!conciseText.includes("OLDEST_HISTORY_MARKER"), "concise_watch drops old history");
	assert(!conciseText.includes("Synthetic turn 0\""), "concise_watch bounds history");
	assert(!conciseText.includes("ORPHANED_TOOL_RESULT_MARKER"));
	assert(concise.messages.length < requests[0]!.messages.length, "concise_watch request is smaller than the full request");

	// Projection is per request: the durable session keeps everything.
	const reopened = SessionManager.open(join(awarenessDir, "context.jsonl"), awarenessDir);
	const durable = JSON.stringify(reopened.buildSessionContext().messages);
	assert(durable.includes("OLDEST_HISTORY_MARKER"), "durable history is not rewritten");
	assert(durable.includes("Watch fixture"));
	console.log("provider history projection: ok");
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await rm(root, { recursive: true, force: true });
}
