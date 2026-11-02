"""Transcript widgets. Each one renders a single model item and refreshes in place."""

from __future__ import annotations

import json
import time
from datetime import datetime

from rich.console import Group, RenderableType
from rich.syntax import Syntax
from rich.text import Text
from textual import events
from textual.binding import Binding
from textual.containers import Vertical
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Markdown, Static

from .protocol import one_line, sanitize
from .transcript import AssistantItem, Item, NoticeItem, ToolCall, TransitionItem, UserItem

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
MAX_DETAIL = 24_000
DETAIL_BACKGROUND = "#1A1B24"  # matches $surface in the troublemaker theme
TOOL_GLYPHS = {"pending": "", "success": "✓", "error": "✗", "cancelled": "−", "unknown": "·"}
TOOL_STYLES = {"pending": "$warning", "success": "$success", "error": "$error", "cancelled": "$text-muted", "unknown": "$text-muted"}


def spinner_frame() -> str:
    return SPINNER[int(time.monotonic() * 12) % len(SPINNER)]


def format_duration(seconds: float) -> str:
    if seconds < 1:
        return f"{int(seconds * 1000)}ms"
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, rest = divmod(int(seconds), 60)
    return f"{minutes}m {rest:02d}s"


def bound(text: str) -> str:
    safe = sanitize(text)
    if len(safe) <= MAX_DETAIL:
        return safe
    head = int(MAX_DETAIL * 0.65)
    tail = MAX_DETAIL - head
    return f"{safe[:head]}\n… {len(safe) - head - tail:,} characters omitted …\n{safe[-tail:]}"


# --------------------------------------------------------------------------- markdown


class StreamingMarkdown(Markdown):
    """Markdown that appends streamed suffixes instead of re-rendering the whole document."""

    def __init__(self, text: str = "", **kwargs) -> None:
        super().__init__(text, **kwargs)  # Markdown renders the initial document on mount.
        self._target = text
        self._shown = text
        self._syncing = False

    def set_text(self, text: str) -> None:
        if text == self._target:
            return
        self._target = text
        self._kick()

    def _kick(self) -> None:
        if not self._syncing and self._shown != self._target:
            self._syncing = True
            self.run_worker(self._sync(), group="markdown")

    async def _sync(self) -> None:
        try:
            while self._shown != self._target:
                target = self._target
                if self._shown and target.startswith(self._shown):
                    await self.append(target[len(self._shown):])
                else:
                    await self.update(target)
                self._shown = target
        finally:
            self._syncing = False


# --------------------------------------------------------------------------- user and notices


class UserMessage(Static):
    def __init__(self, item: UserItem) -> None:
        classes = "user"
        if item.local:
            classes += " -local"
        if item.ambient:
            classes += " -ambient"
        if item.generated:
            classes += " -generated"
        super().__init__(classes=classes)
        self.item = item

    def render(self) -> RenderableType:
        item = self.item
        stamp = datetime.fromtimestamp(item.timestamp).strftime("%H:%M")
        if item.generated:
            return Text.assemble(("↻ ", "bold"), (sanitize(item.text), "italic"), (f"  {stamp}", "dim"))
        text = Text()
        if not item.local:
            text.append(item.user, style="bold")
            text.append(f" {item.channel}  ", style="dim")
        text.append(sanitize(item.text), style="italic" if item.ambient else "")
        text.append(f"  {stamp}", style="dim")
        return text

    def sync(self) -> None:
        self.refresh(layout=True)


class Notice(Static):
    GLYPHS = {"info": "·", "error": "✗", "success": "✓", "warning": "!"}

    def __init__(self, item: NoticeItem) -> None:
        super().__init__(classes=f"notice -{item.tone}")
        self.item = item

    def render(self) -> RenderableType:
        return Text.assemble((f"{self.GLYPHS[self.item.tone]} ", "bold"), sanitize(self.item.text))

    def sync(self) -> None:
        self.refresh(layout=True)


class Transition(Static):
    def __init__(self, item: TransitionItem) -> None:
        super().__init__(classes="transition")
        self.item = item

    def render(self) -> RenderableType:
        item = self.item
        glyph = {"preparing": spinner_frame(), "completed": "✓", "failed": "✗"}.get(item.state, "−")
        text = Text.assemble((f"{glyph} ", "bold"), item.title)
        if item.tokens_before and item.tokens_after:
            text.append(f"  {item.tokens_before / 1000:.0f}k → {item.tokens_after / 1000:.0f}k tokens", style="dim")
        return text

    def sync(self) -> None:
        self.set_class(self.item.state == "preparing", "-active")
        self.set_class(self.item.state == "completed", "-done")
        self.set_class(self.item.state == "failed", "-failed")
        self.refresh()

    def on_mount(self) -> None:
        self.sync()


