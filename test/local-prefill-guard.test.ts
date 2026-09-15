import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateRunner } from "../src/agent.js";
import type { MomContext } from "../src/adapters/types.js";
import { ChannelStore } from "../src/store.js";

const root = mkdtempSync(join(tmpdir(), "local-prefill-guard-"));
process.env.PI_AGENT_DIR = join(root, "agent-config");
process.env.PI_OFFLINE = "1";
process.env.TROUBLEMAKER_PROMPT_PROFILE = "compact";
process.env.TROUBLEMAKER_LOCAL_PREFILL_LIMIT_TOKENS = "24000";
process.env.TROUBLEMAKER_PRIVATE_HANDOFF_TIMEOUT_MS = "10000";

let activeRequestId = "";
let firstRequestClosed = false;
let ordinaryRequests = 0;
const modelRequests: any[] = [];
const modelServer = createServer(async (req, res) => {
 let body = "";
 for await (const chunk of req) body += chunk;
 const payload = JSON.parse(body);
 modelRequests.push(payload);
 activeRequestId = String(req.headers["x-mtplx-request-id"] || "");
 const checkpoint = payload.tool_choice?.function?.name === "handoff_context";
 res.writeHead(200, {"Content-Type": "text/event-stream"});
 res.flushHeaders();
 const send = (choices: unknown[], usage?: unknown) => res.write(`data: ${JSON.stringify({
  id: `guard-${modelRequests.length}`, object: "chat.completion.chunk", created: 1, model: "example-model", choices,
  ...(usage ? {usage} : {}),
 })}\n\n`);
 if (checkpoint) {
  send([{index: 0, delta: {role: "assistant", tool_calls: [{index: 0, id: "bounded-recovery", type: "function", function: {
   name: "handoff_context", arguments: JSON.stringify({label: "Recover safely", summary: "Preserve and answer the synthetic request.", nextSteps: ["Answer it"], continue: true}),
  }}]}, finish_reason: null}]);
  send([{index: 0, delta: {}, finish_reason: "tool_calls"}], {prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240});
  res.end("data: [DONE]\n\n");
  return;
 }
 ordinaryRequests++;
 if (ordinaryRequests === 1) {
  res.on("close", () => { firstRequestClosed = true; });
  return;
 }
 send([{index: 0, delta: {role: "assistant", content: "Recovered fixture complete."}, finish_reason: null}]);
 send([{index: 0, delta: {}, finish_reason: "stop"}], {prompt_tokens: 1400, completion_tokens: 20, total_tokens: 1420});
 res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => modelServer.listen(0, "127.0.0.1", resolve));

const progressServer = createServer((_req, res) => {
 const privateRequest = activeRequestId.startsWith("chatcmpl-private-handoff-");
 const total = privateRequest ? 1200 : 30000;
 res.setHeader("Content-Type", "application/json");
 res.end(JSON.stringify({in_flight: activeRequestId ? [{request_id: activeRequestId, prefill_state: {
  request_id: activeRequestId, phase: "chunk", tokens_done: privateRequest ? 512 : 0,
  tokens_total: total, cached_tokens: 0, elapsed_s: 0.1,
 }}] : []}));
});
await new Promise<void>(resolve => progressServer.listen(0, "127.0.0.1", resolve));

try {
 const modelAddress = modelServer.address();
 const progressAddress = progressServer.address();
 assert(modelAddress && typeof modelAddress !== "string");
 assert(progressAddress && typeof progressAddress !== "string");
 process.env.TROUBLEMAKER_INFERENCE_PROGRESS_URL = `http://127.0.0.1:${progressAddress.port}/snapshot`;
 writeFileSync(join(root, "models.json"), JSON.stringify({providers: {example: {
  baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, apiKey: "example-key", api: "openai-completions",
  models: [{id: "example-model", name: "Example", reasoning: false, input: ["text"], contextWindow: 65536,
   maxTokens: 2048, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
 }}}));
 writeFileSync(join(root, "settings.json"), JSON.stringify({defaultProvider: "example", defaultModel: "example-model",
  thinkingLevel: "off", compaction: {enabled: true, mode: "handoff", reserveTokens: 16384, keepRecentTokens: 12000}}));
 writeFileSync(join(root, "AGENTS.md"), "Synthetic local-prefill guard fixture only.\n");
 const finals: string[] = [];
 const noop = async () => {};
 const ctx: MomContext = {message: {text: "Complete the guarded fixture", rawText: "Complete the guarded fixture",
  user: "example-user", channel: "example-channel", ts: "1", attachments: []}, channels: [], users: [],
  respond: noop, sendFinalResponse: async text => { finals.push(text); }, respondInThread: noop, setTyping: noop,
  uploadFile: noop, setWorking: noop, deleteMessage: noop, restartWorking: noop};
 const runner = await getOrCreateRunner({type: "host"}, join(root, "awareness"), "Be concise.");
 const started = Date.now();
 const result = await runner.run(ctx, new ChannelStore({workingDir: root, botToken: ""}));
 assert.equal(result.stopReason, "stop");
 assert(Date.now() - started < 8000, "giant uncached prefill is rejected promptly instead of hanging");
 assert(firstRequestClosed, "the oversized provider request is actively cancelled");
 assert.equal(modelRequests.length, 3, "rejection is followed by one bounded checkpoint and one fresh-context continuation");
 assert.deepEqual(modelRequests[1].tools.map((tool: any) => tool.function?.name), ["handoff_context"]);
 assert.equal(modelRequests[1].tool_choice.function.name, "handoff_context");
 assert(finals.includes("Recovered fixture complete."));
 console.log("local prefill guard: ok");
} finally {
 delete process.env.TROUBLEMAKER_INFERENCE_PROGRESS_URL;
 delete process.env.TROUBLEMAKER_LOCAL_PREFILL_LIMIT_TOKENS;
 delete process.env.TROUBLEMAKER_PRIVATE_HANDOFF_TIMEOUT_MS;
 await Promise.all([
  new Promise<void>(resolve => modelServer.close(() => resolve())),
  new Promise<void>(resolve => progressServer.close(() => resolve())),
 ]);
 await rm(root, {recursive: true, force: true});
}
