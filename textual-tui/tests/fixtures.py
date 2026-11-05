"""Synthetic agent server and event builders. All identities are fake."""

from __future__ import annotations

import asyncio
import itertools
import json
from typing import Any

import httpx

CHANNEL = "terminal:casey"
_ids = itertools.count(1)


def envelope(text: str, channel: str = CHANNEL, user: str = "user") -> str:
    return (
        "<session_context>\nAttending: example\n</session_context>\n\n"
        f"[2026-01-01 09:00:00+00:00] [{channel}] [{user}]: {text}"
    )


def user_line(text: str, channel: str = CHANNEL, user: str = "user", entry_id: str | None = None) -> str:
    return json.dumps({
        "type": "message",
        "id": entry_id or f"u{next(_ids):04d}",
        "timestamp": "2026-01-01T09:00:00.000Z",
        "message": {"role": "user", "content": [{"type": "text", "text": envelope(text, channel, user)}]},
    })


def assistant_line(content: list[dict], parent: str | None = None, entry_id: str | None = None) -> str:
    return json.dumps({
        "type": "message",
        "id": entry_id or f"a{next(_ids):04d}",
        "parentId": parent,
        "timestamp": "2026-01-01T09:00:01.000Z",
        "message": {"role": "assistant", "content": content, "stopReason": "stop"},
    })


def text(value: str) -> dict:
    return {"type": "text", "text": value}


def tool(call_id: str, name: str = "bash", label: str | None = None, details: dict | None = None) -> dict:
    block: dict[str, Any] = {"type": "toolCall", "id": call_id, "name": name, "arguments": {"label": label} if label else {}}
    if details:
        block["displayDetails"] = details
    return block


def result(call_id: str, value: str = "ok", error: bool = False, details: dict | None = None) -> dict:
    block: dict[str, Any] = {"type": "toolResult", "toolCallId": call_id, "result": value, "isError": error}
    if details:
        block["displayDetails"] = details
    return block


class Live:
    """Builds ``/live`` envelopes with a monotonic sequence."""

    def __init__(self, stream_id: str = "stream-0001") -> None:
        self.stream_id = stream_id
        self.sequence = 0

    def _base(self, kind: str) -> dict[str, Any]:
        self.sequence += 1
        return {"kind": kind, "sequence": self.sequence, "streamId": self.stream_id, "id": f"e{self.sequence}", "timestamp": "2026-01-01T09:00:00Z"}

    def awareness(self, line: str) -> dict:
        return {**self._base("awareness"), "line": line}

    def runtime(self, run_id: str, event: dict, channel: str = CHANNEL) -> dict:
        return {**self._base("runtime"), "runId": run_id, "channelId": channel, "channelLabel": channel, "event": event}

    def user_input(self, run_id: str, *texts: str, channel: str = CHANNEL, user: str = "user") -> dict:
        entries = [{"channel": channel, "userName": user, "text": t} for t in texts]
        return self.runtime(run_id, {"type": "user_input", "entries": entries}, channel)

    def steering(self, run_id: str, steer_id: str, state: str, *texts: str, channel: str = CHANNEL, user: str = "user") -> dict:
        entries = [{"channel": channel, "userName": user, "text": t} for t in texts]
        event = {"type": "steering_input", "id": steer_id, "state": state, "deliveryMode": "steered",
                 "acceptedAt": "2026-01-01T09:00:00Z", "entries": entries}
        return self.runtime(run_id, event, channel)

    def snapshot(self, run_id: str, content: list[dict], streaming: bool = True, channel: str = CHANNEL, stop: str | None = None) -> dict:
        entry = {"id": f"snap-{run_id}", "type": "message", "timestamp": "2026-01-01T09:00:00Z", "role": "assistant",
                 "content": content, "isStreaming": streaming, "stopReason": stop}
        return self.runtime(run_id, {"type": "assistant_snapshot", "entry": entry}, channel)

    def complete(self, run_id: str, channel: str = CHANNEL) -> dict:
        return self.runtime(run_id, {"type": "run_complete", "channelId": channel}, channel)


class FakeAgent:
    """An in-process agent behind ``httpx.MockTransport``."""

    def __init__(self, backlog: list[str] | None = None) -> None:
        self.backlog = backlog or []
        self.live_queue: asyncio.Queue[dict | None] = asyncio.Queue()
        self.sent: list[dict] = []
        self.stops = 0
        self.idle = True
        self.send_events: list[dict] = [{"type": "status", "status": "accepted"}]
        self.release_send = asyncio.Event()
        self.release_send.set()
        self.transport = httpx.MockTransport(self.handle)

    async def push(self, *events: dict) -> None:
        for event in events:
            await self.live_queue.put(event)

    async def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/health":
            return httpx.Response(200, text="ok")
        if path == "/api/v2/agents/current/status":
            return httpx.Response(200, json={"agent_name": "Casey", "runtime": "troublemaker", "mode": "standalone", "workspace_ready": True})
        if path == "/status":
            return httpx.Response(200, json={"idle": self.idle, "running": [] if self.idle else ["x"], "phase": "idle" if self.idle else "running"})
        if path == "/api/v2/agents/current/events":
            return httpx.Response(200, json={"lines": self.backlog, "total": len(self.backlog), "offset": 0})
        if path == "/api/v2/agents/current/messages/stop":
            self.stops += 1
            return httpx.Response(200, json={"ok": True})
        if path == "/api/v2/agents/current/messages":
            self.sent.append(json.loads(request.content))

            async def body():
                for event in self.send_events:
                    yield f"data: {json.dumps(event)}\n\n".encode()
                await self.release_send.wait()
                yield b"data: [DONE]\n\n"

            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body())
        if path == "/api/v2/agents/current/live":
            async def live():
                yield b": connected\n\n"
                while True:
                    event = await self.live_queue.get()
                    if event is None:
                        return
                    yield f"data: {json.dumps(event)}\n\n".encode()

            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=live())
        return httpx.Response(404)
