import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateRunner } from "../src/agent.js";
import { ChannelStore } from "../src/store.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { MomContext } from "../src/adapters/types.js";
import { HANDOFF_RESUME_INSTRUCTION } from "../src/handoff-continuation.js";

const root = mkdtempSync(join(tmpdir(), "handoff-runner-"));
process.env.PI_AGENT_DIR = join(root, "agent-config");
process.env.PI_OFFLINE = "1";
process.env.TROUBLEMAKER_PROMPT_PROFILE = "compact";

type Request = { messages: Array<{role: string; content: unknown}>; tools?: Array<{function?: {name?: string}}>;
 temperature?: number; enable_thinking?: boolean; tool_choice?: {function?: {name?: string}} };
const requests: Request[] = [];
let normalRequests = 0;
let checkpointBehavior: "valid" | "invalid" | "delayed" = "valid";
let abortDuringCheckpoint: (() => void) | undefined;
const summary = "Finish the synthetic check. Preserve the triggering user request and continue after rotation.";

const server = createServer(async (req, res) => {
 let body = "";
 for await (const chunk of req) body += chunk;
 const request = JSON.parse(body) as Request;
 requests.push(request);
 const isCheckpoint = request.tool_choice?.function?.name === "handoff_context";
 res.writeHead(200, {"Content-Type": "text/event-stream"});
 const send = (choices: unknown[], usage?: unknown) => res.write(`data: ${JSON.stringify({
  id: `example-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "example-model", choices,
  ...(usage ? {usage} : {}),
 })}\n\n`);
 if (isCheckpoint) {
  const behavior = checkpointBehavior;
  checkpointBehavior = "valid";
  if (behavior === "delayed") {
   abortDuringCheckpoint?.();
   await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (behavior === "invalid") {
   send([{index: 0, delta: {role: "assistant", content: "invalid checkpoint prose"}, finish_reason: null}]);
   send([{index: 0, delta: {}, finish_reason: "stop"}], {prompt_tokens: 1800, completion_tokens: 10, total_tokens: 1810});
  } else {
   send([{index: 0, delta: {role: "assistant", tool_calls: [{index: 0, id: `private-${requests.length}`, type: "function", function: {
    name: "handoff_context", arguments: JSON.stringify({label: "Save synthetic checkpoint", summary, nextSteps: ["Reply fixture complete"], continue: true}),
   }}]}, finish_reason: null}]);
   send([{index: 0, delta: {}, finish_reason: "tool_calls"}], {prompt_tokens: 1800, completion_tokens: 80, total_tokens: 1880});
  }
  res.end("data: [DONE]\n\n");
  return;
 }
 normalRequests++;
 const content = normalRequests === 1 ? "Initial fixture complete." : "Fixture complete.";
 send([{index: 0, delta: {role: "assistant", content}, finish_reason: null}]);
 send([{index: 0, delta: {}, finish_reason: "stop"}], {
  prompt_tokens: normalRequests === 1 ? 22000 : 1600,
  completion_tokens: 100,
  total_tokens: normalRequests === 1 ? 22100 : 1700,
 });
 res.end("data: [DONE]\n\n");
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
try {
 const address = server.address(); assert(address && typeof address !== "string");
 writeFileSync(join(root, "models.json"), JSON.stringify({providers: {example: {
  baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "example-key", api: "openai-completions",
  models: [{id: "example-model", name: "Example", reasoning: false, input: ["text"], contextWindow: 32768,
   maxTokens: 2048, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
 }}}));
 writeFileSync(join(root, "settings.json"), JSON.stringify({defaultProvider: "example", defaultModel: "example-model",
  thinkingLevel: "off", compaction: {enabled: true, mode: "handoff", reserveTokens: 10000, keepRecentTokens: 1024}}));
 writeFileSync(join(root, "AGENTS.md"), "Only perform the synthetic fixture. No tools or external actions.\n");
 const finals: string[] = [];
 const projections: unknown[] = [];
 const noop = async () => {};
 const ctx: MomContext = {message: {text: "Initial fixture", rawText: "Initial fixture", user: "example-user",
  channel: "example-channel", ts: "1", attachments: []}, channels: [], users: [], respond: noop,
  sendFinalResponse: async text => { finals.push(text); }, respondInThread: noop, setTyping: noop, uploadFile: noop,
  setWorking: noop, deleteMessage: noop, restartWorking: noop, emitContentBlock: event => { projections.push(event); }};
 const runner = await getOrCreateRunner({type: "host"}, join(root, "awareness"), "Be concise.");
 const store = new ChannelStore({workingDir: root, botToken: ""});

 assert.equal((await runner.run(ctx, store)).stopReason, "stop");
 ctx.message = {...ctx.message, text: "Finish the fixture", rawText: "Finish the fixture", ts: "2", sourceEventType: "heartbeat"};
 assert.equal((await runner.run(ctx, store)).stopReason, "stop", "heartbeat pressure uses the transactional handoff path");
 assert.equal(requests.length, 3, "one private checkpoint automatically continues in fresh context");
 const pressure = requests[1];
 assert.deepEqual(pressure.tools?.map(tool => tool.function?.name), ["handoff_context"], "private request exposes exactly one tool");
 assert.equal(pressure.tool_choice?.function?.name, "handoff_context");
 assert.equal(pressure.temperature, 0);
 assert.equal(pressure.enable_thinking, false);
 assert.equal(JSON.stringify(pressure.messages).split("PRIVATE CONTINUITY CHECKPOINT REQUIRED NOW").length - 1, 1);
 assert(JSON.stringify(requests[2].messages).includes(HANDOFF_RESUME_INSTRUCTION));
 assert(!JSON.stringify(projections).includes(summary), "private checkpoint arguments never enter Computer/TUI projections");
 assert(!JSON.stringify(projections).includes("handoff_context"), "private checkpoint has no visible tool row");
 assert(finals.includes("Fixture complete."));
 const durableAfterSuccess = readFileSync(join(root, "awareness/context.jsonl"), "utf8");
 assert(durableAfterSuccess.includes("troublemaker.continuity-handoff.v1"));
 const archives = readdirSync(join(root, "awareness/history"), {recursive: true});
 assert(archives.length > 0);
 const archivePath = join(root, "awareness/history", String(archives.find(value => String(value).endsWith(".jsonl"))));
 if (archivePath.endsWith(".jsonl")) {
  const archived = readFileSync(archivePath, "utf8");
  assert(!archived.includes("private-2"), "private checkpoint response is never appended to the source session");
 }

 // Force pressure without constructing a giant fixture. A malformed private
 // response preserves the user input and appends no checkpoint assistant/tool rows.
 const settingsPath = join(root, "settings.json");
 const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
 settings.compaction.reserveTokens = 31000;
 writeFileSync(settingsPath, JSON.stringify(settings));
 const historyBeforeFailure = readdirSync(join(root, "awareness/history"), {recursive: true});
 const beforeFailure = readFileSync(join(root, "awareness/context.jsonl"), "utf8");
 checkpointBehavior = "invalid";
 ctx.message = {...ctx.message, text: "Keep this correction", rawText: "Keep this correction", ts: "3"};
 assert.equal((await runner.run(ctx, store)).stopReason, "error");
 const afterFailure = readFileSync(join(root, "awareness/context.jsonl"), "utf8");
 assert(afterFailure.startsWith(beforeFailure), "failed private checkpoint preserves prior durable bytes");
 assert(!afterFailure.includes("invalid checkpoint prose"), "failed private output never enters the session");
 assert.deepEqual(readdirSync(join(root, "awareness/history"), {recursive: true}), historyBeforeFailure);

 // Cancellation aborts the private HTTP request and leaves only legitimate user input.
 const beforeAbort = afterFailure;
 checkpointBehavior = "delayed";
 abortDuringCheckpoint = () => runner.abort();
 ctx.message = {...ctx.message, text: "Cancellation fixture", rawText: "Cancellation fixture", ts: "4"};
 assert.equal((await runner.run(ctx, store)).stopReason, "aborted");
 abortDuringCheckpoint = undefined;
 const afterAbort = readFileSync(join(root, "awareness/context.jsonl"), "utf8");
 assert(afterAbort.startsWith(beforeAbort));
 assert(!afterAbort.includes("private-5"));
 const reopenedAfterAbort = SessionManager.open(join(root, "awareness/context.jsonl"), join(root, "awareness"));
 const recoveredMessages = reopenedAfterAbort.buildSessionContext().messages;
 assert.equal(recoveredMessages.at(-1)?.role, "user", "restart recovery keeps the triggering user message as the active leaf");
 assert(JSON.stringify(recoveredMessages.at(-1)).includes("Cancellation fixture"));
 assert(!JSON.stringify(recoveredMessages).includes("Private checkpoint cancelled"), "interrupted private output never becomes restart context");

 // Explicit maintenance compaction uses the same private path but does not
 // persist its harness prompt or continue the task.
 settings.compaction.reserveTokens = 10000;
 writeFileSync(settingsPath, JSON.stringify(settings));
 const requestCountBeforeManual = requests.length;
 const manual = await runner.compact("Preserve the synthetic fixture only.");
 assert.equal(requests.length, requestCountBeforeManual + 1);
 assert(manual.messagesAfter > 0);
 const manualRequest = requests.at(-1)!;
 assert.deepEqual(manualRequest.tools?.map(tool => tool.function?.name), ["handoff_context"]);
 assert(JSON.stringify(manualRequest.messages).includes("PRIVATE CONTINUITY CHECKPOINT REQUIRED NOW"));
 assert(!readFileSync(join(root, "awareness/context.jsonl"), "utf8").includes("Harness-requested continuity checkpoint"));

 // The operation queue remains serialized: concurrent input waits behind a
 // delayed maintenance checkpoint, then runs once in the rotated context.
 checkpointBehavior = "delayed";
 const beforeConcurrent = requests.length;
 const maintenance = runner.compact();
 const concurrentInput = {...ctx, message: {...ctx.message, text: "Concurrent user correction", rawText: "Concurrent user correction", ts: "5"}};
 const interactive = runner.run(concurrentInput, store);
 await maintenance;
 assert.equal((await interactive).stopReason, "stop");
 assert.equal(requests.length, beforeConcurrent + 2);
 assert(!JSON.stringify(requests[beforeConcurrent].messages).includes("Concurrent user correction"));
 assert(JSON.stringify(requests[beforeConcurrent + 1].messages).includes("Concurrent user correction"));
 console.log("handoff runner: ok");
} finally {
 await new Promise<void>(resolve => server.close(() => resolve()));
 await rm(root, {recursive: true, force: true});
}
