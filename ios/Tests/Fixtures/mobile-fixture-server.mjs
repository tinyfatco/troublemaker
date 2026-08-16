import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.COMPUTER_MOBILE_FIXTURE_PORT ?? "38919", 10);
const clients = new Set();
const receipts = new Map();
let sequence = 0;

const messages = [
  {
    id: "fixture-user-1",
    timestamp: "2026-08-15T12:00:00Z",
    role: "user",
    text: "Show the full message without abridging it, including punctuation and deliberate line breaks.\n\nThis second paragraph proves the surface wraps and scrolls naturally.",
    channel: "ios",
    user_name: "you",
    is_error: false,
    speech_eligible: false,
  },
  {
    id: "fixture-assistant-1",
    timestamp: "2026-08-15T12:00:01Z",
    role: "assistant",
    text: "The exact sanitized assistant response is visible. Private thinking and tool payloads are absent by contract.",
    completion_id: "fixture-completion-1",
    is_error: false,
    speech_eligible: false,
  },
];

function sendJSON(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function liveEvent(payload) {
  sequence += 1;
  return {
    sequence,
    stream_id: "fixture-stream",
    id: `fixture-event-${sequence}`,
    timestamp: new Date().toISOString(),
    ...payload,
  };
}

function broadcast(payload) {
  const event = liveEvent(payload);
  const frame = `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) response.write(frame);
}

function cursorFrame() {
  const cursor = {
    sequence,
    stream_id: "fixture-stream",
    id: `fixture-cursor-${Date.now()}`,
    timestamp: new Date().toISOString(),
    kind: "cursor",
  };
  return `id: ${cursor.sequence}\ndata: ${JSON.stringify(cursor)}\n\n`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const match = url.pathname.match(/^\/api\/v2\/agents\/([^/]+)\/(status|deliveries|events|live|messages(?:\/stop)?)$/);
  if (!match || !["current", "agent-fixture"].includes(match[1])) {
    sendJSON(response, 404, { error: "not_found" });
    return;
  }

  const action = match[2];
  if (action === "status" && request.method === "GET") {
    sendJSON(response, 200, {
      agent_id: "agent-fixture",
      agent_name: "Fixture Agent",
      workspace_ready: true,
      capabilities: { conversation: true, stop: true },
    });
    return;
  }
  if (action === "events" && request.method === "GET") {
    sendJSON(response, 200, { messages, total: messages.length, offset: 0 });
    return;
  }
  if (action === "deliveries" && request.method === "GET") {
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    sendJSON(response, 200, {
      receipts: ids.flatMap((id) => receipts.has(id) ? [receipts.get(id)] : []),
    });
    return;
  }
  if (action === "live" && request.method === "GET") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(cursorFrame());
    clients.add(response);
    const heartbeat = setInterval(() => response.write(cursorFrame()), 5_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
    return;
  }
  if (action === "messages/stop" && request.method === "POST") {
    sendJSON(response, 200, { stopped: true });
    return;
  }
  if (action === "messages" && request.method === "POST") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let turn;
      try { turn = JSON.parse(body); }
      catch { sendJSON(response, 400, { error: "invalid_json" }); return; }
      if (typeof turn.message !== "string" || typeof turn.deliveryId !== "string") {
        sendJSON(response, 400, { error: "invalid_turn" });
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (receipts.has(turn.deliveryId)) {
        response.write(`data: ${JSON.stringify({ type: "delivery", disposition: "duplicate", delivery_id: turn.deliveryId })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      const claimedAt = new Date().toISOString();
      receipts.set(turn.deliveryId, {
        delivery_id: turn.deliveryId,
        state: "accepted",
        claimed_at: claimedAt,
      });
      response.write(`data: ${JSON.stringify({ type: "delivery", disposition: "accepted", delivery_id: turn.deliveryId })}\n\n`);

      const now = new Date().toISOString();
      const runId = `fixture-run-${turn.deliveryId}`;
      const userMessage = {
        id: `fixture-user-${turn.deliveryId}`,
        timestamp: now,
        role: "user",
        text: turn.message,
        channel: "ios",
        user_name: "you",
        delivery_id: turn.deliveryId,
        is_error: false,
        speech_eligible: false,
      };
      messages.push(userMessage);
      broadcast({ kind: "message", message: userMessage });
      broadcast({ kind: "state", run_id: runId, state: "thinking", status_text: "Thinking…" });
      broadcast({
        kind: "assistant",
        run_id: runId,
        completion_id: runId,
        text: `Fixture response to: ${turn.message}`,
        replace: true,
        is_final: true,
        is_error: false,
        speech_eligible: false,
      });
      broadcast({ kind: "completion", run_id: runId, completion_id: runId });
      const assistantMessage = {
        id: `fixture-assistant-${turn.deliveryId}`,
        timestamp: new Date().toISOString(),
        role: "assistant",
        text: `Fixture response to: ${turn.message}`,
        completion_id: runId,
        is_error: false,
        speech_eligible: false,
      };
      messages.push(assistantMessage);
      broadcast({ kind: "message", message: assistantMessage });

      const completedAt = new Date().toISOString();
      receipts.set(turn.deliveryId, {
        delivery_id: turn.deliveryId,
        state: "completed",
        claimed_at: claimedAt,
        completed_at: completedAt,
      });
      response.write(`data: ${JSON.stringify({ type: "delivery", disposition: "completed", delivery_id: turn.deliveryId })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    return;
  }

  sendJSON(response, 405, { error: "method_not_allowed" });
});

server.listen(port, host, () => {
  process.stdout.write(`Computer mobile fixture listening on http://${host}:${port}\n`);
});
