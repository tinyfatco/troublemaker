import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateRunner } from "../src/agent.js";
import { ChannelStore } from "../src/store.js";
import type { MomContext } from "../src/adapters/types.js";

const root = mkdtempSync(join(tmpdir(), "tool-loop-runner-"));
process.env.PI_AGENT_DIR = join(root, "agent-config");
process.env.PI_OFFLINE = "1";
process.env.TROUBLEMAKER_PROMPT_PROFILE = "compact";
let requests = 0;
let finish = false;
const server = createServer(async (req, res) => {
 for await (const _chunk of req) { /* drain request */ }
 const n = ++requests;
 res.writeHead(200, {"Content-Type": "text/event-stream"});
 const send = (delta: unknown, reason: string | null) => res.write(`data: ${JSON.stringify({id: `example-${n}`, object: "chat.completion.chunk", created: 1, model: "example-model", choices: [{index: 0, delta, finish_reason: reason}]})}\n\n`);
 if (finish || n > 8) {
  send({role: "assistant", content: "Fixture complete."}, null);
  send({}, "stop");
 } else {
  send({role: "assistant", tool_calls: [{index: 0, id: `example-tool-${n}`, type: "function", function: {name: "call_tool", arguments: JSON.stringify({name: "bash", arguments: {command: "printf synthetic", label: "Synthetic read"}})}}]}, null);
  send({}, "tool_calls");
 }
 res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
try {
	const address = server.address(); assert(address && typeof address !== "string");
	writeFileSync(join(root, "models.json"), JSON.stringify({providers: {example: {baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "example-key", api: "openai-completions", models: [{id: "example-model", name: "Example", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]}}}));
	writeFileSync(join(root, "settings.json"), JSON.stringify({defaultProvider: "example", defaultModel: "example-model", thinkingLevel: "off", compaction: {enabled: false}}));
	writeFileSync(join(root, "AGENTS.md"), "Only perform the synthetic fixture. No tools or external actions.\n");
	const finals: string[] = [];
	const noop = async () => {};
	const ctx: MomContext = {message: {text: "Initial fixture", rawText: "Initial fixture", user: "example-user", channel: "example-channel", ts: "1", attachments: []}, channels: [], users: [], respond: noop, sendFinalResponse: async text => {finals.push(text);}, respondInThread: noop, setTyping: noop, uploadFile: noop, setWorking: noop, deleteMessage: noop, restartWorking: noop};
	const runner = await getOrCreateRunner({type: "host"}, join(root, "awareness"), "Be concise.");
	const store = new ChannelStore({workingDir: root, botToken: ""});
 assert.equal((await runner.run(ctx, store)).stopReason, "error");
 assert.equal(requests, 5, "loop stops without another inference request or automatic retry");
 assert(finals.some(text => text.includes("tool calls kept repeating")), "stop is visible to the user");
 const durable = readFileSync(join(root, "awareness/context.jsonl"), "utf8");
 assert(durable.includes("synthetic"), "tool history is preserved");
 finish = true;
 assert.equal((await runner.run(ctx, store)).stopReason, "stop", "next user turn can continue");
 assert.equal(requests, 6);
 console.log("tool loop runner: ok");
} finally {
 await new Promise<void>(resolve => server.close(() => resolve()));
 await rm(root, {recursive: true, force: true});
}
