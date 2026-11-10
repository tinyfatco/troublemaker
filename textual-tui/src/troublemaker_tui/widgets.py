"""Transcript widgets. Each one renders a single model item and refreshes in place."""

from __future__ import annotations

import json
import re
import time
import zlib
from datetime import datetime

from rich.console import Group, RenderableType
from rich.padding import Padding
from rich.syntax import Syntax
from rich.text import Text
from textual import events
from textual.binding import Binding
from textual.containers import Vertical
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Static

from .markdown import MarkdownBody
from .protocol import one_line, sanitize
from .transcript import AssistantItem, Item, NoticeItem, ToolCall, TransitionItem, UserItem

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
MAX_DETAIL = 24_000
DETAIL_BACKGROUND = "#1A1B24"  # matches $surface in the troublemaker theme
INSET = "#101118"  # code wells inside a tool card, a step darker than the card
CARD_INK = "#14151C"  # pill text, the theme background
DETAIL_LINES = 14
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


def text_key(text: Text) -> tuple:
    """Identity of a rendered line, styles included (``Text.__eq__`` compares plain text only)."""
    return (text.plain, str(text.style), tuple((span.start, span.end, str(span.style)) for span in text.spans))


def bound(text: str) -> str:
    safe = sanitize(text)
    if len(safe) <= MAX_DETAIL:
        return safe
    head = int(MAX_DETAIL * 0.65)
    tail = MAX_DETAIL - head
    return f"{safe[:head]}\n… {len(safe) - head - tail:,} characters omitted …\n{safe[-tail:]}"


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


SPEAKER_COLORS = ("#7AA2F7", "#9ECE6A", "#E0AF68", "#BB9AF7", "#7DCFFF", "#FF9E64", "#F7768E", "#73DACA")
AMBIENT_VISIBLE = 4
_SPEAKER_RE = re.compile(r"^([^:\n]{1,40}):\s+(.*)$")


def speaker_color(name: str) -> str:
    """Stable per-speaker color, so the same person reads the same everywhere."""
    return SPEAKER_COLORS[zlib.crc32(name.strip().lower().encode()) % len(SPEAKER_COLORS)]


def ambient_messages(text: str) -> list[tuple[str | None, str]]:
    """Split an ambient block into ``(speaker, text)``; unattributed lines continue the previous message."""
    messages: list[tuple[str | None, str]] = []
    for raw in sanitize(text).replace("\\`", "`").split("\n"):
        line = raw.strip()
        if not line:
            continue
        match = _SPEAKER_RE.match(line)
        if match and not match[1].startswith(("http", "-", "*")):
            messages.append((match[1].strip(), match[2]))
        elif messages:
            speaker, body = messages[-1]
            messages[-1] = (speaker, f"{body}\n{line}")
        else:
            messages.append((None, line))
    return messages


