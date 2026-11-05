"""The transcript model: every source of truth in, one ordered list of items out.

The agent reports the same conversation through three overlapping channels:

* local echoes, painted the moment the operator presses enter;
* the live feed (``/live``): runtime ``user_input`` + cumulative assistant
  snapshots keyed by run, interleaved with durable awareness lines;
* the durable backlog (``/events``), replayed on connect and after gaps.

This module reconciles them without touching the UI. Items are append-only
and keyed; the view only ever adds a widget or refreshes one by key. That
contract is what keeps the screen from jumping around.
"""

from __future__ import annotations

import itertools
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from .protocol import (
    Block,
    HistoryEntry,
    UserInput,
    content_delta,
    is_covered_by_snapshot,
    is_tool_use_stop,
    merge_details,
    normalize_channel,
    normalize_input,
    parse_context_line,
    parse_tool_presentation,
    tool_label,
)

HISTORY_RENDER_LIMIT = 30
LOCAL_ECHO_TTL = 30 * 60.0
ECHO_TTL = 30.0
LEDGER_LIMIT = 200
SEEN_LIMIT = 5_000
TOOL_LIMIT = 512
SNAPSHOT_MEMORY = 64

ToolState = Literal["pending", "success", "error", "cancelled", "unknown"]
Source = Literal["local", "steering", "runtime", "awareness"]


# --------------------------------------------------------------------------- items


@dataclass(eq=False)
class ToolCall:
    """One tool call, stable across snapshots, segments and history replays."""

    identity: str
    number: int
    name: str
    label: str
    state: ToolState = "pending"
    details: dict | None = None
    outputs: list[Block] = field(default_factory=list)
    result: Block | None = None
    started_at: float = field(default_factory=time.monotonic)
    finished_at: float | None = None

    @property
    def has_detail(self) -> bool:
        return bool(self.details or self.outputs or (self.result and self.result.get("displayDetails")))


Part = tuple[Literal["text", "thinking"], str] | tuple[Literal["tool"], ToolCall]


@dataclass(eq=False)
class UserItem:
    key: str
    channel: str
    user: str
    text: str
    local: bool = False
    ambient: bool = False
    generated: bool = False
    timestamp: float = field(default_factory=time.time)
    kind: str = "user"


@dataclass(eq=False)
class AssistantItem:
    key: str
    parts: list[Part] = field(default_factory=list)
    streaming: bool = False
    stop_reason: str | None = None
    model: str | None = None
    channel: str | None = None
    kind: str = "assistant"

    @property
    def is_empty(self) -> bool:
        return not any(kind == "tool" or value.strip() for kind, value in self.parts)  # type: ignore[union-attr]


@dataclass(eq=False)
class NoticeItem:
    key: str
    text: str
    tone: Literal["info", "error", "success", "warning"] = "info"
    kind: str = "notice"


@dataclass(eq=False)
class TransitionItem:
    key: str
    transition_kind: str
    state: str
    revision: int
    tokens_before: int | None = None
    tokens_after: int | None = None
    kind: str = "transition"

    @property
    def title(self) -> str:
        handoff = self.transition_kind == "handoff"
        if self.state == "preparing":
            return "Preparing context handoff…" if handoff else "Compacting context…"
        if self.state == "completed":
            return "Context handed off" if handoff else "Context compacted"
        if self.state == "aborted":
            return "Context transition stopped"
        if self.state == "skipped":
            return "Context transition skipped"
        return "Context transition failed"


Item = UserItem | AssistantItem | NoticeItem | TransitionItem
Listener = Callable[[Literal["add", "update", "clear"], Item | None], None]


# --------------------------------------------------------------------------- bookkeeping


@dataclass(eq=False)
class _Echo:
    """One displayed user input, and which sources have reported it so far."""

    input: UserInput
    item_key: str
    expires: float
    seen: set[Source] = field(default_factory=set)
    adopted_run: str | None = None
    # Accepted steer the model has not read yet; it can wait out any TTL behind a long tool call.
    awaiting_read: bool = False


@dataclass(eq=False)
class _Segment:
    item: AssistantItem
    baseline: list[Block]


@dataclass(eq=False)
class _Run:
    run_id: str
    channel: str
    label: str
    segment: _Segment | None = None
    earlier: list[AssistantItem] = field(default_factory=list)
    snapshot: dict | None = None
    generated_inputs: set[str] = field(default_factory=set)


