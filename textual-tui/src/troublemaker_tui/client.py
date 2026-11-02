"""Async HTTP client for one agent's canonical Troublemaker console session."""

from __future__ import annotations

import json
import os
import stat
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from .config import Profile


@dataclass(frozen=True)
class AgentStatus:
    agent_name: str
    runtime: str
    mode: str
    workspace_ready: bool


@dataclass(frozen=True)
class RunStatus:
    idle: bool
    phase: Literal["idle", "running", "compacting"]
    phase_elapsed_ms: int
    queued: int
    compaction_abort_requested: bool
    active_label: str


class AgentRequestError(RuntimeError):
    pass


def read_protected_token(path: str | None) -> str | None:
    """Read a bearer token with the same guarantees as the TS client."""
    if not path or not path.strip():
        return None
    path = path.strip()
    if not os.path.isabs(path):
        raise AgentRequestError("Protected token file path must be absolute")
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as error:
        if error.errno == 62 or "symbolic" in str(error).lower():  # ELOOP
            raise AgentRequestError(f"Protected token file must not be a symbolic link: {path}") from error
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise AgentRequestError(f"Protected token path is not a regular file: {path}")
        if info.st_mode & 0o077:
            raise AgentRequestError(f"Protected token file must not be accessible by group or others: {path}")
        if info.st_uid != os.getuid():
            raise AgentRequestError(f"Protected token file must be owned by the runtime user: {path}")
        with os.fdopen(os.dup(fd), "r", encoding="utf-8") as handle:
            token = handle.read().strip()
    finally:
        os.close(fd)
    if not token:
        raise AgentRequestError(f"Protected token file is empty: {path}")
    return token


async def iter_sse(response: httpx.Response) -> AsyncIterator[str]:
    """Yield the ``data`` payload of each server-sent event."""
    if response.status_code >= 400:
        detail = " ".join((await response.aread()).decode("utf-8", "replace").split())
        raise AgentRequestError(f"Agent request failed ({response.status_code})" + (f": {detail[:400]}" if detail else ""))
    data: list[str] = []
    async for line in response.aiter_lines():
        if line == "":
            if data:
                yield "\n".join(data)
                data = []
            continue
        if line.startswith("data:"):
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)
    if data:
        yield "\n".join(data)


class AgentClient:
    def __init__(self, profile: Profile, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.profile = profile
        token = read_protected_token(profile.bearer_token_file)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._http = httpx.AsyncClient(
            base_url=profile.base_url,
            headers=headers,
            timeout=httpx.Timeout(15.0, read=None),
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _json(self, path: str, label: str) -> dict[str, Any]:
        response = await self._http.get(path, headers={"Cache-Control": "no-store"})
        if response.status_code >= 400:
            raise AgentRequestError(f"{label} failed ({response.status_code})")
        body = response.json()
        return body if isinstance(body, dict) else {}

    async def status(self) -> AgentStatus:
        health = await self._http.get("/health")
        if health.status_code >= 400:
            raise AgentRequestError(f"Health check failed ({health.status_code})")
        raw = await self._json("/api/v2/agents/current/status", "Agent status")
        return AgentStatus(
            agent_name=str(raw.get("agent_name") or self.profile.name),
            runtime=str(raw.get("runtime") or "troublemaker"),
            mode=str(raw.get("mode") or "standalone"),
            workspace_ready=raw.get("workspace_ready") is True,
        )

    async def backlog(self, limit: int = 60) -> list[str]:
        raw = await self._json(f"/api/v2/agents/current/events?limit={max(1, min(200, limit))}", "Agent history")
        lines = raw.get("lines")
        return [line for line in lines if isinstance(line, str)] if isinstance(lines, list) else []

    async def run_status(self) -> RunStatus:
        raw = await self._json("/status", "Agent run status")
        running = isinstance(raw.get("running"), list) and len(raw["running"]) > 0
        idle = raw.get("idle") is True or (raw.get("idle") is not False and not running)
        phase = raw.get("phase") if raw.get("phase") in ("idle", "running", "compacting") else ("idle" if idle else "running")
        compaction = raw.get("compaction") if isinstance(raw.get("compaction"), dict) else {}
        number = lambda key: raw.get(key) if isinstance(raw.get(key), (int, float)) else 0  # noqa: E731
        return RunStatus(
            idle=idle,
            phase=phase,
            phase_elapsed_ms=int(number("phaseElapsedMs")),
            queued=int(number("queuedInputCount") or number("queuedRuns")),
            compaction_abort_requested=isinstance(compaction.get("abortRequestedAt"), (int, float)),
            active_label=str(raw.get("activeRunLabel") or ""),
        )

    async def send(self, message: str) -> AsyncIterator[dict[str, Any]]:
        """POST a terminal message; yields control events from the response stream.

        Assistant output is painted from the live feed, never from this response.
        """
        body = {
            "message": message,
            "channelId": self.profile.channel_id,
            "source": "terminal",
            "sourceEventType": "terminal_tui",
        }
        async with self._http.stream("POST", "/api/v2/agents/current/messages", json=body) as response:
            async for data in iter_sse(response):
                if data == "[DONE]":
                    return
                try:
                    event = json.loads(data)
                except ValueError:
                    continue
                if isinstance(event, dict) and isinstance(event.get("type"), str):
                    yield event

    async def live(self, after: int = 0) -> AsyncIterator[dict[str, Any] | None]:
        """Stream the unified live feed. Yields ``None`` once when connected."""
        params = {"presentation": self.profile.presentation} if self.profile.presentation != "compact" else {}
        headers = {"Accept": "text/event-stream"}
        if after > 0:
            params["after"] = str(after)
            headers["Last-Event-ID"] = str(after)
        async with self._http.stream("GET", "/api/v2/agents/current/live", params=params, headers=headers) as response:
            if response.status_code >= 400:
                async for _ in iter_sse(response):
                    pass
            yield None
            async for data in iter_sse(response):
                try:
                    event = json.loads(data)
                except ValueError:
                    continue
                if (
                    isinstance(event, dict)
                    and event.get("kind") in ("awareness", "runtime", "reset")
                    and isinstance(event.get("sequence"), int)
                ):
                    yield event

    async def stop(self) -> None:
        response = await self._http.post(
            "/api/v2/agents/current/messages/stop", json={"channelId": self.profile.channel_id}
        )
        if response.status_code >= 400:
            raise AgentRequestError(f"Stop request failed ({response.status_code})")