# --------------------------------------------------------------------------- tools


class ToolRow(Vertical, can_focus=True):
    """One tool call: a single summary line that expands into bounded, safe detail."""

    BINDINGS = [
        Binding("enter,space,right,l", "toggle", "Expand", show=False),
        Binding("left,h", "collapse", "Collapse", show=False),
        Binding("up,k", "move(-1)", "Previous tool", show=False),
        Binding("down,j", "move(1)", "Next tool", show=False),
        Binding("escape", "leave", "Back to input", show=False),
    ]

    class Move(Message):
        def __init__(self, row: ToolRow, step: int) -> None:
            super().__init__()
            self.row = row
            self.step = step

    class Leave(Message):
        pass

    def __init__(self, tool: ToolCall) -> None:
        super().__init__(classes="tool")
        self.tool = tool
        self.expanded = False
        self._header = Static(classes="tool-header")
        self._detail = Static(classes="tool-detail")

    def compose(self):
        yield self._header
        yield self._detail

    def on_mount(self) -> None:
        self.sync()

    def sync(self) -> None:
        tool = self.tool
        for state in TOOL_GLYPHS:
            self.set_class(tool.state == state, f"-{state}")
        self.set_class(self.expanded, "-expanded")
        self._header.update(self._header_text())
        self._detail.display = self.expanded
        if self.expanded:
            self._detail.update(self._detail_renderable())

    def tick(self) -> None:
        if self.tool.state == "pending":
            self._header.update(self._header_text())

    def _header_text(self) -> Text:
        tool = self.tool
        glyph = spinner_frame() if tool.state == "pending" else TOOL_GLYPHS[tool.state]
        text = Text(no_wrap=True, overflow="ellipsis")
        text.append(f"{glyph} ", style="bold")
        text.append(tool.label, style="bold" if tool.state == "pending" else "")
        end = tool.finished_at if tool.finished_at is not None else (time.monotonic() if tool.state == "pending" else None)
        meta: list[str] = []
        detail = tool.details or {}
        if isinstance(detail.get("durationMilliseconds"), (int, float)):
            meta.append(format_duration(detail["durationMilliseconds"] / 1000))
        elif end is not None and end - tool.started_at >= 0.05:
            meta.append(format_duration(end - tool.started_at))
        if isinstance(detail.get("exitStatus"), int) and detail["exitStatus"] != 0:
            meta.append(f"exit {detail['exitStatus']}")
        if meta:
            text.append("  " + " · ".join(meta), style="dim")
        text.append(f"  #{tool.number}", style="dim")
        if tool.has_detail:
            text.append("  ▾" if self.expanded else "  ▸", style="dim")
        return text

    def _detail_renderable(self) -> RenderableType:
        tool = self.tool
        details = tool.details or {}
        sections: list[RenderableType] = []

        def heading(label: str, style: str = "dim") -> None:
            sections.append(Text(label, style=f"{style} bold"))

        def body(content: dict | None, fallback: str = "") -> RenderableType:
            text = bound(str((content or {}).get("text") or fallback)).rstrip("\n")
            fmt = (content or {}).get("format")
            lexer = {"json": "json", "shell": "bash", "diff": "diff"}.get(fmt or "", (content or {}).get("language") or "")
            if fmt == "code" and not lexer:
                lexer = "text"
            if lexer:
                return Syntax(text, lexer, theme="ansi_dark", word_wrap=True, background_color=DETAIL_BACKGROUND)
            return Text(text, style="red" if fmt == "error" else "")

        name = one_line(str(details.get("toolName") or tool.name))
        if name.lower() != tool.label.lower():
            sections.append(Text(name, style="dim"))
        invocation = details.get("invocation")
        if invocation and invocation.get("text"):
            heading("input")
            sections.append(body(invocation))
        streamed = ""
        for output in tool.outputs:
            result = (output.get("displayDetails") or {}).get("result")
            if not result or not result.get("text"):
                continue
            pid = f" · pid {output['pid']}" if isinstance(output.get("pid"), int) else ""
            heading(f"{output.get('stream', 'stdout')}{pid}")
            sections.append(body(result))
            streamed += sanitize(result["text"])
        final = ((tool.result or {}).get("displayDetails") or {}).get("result") or (details.get("result") if not tool.outputs else None)
        if final and final.get("text") and sanitize(final["text"]) != streamed:
            heading("error" if tool.state == "error" else "output", "red" if tool.state == "error" else "dim")
            sections.append(body(final))
        for artifact in details.get("artifacts") or []:
            heading(f"artifact · {one_line(str(artifact.get('label') or ''))}")
            sections.append(Text(bound(str(artifact.get("reference") or ""))))
        if not sections:
            sections.append(Text(
                "No detail retained for this call." if tool.state != "pending" else "Waiting for output…",
                style="dim italic",
            ))
        return Group(*sections)

    def action_toggle(self) -> None:
        self.expanded = not self.expanded
        self.sync()
        if self.expanded:
            self.call_after_refresh(self.scroll_visible, animate=False)

    def action_collapse(self) -> None:
        if self.expanded:
            self.action_toggle()

    def set_expanded(self, expanded: bool) -> None:
        if self.expanded != expanded:
            self.expanded = expanded
            self.sync()

    def action_move(self, step: int) -> None:
        self.post_message(self.Move(self, step))

    def action_leave(self) -> None:
        self.post_message(self.Leave())

    def on_click(self, event: events.Click) -> None:
        event.stop()
        self.focus(scroll_visible=False)
        self.action_toggle()