class AmbientMessage(Static):
    """Conversation the agent overheard: a quiet channel card, newest messages first in view."""

    def __init__(self, item: UserItem) -> None:
        super().__init__(classes="ambient")
        self.item = item
        self.expanded = False

    def render(self) -> RenderableType:
        item = self.item
        messages = ambient_messages(item.text)
        hidden = 0 if self.expanded else max(0, len(messages) - AMBIENT_VISIBLE)
        stamp = datetime.fromtimestamp(item.timestamp).strftime("%H:%M")
        header = Text(no_wrap=True, overflow="ellipsis")
        header.append("◌ ", style="dim")
        header.append(item.channel, style="bold dim")
        count = len(messages)
        header.append(f"  {count} message{'s' if count != 1 else ''} · {stamp}", style="dim")
        if hidden:
            header.append(f"  +{hidden} earlier ▸", style="dim italic")
        elif self.expanded and count > AMBIENT_VISIBLE:
            header.append("  ▾", style="dim")
        lines: list[RenderableType] = [header]
        for speaker, body in messages[hidden:]:
            line = Text()
            if speaker:
                line.append(speaker, style=f"bold {speaker_color(speaker)}")
                line.append("  ")
            first, *rest = body.split("\n")
            line.append(first)
            for continuation in rest:
                line.append("\n  " + continuation, style="dim")
            lines.append(line)
        return Group(*lines)

    def on_click(self) -> None:
        if len(ambient_messages(self.item.text)) > AMBIENT_VISIBLE:
            self.expanded = not self.expanded
            self.refresh(layout=True)

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
        self.full = False
        self._header = Static(classes="tool-header")
        self._header_shown: tuple | None = None
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
        self._update_header()
        self._detail.display = self.expanded
        if self.expanded:
            details = tool.details or {}
            name = one_line(str(details.get("toolName") or tool.name))
            self._detail.border_title = f"[bold]{name}[/]"
            self._detail.border_subtitle = self._badge()
            self._detail.update(self._detail_renderable())

    def tick(self) -> None:
        if self.tool.state == "pending":
            self._update_header()

    def _update_header(self) -> None:
        # The header is a fixed single line; skip identical frames and never relayout.
        text = self._header_text()
        key = text_key(text)
        if key != self._header_shown:
            self._header_shown = key
            self._header.update(text, layout=False)

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
        if tool.has_detail:
            text.append("  ▾" if self.expanded else "  ▸", style="dim")
        return text

    def _badge(self) -> str:
        """Status badge for the card's corner, as Textual markup."""
        tool = self.tool
        details = tool.details or {}
        color = {"success": "#9ECE6A", "error": "#F7768E", "pending": "#E0AF68"}.get(tool.state, "#565F89")
        status = {"success": "✓ done", "error": "✗ failed", "pending": "running", "cancelled": "− stopped"}.get(tool.state, "· unknown")
        if isinstance(details.get("exitStatus"), int):
            code = details["exitStatus"]
            if code != 0 and tool.state == "success":
                color = "#E0AF68"  # the call worked, but the command it ran did not
            glyph = "✗" if tool.state == "error" else "!" if code != 0 else TOOL_GLYPHS.get(tool.state) or "·"
            status = f"{glyph} exit {code}"
        parts = [f"[bold {color}]{status}[/]"]
        if isinstance(details.get("durationMilliseconds"), (int, float)):
            parts.append(f"[#565F89]{format_duration(details['durationMilliseconds'] / 1000)}[/]")
        return " [#3B4261]·[/] ".join(parts)

    def _detail_renderable(self) -> RenderableType:
        tool = self.tool
        details = tool.details or {}
        blocks: list[RenderableType] = []

        def section(label: str, color: str, content: dict | None, meta: str = "", prompt: str = "") -> None:
            raw = bound(str((content or {}).get("text") or "")).rstrip("\n")
            lines = raw.split("\n")
            hidden = 0 if self.full else max(0, len(lines) - DETAIL_LINES)
            shown = "\n".join(lines[:len(lines) - hidden] if hidden else lines)
            pill = Text.assemble((f" {label} ", f"bold {CARD_INK} on {color}"))
            info = [meta] if meta else []
            if len(lines) > 1:
                info.append(f"{len(lines)} lines")
            if (content or {}).get("isTruncated"):
                info.append("truncated by agent")
            if info:
                pill.append("  " + " · ".join(info), style="#565F89")
            if blocks:
                blocks.append(Text(""))
            blocks.append(pill)
            fmt = (content or {}).get("format")
            lexer = {"json": "json", "shell": "bash", "diff": "diff"}.get(fmt or "", (content or {}).get("language") or "")
            if lexer:
                code: RenderableType = Syntax(prompt + shown, lexer, theme="ansi_dark", word_wrap=True, background_color=INSET)
            else:
                code = Text(prompt + shown, style=f"{'#F7768E' if fmt == 'error' else '#C8D0F0'} on {INSET}")
            blocks.append(Padding(code, (0, 1), style=f"on {INSET}"))
            if hidden:
                blocks.append(Padding(
                    Text(f"⋯ {hidden} more line{'s' if hidden != 1 else ''} · click to show all", style=f"italic #565F89 on {INSET}"),
                    (0, 1), style=f"on {INSET}",
                ))

        invocation = details.get("invocation")
        if invocation and invocation.get("text"):
            prompt = "$ " if invocation.get("format") == "shell" else ""
            section("INPUT", "#7AA2F7", invocation, prompt=prompt)
        streamed = ""
        for output in tool.outputs:
            result = (output.get("displayDetails") or {}).get("result")
            if not result or not result.get("text"):
                continue
            stream = str(output.get("stream") or "stdout")
            pid = f"pid {output['pid']}" if isinstance(output.get("pid"), int) else ""
            color = {"stderr": "#E0AF68", "system": "#BB9AF7"}.get(stream, "#7DCFFF")
            section(stream.upper(), color, result, meta=pid)
            streamed += sanitize(result["text"])
        final = ((tool.result or {}).get("displayDetails") or {}).get("result") or (details.get("result") if not tool.outputs else None)
        if final and final.get("text") and sanitize(final["text"]) != streamed:
            if tool.state == "error":
                section("ERROR", "#F7768E", {**final, "format": final.get("format") or "error"})
            else:
                section("OUTPUT", "#9ECE6A", final)
        for artifact in details.get("artifacts") or []:
            section("ARTIFACT", "#BB9AF7", {"text": str(artifact.get("reference") or "")}, meta=one_line(str(artifact.get("label") or "")))
        if not blocks:
            message = "Waiting for output…" if tool.state == "pending" else "No detail was retained for this call."
            blocks.append(Text(message, style="italic #565F89"))
        return Group(*blocks)

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
        # Header toggles the card; inside the card, toggles long output. The
        # click then bubbles up and returns focus to the input.
        target = getattr(event, "widget", None)
        if self.expanded and target is not None and target is not self._header and self._detail in (target, *target.ancestors):
            self.full = not self.full
            self.sync()
            return
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
                widget = MarkdownBody(sanitize(value))
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
            if isinstance(child, ToolRow) and child.tool.state == "pending":
                child.tick()


def widget_for(item: Item) -> Widget:
    if isinstance(item, UserItem):
        return AmbientMessage(item) if item.ambient else UserMessage(item)
    if isinstance(item, AssistantItem):
        return AssistantMessage(item)
    if isinstance(item, TransitionItem):
        return Transition(item)
    return Notice(item)


def debug_json(value: object) -> str:  # pragma: no cover - developer aid
    return json.dumps(value, indent=2, default=str)