class Transcript:
    def __init__(self, local_channel: str, show_thinking: bool = False, clock: Callable[[], float] = time.monotonic) -> None:
        self.local_channel = local_channel
        self.show_thinking = show_thinking
        self._clock = clock
        self.items: list[Item] = []
        self._index: dict[str, int] = {}
        self._listeners: list[Listener] = []
        self._ids = itertools.count(1)
        self._echoes: list[_Echo] = []
        self._steers: OrderedDict[str, list[_Echo]] = OrderedDict()  # steering id -> its painted inputs
        self._runs: dict[str, _Run] = {}
        self._latest_run: str | None = None
        self._seen: OrderedDict[str, str | None] = OrderedDict()  # awareness id -> channel
        self._deferred: OrderedDict[str, HistoryEntry] = OrderedDict()
        self._recent_snapshots: list[tuple[float, list[Block]]] = []
        self._channel_grace: dict[str, float] = {}
        self._tools: OrderedDict[str, ToolCall] = OrderedDict()
        self._tool_numbers = itertools.count(1)
        self._transitions: dict[str, TransitionItem] = {}
        self.stream_id = ""
        self.sequence = 0
        self.local_turn_active = False
        self._local_grace_until = 0.0

    # ------------------------------------------------------------------ plumbing

    def subscribe(self, listener: Listener) -> None:
        self._listeners.append(listener)

    def _emit(self, op: Literal["add", "update", "clear"], item: Item | None = None) -> None:
        for listener in self._listeners:
            listener(op, item)

    def _key(self, prefix: str) -> str:
        return f"{prefix}-{next(self._ids)}"

    def _append(self, item: Item) -> Item:
        self._index[item.key] = len(self.items)
        self.items.append(item)
        self._emit("add", item)
        return item

    def _position(self, key: str) -> int:
        return self._index.get(key, -1)

    def clear(self) -> None:
        """Forget everything visible (``/reload``). Tool numbers keep counting."""
        self.items.clear()
        self._index.clear()
        self._echoes.clear()
        self._steers.clear()
        self._seen.clear()
        self._deferred.clear()
        self._transitions.clear()
        for run in self._runs.values():
            run.segment = None
            run.earlier.clear()
        self._emit("clear")

    # ------------------------------------------------------------------ notices

    def notice(self, text: str, tone: Literal["info", "error", "success", "warning"] = "info") -> NoticeItem:
        return self._append(NoticeItem(self._key("notice"), text, tone))  # type: ignore[return-value]

    def error(self, message: str) -> NoticeItem:
        return self.notice(message, "error")

    # ------------------------------------------------------------------ echo ledger

    def _prune(self) -> None:
        now = self._clock()
        self._echoes = [echo for echo in self._echoes if echo.expires > now or echo.awaiting_read][-LEDGER_LIMIT:]
        self._recent_snapshots = [entry for entry in self._recent_snapshots if entry[0] > now][-SNAPSHOT_MEMORY:]
        self._channel_grace = {channel: until for channel, until in self._channel_grace.items() if until > now}

    def _claim(self, value: UserInput, source: Source) -> _Echo | None:
        """Mark an already-painted input as reported by ``source`` (oldest first)."""
        self._prune()
        for echo in self._echoes:
            if source not in echo.seen and echo.input.channel == value.channel and echo.input.text == value.text:
                echo.seen.add(source)
                return echo
        return None

    def _paint_input(self, value: UserInput, source: Source, ambient: bool = False) -> _Echo:
        item = self._append(UserItem(
            self._key("user"),
            value.channel,
            "you" if source == "local" else value.user,
            value.text,
            local=source == "local",
            ambient=ambient or value.user == "ambient",
            generated=value.is_compact_generated,
        ))
        ttl = LOCAL_ECHO_TTL if source == "local" else ECHO_TTL
        echo = _Echo(value, item.key, self._clock() + ttl, {source})
        self._echoes.append(echo)
        return echo

    # ------------------------------------------------------------------ local input

    def submit_local(self, text: str) -> UserItem:
        """Paint the operator's input immediately; later reports of it are absorbed."""
        echo = self._paint_input(UserInput(self.local_channel, "you", text), "local")
        # A message sent while a run is active steers it: its output from here
        # on belongs below this input.
        run = self._run_for_channel(self.local_channel) or (self._runs.get(self._latest_run) if self._latest_run else None)
        if run:
            self._split(run, after_key=echo.item_key)
            echo.adopted_run = run.run_id
        return self.items[self._position(echo.item_key)]  # type: ignore[return-value]

    def begin_local_turn(self) -> None:
        self.local_turn_active = True

    def end_local_turn(self) -> None:
        self.local_turn_active = False
        self._local_grace_until = self._clock() + 2.0
        self._flush_deferred()

    # ------------------------------------------------------------------ runs and segments

    def _run_for_channel(self, channel: str) -> _Run | None:
        normalized = normalize_channel(channel)
        for run in reversed(list(self._runs.values())):
            if run.channel == channel or normalize_channel(run.label) == normalized:
                return run
        return None

    def _split(self, run: _Run, after_key: str | None = None) -> None:
        """Start a new visible segment for ``run``, unless the current one already follows ``after_key``."""
        if run.segment and after_key is not None and self._position(run.segment.item.key) > self._position(after_key):
            return
        baseline = list(run.snapshot["content"]) if run.snapshot else []
        if run.segment and run.segment.item.is_empty:
            # Nothing painted yet; move the empty segment rather than leaving a gap.
            run.segment.baseline = baseline
            if after_key is None or self._position(run.segment.item.key) > self._position(after_key):
                return
        if run.segment:
            run.earlier.append(run.segment.item)
        item = self._append(AssistantItem(self._key("assistant"), streaming=True, channel=run.channel))
        run.segment = _Segment(item, baseline)  # type: ignore[arg-type]

    def _ensure_run(self, envelope: dict[str, Any]) -> _Run:
        run_id = str(envelope.get("runId") or "")
        run = self._runs.get(run_id)
        if run:
            return run
        channel = str(envelope.get("channelId") or "")
        run = _Run(run_id, channel, str(envelope.get("channelLabel") or channel))
        self._runs[run_id] = run
        # The operator's own POST: adopt the oldest local input that no run owns yet.
        if channel == self.local_channel:
            for echo in self._echoes:
                if "local" in echo.seen and echo.adopted_run is None:
                    echo.adopted_run = run_id
                    break
        return run

    # ------------------------------------------------------------------ live feed

    def apply_live(self, event: dict[str, Any]) -> bool:
        """Apply one ``/live`` envelope. Returns True when a backlog catch-up is needed."""
        catch_up = False
        stream_id = str(event.get("streamId") or "")
        if stream_id != self.stream_id:
            # The resident runtime restarted: in-flight runs are gone.
            self.stream_id = stream_id
            self.sequence = 0
            for run in self._runs.values():
                self._finish_segment(run, aborted=True)
            self._runs.clear()
            self._latest_run = None
            self._steers.clear()
            for echo in self._echoes:
                echo.awaiting_read = False
            catch_up = True
        sequence = int(event.get("sequence") or 0)
        if event.get("kind") == "reset":
            self.sequence = max(self.sequence, sequence)
            return True
        if sequence <= self.sequence:
            return catch_up
        self.sequence = sequence
        if event.get("kind") == "awareness":
            self.apply_awareness_line(str(event.get("line") or ""))
        elif event.get("kind") == "runtime":
            self._apply_runtime(event)
        return catch_up

    def _apply_runtime(self, envelope: dict[str, Any]) -> None:
        event = envelope.get("event") if isinstance(envelope.get("event"), dict) else {}
        kind = event.get("type")
        run_id = str(envelope.get("runId") or "")
        if kind != "run_complete":
            self._latest_run = run_id
        if kind == "steering_input":
            self._steering_input(envelope, event)
        elif kind == "user_input":
            self._runtime_inputs(self._ensure_run(envelope), event.get("entries") or [], "runtime")
        elif kind == "status":
            transition = event.get("contextTransition")
            if isinstance(transition, dict):
                self.apply_transition(transition)
        elif kind == "assistant_snapshot" and isinstance(event.get("entry"), dict):
            self._apply_snapshot(self._ensure_run(envelope), event["entry"])
        elif kind == "error":
            self.error(str(event.get("message") or "Unknown error"))
        elif kind == "run_complete":
            run = self._runs.pop(run_id, None)
            if run:
                if run.snapshot:
                    self._remember_snapshot(run.snapshot["content"])
                self._channel_grace[run.channel] = self._clock() + ECHO_TTL
                self._finish_segment(run)
            if self._latest_run == run_id:
                self._latest_run = None
            self._flush_deferred()

    def _steering_input(self, envelope: dict[str, Any], event: dict[str, Any]) -> None:
        """One steer reports accepted, then consumed, then a ``user_input``: all one input."""
        steer_id = str(event.get("id") or "")
        state = event.get("state")
        echoes = self._steers.get(steer_id)
        if echoes is None:
            if state == "dismissed":
                return
            echoes = self._runtime_inputs(self._ensure_run(envelope), event.get("entries") or [], "steering")
            self._steers[steer_id] = echoes
            while len(self._steers) > LEDGER_LIMIT:
                self._steers.popitem(last=False)
        waiting = state == "accepted"
        for echo in echoes:
            echo.awaiting_read = waiting
            if not waiting:
                # The remaining reports follow promptly now that the model has read it.
                echo.expires = max(echo.expires, self._clock() + ECHO_TTL)

    def _runtime_inputs(self, run: _Run, raw_entries: list[Any], source: Source) -> list[_Echo]:
        visible: list[UserInput] = []
        claimed: list[_Echo] = []
        for raw in raw_entries:
            if not isinstance(raw, dict):
                continue
            value = normalize_input(raw)
            if value.is_compact_generated:
                if value.text in run.generated_inputs:
                    continue
                run.generated_inputs.add(value.text)
            echo = self._claim(value, source)
            if echo:
                claimed.append(echo)
            else:
                visible.append(value)
        if visible:
            painted = []
            for value in visible:
                painted.append(self._paint_input(value, source))
                painted[-1].adopted_run = run.run_id
            self._split(run, after_key=painted[-1].item_key)
            return [*claimed, *painted]
        for echo in claimed:
            if echo.adopted_run != run.run_id or run.segment is None:
                echo.adopted_run = run.run_id
                self._split(run, after_key=echo.item_key)
        return claimed

    def _apply_snapshot(self, run: _Run, entry: dict[str, Any]) -> None:
        content = [block for block in entry.get("content") or [] if isinstance(block, dict) and isinstance(block.get("type"), str)]
        if run.segment is None:
            self._split(run)  # baseline is the previous snapshot, captured before this one lands
        run.snapshot = {**entry, "content": content}
        tools = self._update_tools(entry, content)
        segment = run.segment
        assert segment is not None
        segment.item.parts = self._parts(content_delta(content, segment.baseline, self.show_thinking), tools)
        streaming = entry.get("isStreaming") is not False
        segment.item.streaming = streaming
        segment.item.stop_reason = entry.get("stopReason")
        segment.item.model = entry.get("model")
        if not streaming:
            self._remember_snapshot(content)
            self._channel_grace[run.channel] = self._clock() + ECHO_TTL
        for earlier in run.earlier:
            self._emit("update", earlier)  # their tool rows may have just finished
        self._emit("update", segment.item)

    def _finish_segment(self, run: _Run, aborted: bool = False) -> None:
        items = [*run.earlier, *([run.segment.item] if run.segment else [])]
        stop_reason = run.segment.item.stop_reason if run.segment else None
        for item in items:
            item.streaming = False
            for kind, value in item.parts:
                if kind == "tool" and value.state == "pending":  # type: ignore[union-attr]
                    value.state = "cancelled" if aborted or stop_reason == "aborted" else "unknown"  # type: ignore[union-attr]
            self._emit("update", item)

    def _remember_snapshot(self, content: list[Block]) -> None:
        if any((b["type"] == "toolCall" and b.get("id")) or (b["type"] == "text" and str(b.get("text", "")).strip()) for b in content):
            self._recent_snapshots.append((self._clock() + LOCAL_ECHO_TTL, list(content)))

    # ------------------------------------------------------------------ tools

    def _tool(self, identity: str, block: Block) -> ToolCall:
        tool = self._tools.get(identity)
        if tool is None:
            tool = ToolCall(identity, next(self._tool_numbers), str(block.get("name") or "tool"), tool_label(block))
            self._tools[identity] = tool
            while len(self._tools) > TOOL_LIMIT:
                self._tools.popitem(last=False)
        else:
            tool.name = str(block.get("name") or tool.name)
            tool.label = tool_label(block)
        return tool

    def _update_tools(self, entry: dict[str, Any], content: list[Block]) -> dict[int, ToolCall]:
        results = {b.get("toolCallId"): b for b in content if b["type"] == "toolResult"}
        outputs: dict[str, list[Block]] = {}
        for block in content:
            if block["type"] == "toolOutput":
                outputs.setdefault(block.get("toolCallId"), []).append(block)
        streaming = entry.get("isStreaming") is not False
        by_position: dict[int, ToolCall] = {}
        for position, block in enumerate(content):
            if block["type"] != "toolCall":
                continue
            call_id = str(block.get("id") or "")
            identity = f"tool:{call_id}" if call_id else f"snapshot:{entry.get('id')}:{block.get('contentIndex', position)}"
            tool = self._tool(identity, block)
            result = results.get(call_id) or tool.result
            tool.outputs = outputs.get(call_id) or tool.outputs
            details = merge_details(tool.details, block.get("displayDetails"))
            for output in tool.outputs:
                details = merge_details(details, output.get("displayDetails"))
            if result:
                details = merge_details(details, result.get("displayDetails"))
            tool.details = details
            if result:
                tool.result = result
                tool.state = "error" if result.get("isError") else "success"
                tool.finished_at = tool.finished_at or self._clock()
            elif not streaming:
                tool.state = "cancelled" if entry.get("stopReason") == "aborted" else "unknown"
            by_position[id(block)] = tool
        return by_position

    def _parts(self, content: list[Block], tools: dict[int, ToolCall]) -> list[Part]:
        parts: list[Part] = []
        for block in content:
            kind = block["type"]
            if kind == "text" and block.get("text"):
                if parts and parts[-1][0] == "text":
                    parts[-1] = ("text", parts[-1][1] + block["text"])  # type: ignore[operator]
                else:
                    parts.append(("text", block["text"]))
            elif kind == "thinking" and self.show_thinking and block.get("thinking"):
                parts.append(("thinking", block["thinking"]))
            elif kind == "toolCall":
                tool = tools.get(id(block))
                if tool is None:
                    # content_delta may hand back a copy; resolve by identity.
                    call_id = str(block.get("id") or "")
                    tool = self._tools.get(f"tool:{call_id}") if call_id else None
                if tool is not None:
                    parts.append(("tool", tool))
        return parts

    # ------------------------------------------------------------------ durable awareness

    def _remember_seen(self, entry: HistoryEntry) -> bool:
        if entry.id in self._seen:
            return False
        channel = entry.inputs[0].channel if entry.inputs else self._seen.get(entry.parent_id or "")
        self._seen[entry.id] = channel
        while len(self._seen) > SEEN_LIMIT:
            self._seen.popitem(last=False)
        return True

    def _entry_channel(self, entry: HistoryEntry) -> str | None:
        if entry.inputs:
            return entry.inputs[0].channel
        return self._seen.get(entry.parent_id or "")

    def load_history(self, lines: list[str]) -> None:
        """Paint the tail of the durable backlog (connect and ``/reload``)."""
        entries = [entry for entry in map(parse_context_line, lines) if entry is not None]
        presentations = dict(item for item in map(parse_tool_presentation, lines) if item is not None)
        for entry in entries:
            if (
                entry.role == "assistant"
                and entry.message_timestamp in presentations
                and not any(block["type"] == "toolCall" for block in entry.content)
            ):
                entry.content = presentations[entry.message_timestamp]
        fresh = [entry for entry in entries if entry.id not in self._seen]
        for entry in entries:
            if entry.id not in self._seen:
                self._seen[entry.id] = self._entry_channel(entry)
        for entry in entries:
            if entry.role == "toolResult":
                self._apply_tool_results(entry)
        visible = [entry for entry in fresh if entry.role != "toolResult"][-HISTORY_RENDER_LIMIT:]
        for entry in visible:
            self._paint_entry(entry, historical=True)

    def apply_awareness_line(self, line: str) -> None:
        entry = parse_context_line(line)
        if entry is None or entry.id in self._seen:
            return
        if entry.role == "toolResult":
            self._remember_seen(entry)
            self._apply_tool_results(entry)
            return
        if entry.role == "user":
            self._remember_seen(entry)
            self._deferred.pop(entry.id, None)
            for value in entry.inputs:
                if self._claim(value, "awareness"):
                    continue
                echo = self._paint_input(value, "awareness", ambient=entry.is_ambient)
                run = self._run_for_channel(value.channel)
                if run:
                    echo.adopted_run = run.run_id
                    self._split(run, after_key=echo.item_key)
            return
        if entry.role == "assistant":
            if self._assistant_already_shown(entry):
                self._deferred.pop(entry.id, None)
                self._remember_seen(entry)
                return
            if self._runs or self.local_turn_active:
                # A live snapshot for this text may still be on its way.
                self._deferred[entry.id] = entry
                return
            self._deferred.pop(entry.id, None)
            self._remember_seen(entry)
            self._paint_entry(entry, historical=True)

    def _assistant_already_shown(self, entry: HistoryEntry) -> bool:
        self._prune()
        channel = self._entry_channel(entry)
        if channel and channel in self._channel_grace:
            return True
        if channel == self.local_channel and (self.local_turn_active or self._clock() < self._local_grace_until):
            return True
        for index, (_, content) in enumerate(self._recent_snapshots):
            if is_covered_by_snapshot(entry.content, content):
                self._recent_snapshots.pop(index)
                return True
        for run in self._runs.values():
            if run.snapshot and is_covered_by_snapshot(entry.content, run.snapshot["content"]):
                return True
        return False

    def _flush_deferred(self) -> None:
        if self._runs or self.local_turn_active:
            return
        pending = list(self._deferred.values())
        self._deferred.clear()
        for entry in pending:
            if entry.id in self._seen:
                continue
            self._remember_seen(entry)
            if not self._assistant_already_shown(entry):
                self._paint_entry(entry, historical=True)

    def _apply_tool_results(self, entry: HistoryEntry) -> None:
        for block in entry.content:
            if block["type"] != "toolResult":
                continue
            tool = self._tools.get(f"tool:{block.get('toolCallId')}")
            if tool and tool.state in ("pending", "unknown"):
                tool.state = "error" if block.get("isError") else "success"
                self._touch_tool(tool)

    def _touch_tool(self, tool: ToolCall) -> None:
        for item in reversed(self.items):
            if isinstance(item, AssistantItem) and any(kind == "tool" and value is tool for kind, value in item.parts):
                self._emit("update", item)
                return

    def _paint_entry(self, entry: HistoryEntry, historical: bool) -> None:
        if entry.role == "user":
            for value in entry.inputs:
                if historical:
                    if self._claim(value, "awareness"):
                        continue
                self._paint_input(value, "awareness", ambient=entry.is_ambient)
            return
        if entry.role != "assistant":
            return
        tools: dict[int, ToolCall] = {}
        for position, block in enumerate(entry.content):
            if block["type"] != "toolCall":
                continue
            call_id = str(block.get("id") or "")
            identity = f"tool:{call_id}" if call_id else f"history:{entry.id}:{position}"
            known = identity in self._tools
            tool = self._tool(identity, block)
            if not known:
                tool.state = "success"  # durable history: the call completed; a toolResult may refine this.
                tool.finished_at = tool.started_at
            tools[id(block)] = tool
        for block in entry.content:
            if block["type"] == "toolResult" and block.get("isError"):
                failed = self._tools.get(f"tool:{block.get('toolCallId')}")
                if failed is not None:
                    failed.state = "error"
        item = AssistantItem(
            self._key("assistant"),
            self._parts(entry.content, tools),
            streaming=False,
            stop_reason=entry.stop_reason,
            model=entry.model,
            channel=self._entry_channel(entry),
        )
        if not item.is_empty:
            self._append(item)

    # ------------------------------------------------------------------ context transitions

    def apply_transition(self, transition: dict[str, Any]) -> None:
        transition_id = str(transition.get("id") or "")
        revision = int(transition.get("revision") or 0)
        existing = self._transitions.get(transition_id)
        if existing and revision <= existing.revision:
            return
        if existing:
            existing.state = str(transition.get("state") or existing.state)
            existing.revision = revision
            existing.tokens_before = transition.get("tokensBefore") or existing.tokens_before
            existing.tokens_after = transition.get("tokensAfter") or existing.tokens_after
            self._emit("update", existing)
            return
        item = TransitionItem(
            self._key("transition"),
            str(transition.get("kind") or "compaction"),
            str(transition.get("state") or "preparing"),
            revision,
            transition.get("tokensBefore"),
            transition.get("tokensAfter"),
        )
        self._transitions[transition_id] = item
        while len(self._transitions) > 128:
            self._transitions.pop(next(iter(self._transitions)))
        self._append(item)

    # ------------------------------------------------------------------ activity

    def activity(self) -> str | None:
        """What the agent is visibly doing right now, from the live feed."""
        for run in reversed(list(self._runs.values())):
            snapshot = run.snapshot
            if not snapshot:
                return "Thinking"
            content = snapshot["content"]
            done = {b.get("toolCallId") for b in content if b["type"] == "toolResult"}
            for block in reversed(content):
                if block["type"] == "toolCall" and block.get("id") not in done:
                    return tool_label(block)
            if snapshot.get("isStreaming") is not False or is_tool_use_stop(snapshot.get("stopReason")):
                return "Writing" if any(b["type"] == "text" for b in content[-1:]) else "Thinking"
        return None

    @property
    def tools(self) -> list[ToolCall]:
        return list(self._tools.values())