# --------------------------------------------------------------------------- thinking


class Thinking(Static, can_focus=False):
    """Model reasoning: one dim line once complete, the full text on click."""

    def __init__(self, text: str) -> None:
        super().__init__(classes="thinking")
        self.text = text
        self.streaming = True
        self.expanded = False

    def set(self, text: str, streaming: bool) -> None:
        self.text, self.streaming = text, streaming
        self.refresh(layout=True)

    def render(self) -> RenderableType:
        clean = sanitize(self.text).strip()
        if self.streaming or self.expanded:
            return Text.assemble(("✻ ", "bold"), (clean, "italic"))
        first = clean.splitlines()[0] if clean else ""
        lines = clean.count("\n") + 1
        return Text.assemble(
            ("✻ ", "bold"), (first, "italic"), (f"  +{lines - 1} lines ▸" if lines > 1 else "", "dim"),
            no_wrap=True, overflow="ellipsis",
        )

    def on_click(self) -> None:
        self.expanded = not self.expanded
        self.refresh(layout=True)


# --------------------------------------------------------------------------- assistant


class AssistantMessage(Vertical):
    """An assistant segment: text, thinking and tool rows in their original order."""

    def __init__(self, item: AssistantItem) -> None:
        super().__init__(classes="assistant")
        self.item = item
        self._rendered: list[tuple[str, object]] = []

    def on_mount(self) -> None:
        self.sync()

    def sync(self) -> None:
        item = self.item
        self.display = not item.is_empty
        self.set_class(item.streaming, "-streaming")
        children = list(self.children)
        keep = 0
        for index, part in enumerate(item.parts):
            if index >= len(self._rendered):
                break
            kind, value = part
            old_kind, old_value = self._rendered[index]
            if old_kind != kind or (kind == "tool" and old_value is not value):
                break
            keep = index + 1
        # Drop everything after the first divergence; parts are append-mostly so this is rare.
        if keep < len(children):
            for child in children[keep:]:
                child.remove()
            children = children[:keep]
            self._rendered = self._rendered[:keep]
        for index, (kind, value) in enumerate(item.parts):
            if index < keep:
                widget = children[index]
                if kind == "text":
                    widget.set_text(sanitize(value))  # type: ignore[attr-defined]
                elif kind == "thinking":
                    widget.set(value, item.streaming)  # type: ignore[attr-defined]
                else:
                    widget.sync()  # type: ignore[attr-defined]
                continue
            if kind == "text":
                widget = StreamingMarkdown(sanitize(value))
            elif kind == "thinking":
                widget = Thinking(value)
                widget.streaming = item.streaming
            else:
                widget = ToolRow(value)  # type: ignore[arg-type]
            self.mount(widget)
            self._rendered.append((kind, value))
        # Consecutive tool rows read as one block; space them from prose only.
        for index, child in enumerate(self.children):
            previous = self._rendered[index - 1][0] if index > 0 else None
            child.set_class(previous is not None and (previous == "tool") != (self._rendered[index][0] == "tool"), "-gap")

    def tick(self) -> None:
        for child in self.children:
            if isinstance(child, ToolRow):
                child.tick()


def widget_for(item: Item) -> Widget:
    if isinstance(item, UserItem):
        return UserMessage(item)
    if isinstance(item, AssistantItem):
        return AssistantMessage(item)
    if isinstance(item, TransitionItem):
        return Transition(item)
    return Notice(item)


def debug_json(value: object) -> str:  # pragma: no cover - developer aid
    return json.dumps(value, indent=2, default=str)
