/**
 * Quick non-interactive test for the awareness backlog + stream endpoints.
 *
 * Spins up a Gateway with a temp workspace, writes to context.jsonl,
 * verifies /awareness/backlog returns recent entries, then verifies
 * /awareness/stream emits only new live updates.
 *
 * Run: pnpm exec tsx test/awareness-stream.test.ts
 */

import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import http from "http";

const TEMP_DIR = "/tmp/awareness-stream-test-" + Date.now();
const AWARENESS_DIR = join(TEMP_DIR, "awareness");
const CONTEXT_FILE = join(AWARENESS_DIR, "context.jsonl");
let PORT = 0;

// Test data
const line1 = JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z" });
const line2 = JSON.stringify({ type: "message", id: "m1", timestamp: "2026-01-01T00:01:00Z", message: { role: "user", content: [{ type: "text", text: "[2026-01-01 00:01:00+00:00] [web] [testuser]: hello" }] } });
const line3 = JSON.stringify({ type: "message", id: "m2", timestamp: "2026-01-01T00:02:00Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } });
const followUpHarness = "[ATTENTION:follow-up-agent-global-example-1.json:one-shot:2026-01-01T00:10:00.000Z] [FOLLOW_UP 1/1 after 10 minutes since the latest completed wake]\nINTERNAL FOLLOW-UP HARNESS THAT MUST NOT REACH A DISPLAY";
const followUpLine = JSON.stringify({ type: "message", id: "follow-up-1", timestamp: "2026-01-01T00:10:00Z", message: { role: "user", content: [{ type: "text", text: `<session_context>private state</session_context>\n\n<delivery_context>private route</delivery_context>\n\n[2026-01-01 00:10:00+00:00] [follow-up] [follow-up]: ${followUpHarness}` }] } });
const followUpLiveLine = JSON.stringify({ type: "message", id: "follow-up-2", timestamp: "2026-01-01T00:20:00Z", message: { role: "user", content: [{ type: "text", text: `[2026-01-01 00:20:00+00:00] [follow-up] [follow-up]: ${followUpHarness}` }] } });
const malformedFollowUpLine = JSON.stringify({ type: "message", id: "follow-up-malformed", timestamp: "2026-01-01T00:11:00Z", message: { role: "user", content: [{ type: "text", text: `[2026-01-01 00:11:00+00:00] [follow-up] [follow-up]: [ATTENTION:follow-up-broken] [FOLLOW_UP broken] PRIVATE MALFORMED HARNESS` }] } });
const heartbeatHarness = "[ATTENTION:example-daily-check.json:periodic:30 10 * * *] INTERNAL HEARTBEAT HARNESS THAT MUST NOT REACH A DISPLAY\n\n## Heartbeat Checklist\n- Review safely.";
const heartbeatLine = JSON.stringify({ type: "message", id: "heartbeat-1", timestamp: "2026-01-01T00:12:00Z", message: { role: "user", content: [{ type: "text", text: `<session_context>private heartbeat state</session_context>\n\n[2026-01-01 00:12:00+00:00] [heartbeat] [heartbeat]: ${heartbeatHarness}` }] } });
const heartbeatLiveLine = JSON.stringify({ type: "message", id: "heartbeat-2", timestamp: "2026-01-01T00:22:00Z", message: { role: "user", content: [{ type: "text", text: `[2026-01-01 00:22:00+00:00] [heartbeat:heartbeat] [heartbeat]: ${heartbeatHarness}` }] } });
const malformedHeartbeatLine = JSON.stringify({ type: "message", id: "heartbeat-malformed", timestamp: "2026-01-01T00:13:00Z", message: { role: "user", content: [{ type: "text", text: `[2026-01-01 00:13:00+00:00] [heartbeat] [heartbeat]: [ATTENTION:heartbeat-broken] PRIVATE HEARTBEAT HARNESS` }] } });
const rotatedLine = JSON.stringify({ type: "message", id: "voice-after-compaction", timestamp: "2026-01-01T00:03:00Z", message: { role: "user", content: [{ type: "text", text: "[2026-01-01 00:03:00+00:00] [voice] [user]: continue" }] } });

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function run() {
  // Setup temp workspace with existing context
  mkdirSync(AWARENESS_DIR, { recursive: true });
  writeFileSync(CONTEXT_FILE, line1 + "\n" + line2 + "\n" + followUpLine + "\n" + malformedFollowUpLine + "\n" + heartbeatLine + "\n" + malformedHeartbeatLine + "\n");

  PORT = await getFreePort();

  // Import and start gateway
  const { Gateway } = await import("../src/gateway.js");
  const gw = new Gateway({ workspaceDir: TEMP_DIR });
  await gw.start(PORT);

  console.log("Test 1: Backlog delivery");

  const backlog = await fetchBacklog();
  assert(backlog.lines.length >= 2, `got ${backlog.lines.length} backlog lines (expected ≥2)`);
  assert(backlog.lines[0]?.includes('"s1"') || false, "first backlog line is session s1");
  assert(backlog.lines[1]?.includes('"m1"') || false, "second backlog line is message m1");
  const projectedBacklogFollowUp = backlog.lines.find((line) => line.includes('"follow-up-1"')) || "";
  assert(projectedBacklogFollowUp.includes("Follow-up 1/1 · 10m"), "backlog compacts a generated follow-up for stale terminal clients");
  assert(!projectedBacklogFollowUp.includes("INTERNAL FOLLOW-UP HARNESS"), "backlog never exposes the generated follow-up harness");
  assert(!projectedBacklogFollowUp.includes("private state") && !projectedBacklogFollowUp.includes("private route"), "backlog removes generated follow-up context scaffolding");
  const redactedBacklogFollowUp = backlog.lines.find((line) => line.includes("troublemaker.generated-follow-up-redacted")) || "";
  assert(Boolean(redactedBacklogFollowUp), "backlog redacts malformed valid-JSON internal follow-ups");
  assert(!backlog.lines.some((line) => line.includes("PRIVATE MALFORMED HARNESS")), "backlog never returns a malformed internal follow-up harness");
  const projectedBacklogHeartbeat = backlog.lines.find((line) => line.includes('"heartbeat-1"')) || "";
  assert(projectedBacklogHeartbeat.includes("[heartbeat] [heartbeat]: Heartbeat"), "backlog compacts a generated heartbeat for stale terminal clients");
  assert(!projectedBacklogHeartbeat.includes("INTERNAL HEARTBEAT HARNESS"), "backlog never exposes the generated heartbeat harness");
  assert(!projectedBacklogHeartbeat.includes("private heartbeat state"), "backlog removes generated heartbeat context scaffolding");
  const redactedBacklogHeartbeat = backlog.lines.find((line) => line.includes("troublemaker.generated-heartbeat-redacted")) || "";
  assert(Boolean(redactedBacklogHeartbeat), "backlog redacts malformed valid-JSON internal heartbeats");
  assert(!backlog.lines.some((line) => line.includes("PRIVATE HEARTBEAT HARNESS")), "backlog never returns a malformed internal heartbeat harness");

  console.log("\nTest 2: Live update delivery");

  const headersReady = await waitForStreamHeaders(1000);
  assert(headersReady, "stream handshake completes before the first awareness event");

  const livePromise = collectEvents(1, 5000);
  await sleep(200); // Let connection establish before appending new content
  appendFileSync(CONTEXT_FILE, line3 + "\n");
  const liveEvents = await livePromise;
  assert(liveEvents.length >= 1, `got ${liveEvents.length} live events (expected ≥1)`);
  assert(liveEvents[0]?.includes('"m2"') || false, "live event contains message m2");

  const followUpLivePromise = collectEvents(1, 5000);
  await sleep(200);
  appendFileSync(CONTEXT_FILE, followUpLiveLine + "\n");
  const followUpLiveEvents = await followUpLivePromise;
  const projectedLiveFollowUp = followUpLiveEvents.find((event) => event.includes('"follow-up-2"')) || "";
  assert(projectedLiveFollowUp.includes("Follow-up 1/1 · 10m"), "live awareness compacts a generated follow-up for stale terminal clients");
  assert(!projectedLiveFollowUp.includes("INTERNAL FOLLOW-UP HARNESS"), "live awareness never exposes the generated follow-up harness");

  const heartbeatLivePromise = collectEvents(1, 5000);
  await sleep(200);
  appendFileSync(CONTEXT_FILE, heartbeatLiveLine + "\n");
  const heartbeatLiveEvents = await heartbeatLivePromise;
  const projectedLiveHeartbeat = heartbeatLiveEvents.find((event) => event.includes('"heartbeat-2"')) || "";
  assert(projectedLiveHeartbeat.includes("[heartbeat:heartbeat] [heartbeat]: Heartbeat"), "live awareness compacts a generated heartbeat for stale terminal clients");
  assert(!projectedLiveHeartbeat.includes("INTERNAL HEARTBEAT HARNESS"), "live awareness never exposes the generated heartbeat harness");

  console.log("\nTest 3: Unified runtime event delivery is sanitized");

  const runtimePromise = collectEvents(2, 5000, "/api/v2/agents/current/live");
  await sleep(200);
  const inputEnvelope = gw.publishRuntimeEvent({
    runId: "external-run",
    channelId: "voice",
    channelLabel: "voice",
    source: "voice",
    deliveryId: "delivery-example-runtime",
  }, {
    type: "user_input",
    entries: [{ channel: "voice", userName: "example-user", text: "Visible webhook input" }],
  });
  const assistantEnvelope = gw.publishRuntimeEvent({
    runId: "external-run",
    channelId: "voice",
    channelLabel: "voice",
    source: "voice",
  }, {
    type: "assistant_snapshot",
    entry: {
      id: "live-assistant",
      type: "message",
      timestamp: "2026-01-01T00:03:01Z",
      role: "assistant",
      isStreaming: true,
      content: [
        { type: "thinking", thinking: "PRIVATE_THINKING" },
        { type: "toolCall", id: "tool-1", name: "bash", label: "Checking safely", arguments: { command: "PRIVATE_ARGUMENT" } },
        { type: "toolResult", toolCallId: "tool-1", result: "PRIVATE_RESULT", isError: false },
      ],
    },
  });
  const runtimeEvents = await runtimePromise;
  const inputPayload = runtimeEvents.find((event) => event.includes('"type":"user_input"')) || "";
  const runtimePayload = runtimeEvents.find((event) => event.includes('"type":"assistant_snapshot"')) || "";
  const parsedInputPayload = JSON.parse(inputPayload) as { deliveryId?: string; event?: unknown };
  assert(inputPayload.includes("Visible webhook input"), "unified feed carries the sanitized webhook input");
  assert(parsedInputPayload.deliveryId === "delivery-example-runtime", "unified feed carries bounded opaque delivery correlation");
  assert(!JSON.stringify(parsedInputPayload.event).includes("delivery-example-runtime"), "delivery identity remains envelope metadata and never enters user-visible runtime content");
  assert(inputEnvelope.sequence < assistantEnvelope.sequence, "webhook input is sequenced before assistant paint events");
  assert(runtimePayload.includes('"kind":"runtime"'), "unified feed identifies runtime events");
  assert(runtimePayload.includes("Checking safely"), "unified feed preserves safe tool labels");
  assert(!runtimePayload.includes("PRIVATE_ARGUMENT"), "unified feed removes raw tool arguments");
  assert(!runtimePayload.includes("PRIVATE_RESULT"), "unified feed removes raw tool results");
  assert(!runtimePayload.includes("PRIVATE_THINKING"), "unified feed removes thinking content");

  const runtimeSequence = Number((JSON.parse(runtimePayload) as { sequence: number }).sequence);
  const statusEnvelope = gw.publishRuntimeEvent({ runId: "external-run", channelId: "voice", source: "voice" }, {
    type: "status",
    status: "streaming",
    message: "Continuing safely",
  });
  const replayEvents = await collectEvents(1, 5000, `/api/v2/agents/current/live?after=${runtimeSequence}`);
  assert(replayEvents.some((event) => event.includes("Continuing safely")), "unified feed replays a missed sequenced event after reconnect");

  const activeAttachEvents = await collectEvents(1, 5000, "/api/v2/agents/current/live");
  assert(activeAttachEvents.some((event) => event.includes("Continuing safely")), "a newly attached terminal receives the active run state");

  const directToolPromise = collectEvents(1, 5000, `/api/v2/agents/current/live?after=${statusEnvelope.sequence}`);
  await sleep(100);
  const directToolEnvelope = gw.publishRuntimeEvent({ runId: "direct-tool-run", channelId: "slack:C123", source: "slack" }, {
    type: "toolcall_delta",
    id: "direct-tool",
    name: "bash",
    delta: "PRIVATE_STREAMED_ARGUMENT",
    arguments: { command: "PRIVATE_DIRECT_ARGUMENT" },
  });
  const directToolEvents = await directToolPromise;
  assert(!directToolEvents.some((event) => event.includes("PRIVATE_STREAMED_ARGUMENT")), "unified feed removes streamed tool argument deltas");
  assert(!directToolEvents.some((event) => event.includes("PRIVATE_DIRECT_ARGUMENT")), "unified feed removes direct tool arguments");

  const externalComplete = gw.publishRuntimeEvent({ runId: "external-run", channelId: "voice", source: "voice" }, {
    type: "run_complete",
    channelId: "voice",
  });
  const directComplete = gw.publishRuntimeEvent({ runId: "direct-tool-run", channelId: "slack:C123", source: "slack" }, {
    type: "run_complete",
    channelId: "slack:C123",
  });
  assert(externalComplete.sequence < directComplete.sequence && directToolEnvelope.sequence < directComplete.sequence, "completed runs advance the ordered live cursor");

  console.log("\nTest 4: Context rotation resets the live tail cursor");

  writeFileSync(CONTEXT_FILE, `${line1}\n${line2}\n${"x".repeat(250_000)}\n`);
  const rotationPromise = collectEvents(2, 5000, `/api/v2/agents/current/live?after=${directComplete.sequence}`);
  await sleep(700);
  writeFileSync(CONTEXT_FILE, `${rotatedLine}\n`);
  const rotationEvents = await rotationPromise;
  assert(rotationEvents.some((event) => event.includes('"reason":"context_rotated"')), "unified feed announces context rotation");
  assert(rotationEvents.some((event) => event.includes("voice-after-compaction")), "first post-compaction voice message is delivered");

  // Cleanup
  await gw.stop();
  rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function waitForStreamHeaders(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    const req = http.get(`http://localhost:${PORT}/awareness/stream`, (res) => {
      finish(res.statusCode === 200 && res.headers["content-type"] === "text/event-stream");
    });
    req.on("error", () => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function fetchBacklog(): Promise<{ lines: string[]; total: number; offset: number }> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}/awareness/backlog?limit=50`, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function collectEvents(minCount: number, timeoutMs: number, path = "/awareness/stream"): Promise<string[]> {
  return new Promise((resolve) => {
    const events: string[] = [];
    let timer: ReturnType<typeof setTimeout>;

    const req = http.get(`http://localhost:${PORT}${path}`, (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const match = part.match(/^data: (.+)$/m);
          if (match) {
            events.push(match[1]);
            if (events.length >= minCount) {
              clearTimeout(timer);
              req.destroy();
              resolve(events);
            }
          }
        }
      });
    });

    timer = setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeoutMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

run().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
