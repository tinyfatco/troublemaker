"""The Troublemaker Textual terminal."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from pathlib import Path

from rich.text import Text
from textual import events, on, work
from textual.app import App, ComposeResult, SystemCommand
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.message import Message
from textual.screen import Screen
from textual.theme import Theme
from textual.widget import Widget
from textual.widgets import Static, TextArea
from textual.worker import Worker

from .client import AgentClient, AgentStatus, RunStatus
from .config import Profile
from .transcript import AssistantItem, Item, Transcript
from .widgets import AssistantMessage, ToolRow, Transition, format_duration, spinner_frame, text_key, widget_for

HISTORY_LIMIT = 60
STATUS_POLL = 0.5
FRAME = 1 / 30
# Mounted transcript items. Every layout pass walks every mounted widget, so a
# session that runs for hours must not grow the tree without bound.
MAX_MOUNTED = 240

THEME = Theme(
    name="troublemaker",
    primary="#9D7CD8",
    secondary="#7AA2F7",
    accent="#FF9E64",
    foreground="#C8D0F0",
    background="#14151C",
    surface="#1A1B24",
    panel="#232533",
    success="#9ECE6A",
    warning="#E0AF68",
    error="#F7768E",
    dark=True,
    variables={
        "block-cursor-background": "#9D7CD8",
        "block-cursor-foreground": "#14151C",
        "footer-key-foreground": "#FF9E64",
        "input-selection-background": "#9D7CD8 35%",
    },
)


@dataclass(frozen=True)
class Command:
    name: str
    description: str
    local: bool


COMMANDS = [
    Command("help", "Show keys and commands", True),
    Command("stop", "Stop the active turn", True),
    Command("tools", "Expand every tool call", True),
    Command("collapse", "Collapse every tool call", True),
    Command("thinking", "Toggle streaming model thinking", True),
    Command("reload", "Repaint recent awareness", True),
    Command("status", "Refresh the agent connection", True),
    Command("quit", "Exit", True),
    Command("model", "Show or switch the model", False),
    Command("context", "Show context usage", False),
    Command("compact", "Compact the agent's context", False),
    Command("clear", "Archive and reset agent context", False),
    Command("voice", "Voice settings", False),
    Command("login", "Sign in to a provider", False),
    Command("cancel", "Cancel a pending input request", False),
]
LOCAL = {command.name for command in COMMANDS if command.local} | {"exit"}

HELP = """\
enter send · shift+enter or ctrl+j newline · ↑↓ history
/ opens commands — ↑↓ choose, enter run, tab complete with arguments
esc stop the active turn · ctrl+c stop, then quit · ctrl+d quit when empty
ctrl+t jump to tool calls — ↑↓ move, enter expand, esc back · click any tool to expand
ctrl+e expand/collapse all tools · ctrl+p command palette · pgup/pgdn scroll
Typing while the agent works steers the running turn.
Local: /help /stop /tools /collapse /thinking /reload /status /quit
Agent: /model /context /compact /clear /voice /login /cancel"""


# --------------------------------------------------------------------------- composer


def idle_placeholder(name: str) -> str:
    return f"Message {name}  ·  / commands  ·  ctrl+t tools"


class Composer(TextArea):
    """Multi-line input: enter sends, shift+enter / ctrl+j insert a newline."""

    BINDINGS = [Binding("ctrl+j,shift+enter,alt+enter", "newline", "Newline", show=False)]

    class Submitted(Message):
        def __init__(self, text: str) -> None:
            super().__init__()
            self.text = text

    def __init__(self, **kwargs) -> None:
        super().__init__(soft_wrap=True, show_line_numbers=False, compact=True, **kwargs)
        self.sent_history: list[str] = []
        self._history_index: int | None = None
        self._draft = ""

    async def _on_key(self, event: events.Key) -> None:
        app = self.app  # type: ignore[assignment]
        if app.command_menu_open and event.key in ("up", "down", "enter", "tab"):
            event.stop()
            event.prevent_default()
            if event.key in ("up", "down"):
                app.move_command(-1 if event.key == "up" else 1)
            else:
                name = app.selected_command()
                if event.key == "tab":
                    self.text = f"/{name} "
                    self.move_cursor(self.document.end)
                else:
                    self.clear()
                    self.post_message(self.Submitted(f"/{name}"))
            return
        if event.key == "enter":
            event.stop()
            event.prevent_default()
            text = self.text.strip()
            if text:
                if not self.sent_history or self.sent_history[-1] != text:
                    self.sent_history.append(text)
                self._history_index = None
                self.clear()
                self.post_message(self.Submitted(text))
            return
        if event.key == "tab":
            completion = self.app.complete_command(self.text)  # type: ignore[attr-defined]
            if completion:
                event.stop()
                event.prevent_default()
                self.text = completion
                self.move_cursor(self.document.end)
                return
        if event.key == "up" and self.cursor_location[0] == 0 and self.sent_history:
            event.stop()
            event.prevent_default()
            if self._history_index is None:
                self._draft = self.text
                self._history_index = len(self.sent_history)
            self._history_index = max(0, self._history_index - 1)
            self._recall(self.sent_history[self._history_index])
            return
        if event.key == "down" and self._history_index is not None and self.cursor_location[0] == self.document.line_count - 1:
            event.stop()
            event.prevent_default()
            self._history_index += 1
            if self._history_index >= len(self.sent_history):
                self._history_index = None
                self._recall(self._draft)
            else:
                self._recall(self.sent_history[self._history_index])
            return
        await super()._on_key(event)

    def _recall(self, text: str) -> None:
        self.text = text
        self.move_cursor(self.document.end)

    def action_newline(self) -> None:
        self.insert("\n")


# --------------------------------------------------------------------------- chrome


class HeaderBar(Horizontal):
    def __init__(self, profile: Profile) -> None:
        super().__init__(id="header")
        self.profile = profile
        self.status: AgentStatus | None = None
        self.connection = "connecting"
        self._left = Static(id="header-left")
        self._right = Static(id="header-right")

    def compose(self) -> ComposeResult:
        yield self._left
        yield self._right

    def on_mount(self) -> None:
        self.sync()

    def sync(self) -> None:
        name = self.status.agent_name if self.status else self.profile.name
        left = Text(no_wrap=True, overflow="ellipsis")
        left.append("◆ ", style="bold #FF9E64")
        left.append(name, style="bold")
        left.append(f"  {self.profile.channel_id}", style="dim")
        if self.status:
            left.append(f" · {self.status.runtime} · {self.status.mode}", style="dim")
        if self.profile.presentation == "pi-thinking":
            left.append(" · thinking", style="dim")
        self._left.update(left)
        styles = {"live": ("●", "#9ECE6A"), "connecting": ("◌", "#E0AF68"), "reconnecting": ("◌", "#E0AF68"), "offline": ("○", "#F7768E")}
        glyph, color = styles.get(self.connection, ("○", "#F7768E"))
        # Healthy is just the dot; only a problem earns words.
        label = "" if self.connection == "live" else f" {self.connection}"
        self._right.update(Text.assemble((glyph, color), (label, "dim")))
        # No top bar in normal use; it only appears to flag a lost connection.
        self.display = self.connection in ("offline", "reconnecting")


class StatusLine(Horizontal):
    def __init__(self) -> None:
        super().__init__(id="status")
        self._left = Static(id="status-left")
        self._right = Static(id="status-right")
        self._left_key: tuple | None = None
        self._right_key: tuple | None = None

    def compose(self) -> ComposeResult:
        yield self._left
        yield self._right

    def show(self, activity: Text | None, hints: Text) -> None:
        # Idle tips live in the input placeholder; this line only appears while working.
        # Called at 12 Hz: repaint only what changed, and never relayout for the
        # fixed-width left side (a layout pass walks the whole transcript).
        busy = activity is not None
        if self.display != busy:
            self.display = busy
            self.set_class(busy, "-busy")
        left = activity or Text("")
        left_key = text_key(left)
        if left_key != self._left_key:
            self._left_key = left_key
            self._left.update(left, layout=False)
        right_key = text_key(hints)
        if right_key != self._right_key:
            self._right_key = right_key
            self._right.update(hints)  # width: auto, so this one may resize


# --------------------------------------------------------------------------- app


class TroublemakerApp(App[None]):
    CSS_PATH = Path(__file__).with_name("app.tcss")
    TITLE = "Troublemaker"
    ENABLE_COMMAND_PALETTE = True
    BINDINGS = [
        Binding("ctrl+c", "interrupt", "Stop / quit", priority=True, show=False),
        Binding("escape", "stop", "Stop", show=False),
        Binding("ctrl+d", "quit_if_empty", "Quit", show=False),
        Binding("ctrl+t", "focus_tools", "Tools", show=False),
        Binding("ctrl+e", "toggle_all_tools", "Expand tools", show=False),
        Binding("pageup", "scroll_page(-1)", show=False),
        Binding("pagedown", "scroll_page(1)", show=False),
    ]

    def __init__(self, profile: Profile, client: AgentClient | None = None) -> None:
        super().__init__()
        self.profile = profile
        self.client = client or AgentClient(profile)
        self.transcript = Transcript(profile.channel_id, show_thinking=profile.presentation == "pi-thinking")
        self.transcript.subscribe(self._on_item)
        self._widgets: dict[str, Widget] = {}
        self._dirty: set[str] = set()
        self._pending_mounts: list[Widget] = []
        self._status_dirty = False
        self._flush_scheduled = False
        self.sending = False
        self.stopping = False
        self._local_status: str | None = None
        self._run_status: RunStatus | None = None
        self._activity_key: str | None = None
        self._activity_since = time.monotonic()
        self._live_worker: Worker | None = None
        self._send_worker: Worker | None = None
        self._last_error: str | None = None
        self.header_bar = HeaderBar(profile)
        self._command_matches: list[Command] = []
        self._command_index = 0

    # ------------------------------------------------------------------ layout

    def compose(self) -> ComposeResult:
        yield self.header_bar
        yield VerticalScroll(id="transcript")
        yield Static(id="suggest")
        yield StatusLine()
        yield Composer(id="composer", placeholder=idle_placeholder(self.profile.name))

    async def on_mount(self) -> None:
        self.register_theme(THEME)
        self.theme = "troublemaker"
        self.title = f"{self.profile.name} · Troublemaker"
        self.query_one("#transcript", VerticalScroll).anchor()
        self.query_one("#suggest").display = False
        self.query_one(Composer).focus()
        self.set_interval(1 / 12, self._tick)
        self._render_status()
        self._connect()

    def get_system_commands(self, screen: Screen):
        yield from super().get_system_commands(screen)
        yield SystemCommand("Expand all tool calls", "Show detail for every tool call", lambda: self._set_all_tools(True))
        yield SystemCommand("Collapse all tool calls", "Hide tool detail", lambda: self._set_all_tools(False))
        yield SystemCommand("Toggle thinking", "Stream the model's reasoning live", self._toggle_thinking)
        yield SystemCommand("Reload awareness", "Repaint recent history", self._reload)
        yield SystemCommand("Stop turn", "Stop the active turn", self.action_stop)

    # ------------------------------------------------------------------ model → widgets

    def _on_item(self, op: str, item: Item | None) -> None:
        if op == "clear":
            self._widgets.clear()
            self._dirty.clear()
            self._pending_mounts.clear()
            self.query_one("#transcript", VerticalScroll).remove_children()
            return
        assert item is not None
        if op == "add":
            # Mounts are batched per frame: a history load becomes one mount and
            # one layout pass instead of one per item.
            widget = widget_for(item)
            self._widgets[item.key] = widget
            self._pending_mounts.append(widget)
        elif op == "update":
            self._dirty.add(item.key)
        self._status_dirty = True
        self._schedule_flush()

    def _schedule_flush(self) -> None:
        if not self._flush_scheduled:
            self._flush_scheduled = True
            self.set_timer(FRAME, self._flush_updates)

    def _flush_updates(self) -> None:
        # Not ``_flush``: that name belongs to App (print capture) and must not be shadowed.
        self._flush_scheduled = False
        dirty, self._dirty = self._dirty, set()
        mounts, self._pending_mounts = self._pending_mounts, []
        with self.batch_update():
            if mounts:
                self.query_one("#transcript", VerticalScroll).mount_all(mounts)
                self._prune_mounted()
            for key in dirty:
                widget = self._widgets.get(key)
                if widget is not None and widget.is_mounted:
                    widget.sync()  # type: ignore[attr-defined]
            if self._status_dirty:
                self._status_dirty = False
                self._render_status()

    def _prune_mounted(self) -> None:
        excess = len(self._widgets) - MAX_MOUNTED
        if excess <= 0:
            return
        stale = []
        for key in list(self._widgets)[:excess]:
            widget = self._widgets.pop(key)
            if widget.is_mounted or widget in self.query_one("#transcript").children:
                stale.append(widget)
        if stale:
            self.query_one("#transcript", VerticalScroll).remove_children(stale)

    def _tick(self) -> None:
        for widget in self._widgets.values():
            if isinstance(widget, AssistantMessage) and widget.item.streaming:
                widget.tick()
            elif isinstance(widget, Transition) and widget.item.state == "preparing":
                widget.refresh()
        self._render_status()

    # ------------------------------------------------------------------ status line

    def _activity(self) -> str | None:
        status = self._run_status
        if self.stopping:
            return "Stopping"
        if status and status.phase == "compacting":
            return "Stopping stalled compaction" if status.compaction_abort_requested else "Compacting context"
        live = self.transcript.activity()
        if live:
            # A pending tool already shows its own label and timer on its row.
            return live if live in ("Thinking", "Writing") else "Working"
        if self.sending:
            return self._local_status or "Thinking"
        if status and not status.idle:
            return "Working"
        return None

    def _render_status(self) -> None:
        try:
            line = self.query_one(StatusLine)
        except Exception:
            return
        activity = self._activity()
        if activity != self._activity_key:
            if activity is None or self._activity_key is None:
                self._activity_since = time.monotonic()
            self._activity_key = activity
        hints = Text(no_wrap=True, overflow="ellipsis", style="dim")
        busy_text: Text | None = None
        if activity:
            status = self._run_status
            elapsed = (status.phase_elapsed_ms / 1000) if status and status.phase == "compacting" else time.monotonic() - self._activity_since
            busy_text = Text(no_wrap=True, overflow="ellipsis")
            busy_text.append(f"{spinner_frame()} ", style="bold #FF9E64")
            busy_text.append(activity)
            busy_text.append(f"  {format_duration(elapsed) if elapsed >= 1 else ''}", style="dim")
            if status and status.queued:
                busy_text.append(f" · {status.queued} queued", style="dim")
            hints.append("esc stop · type to steer")
        line.show(busy_text, hints)
        composer = self.query_one(Composer)
        steering = activity is not None and (self.sending or self.transcript.activity() is not None)
        composer.set_class(steering, "-steering")
        placeholder = f"Steer {self.agent_name}…" if steering else idle_placeholder(self.agent_name)
        if composer.placeholder != placeholder:
            composer.placeholder = placeholder

    @property
    def agent_name(self) -> str:
        return self.header_bar.status.agent_name if self.header_bar.status else self.profile.name

    # ------------------------------------------------------------------ connection

    @work(exclusive=True, group="connect")
    async def _connect(self) -> None:
        try:
            self.header_bar.status = await self.client.status()
            self.header_bar.sync()
            self.title = f"{self.header_bar.status.agent_name} · Troublemaker"
            self._render_status()
        except Exception as error:  # noqa: BLE001
            self.header_bar.connection = "offline"
            self.header_bar.sync()
            self.transcript.error(f"Could not reach {self.profile.base_url}: {error}")
        try:
            self.transcript.load_history(await self.client.backlog(HISTORY_LIMIT))
        except Exception as error:  # noqa: BLE001
            self.transcript.error(f"Could not load history: {error}")
        self._live_worker = self._live_loop()
        self._status_loop()

    @work(exclusive=True, group="live")
    async def _live_loop(self) -> None:
        delay = 0.5
        while True:
            try:
                async for event in self.client.live(self.transcript.sequence):
                    if event is None:
                        self._set_connection("live")
                        delay = 0.5
                        self._catch_up()
                        continue
                    if self.transcript.apply_live(event):
                        self._catch_up()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                pass
            self._set_connection("reconnecting")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5.0)

    @work(exclusive=True, group="status")
    async def _status_loop(self) -> None:
        while True:
            try:
                self._run_status = await self.client.run_status()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                self._run_status = None
            self._render_status()
            await asyncio.sleep(STATUS_POLL)

    @work(group="catch-up")
    async def _catch_up(self) -> None:
        try:
            for line in await self.client.backlog(HISTORY_LIMIT):
                self.transcript.apply_awareness_line(line)
        except Exception:  # noqa: BLE001
            pass  # The live stream stays authoritative; catch-up only closes races.

    def _set_connection(self, state: str) -> None:
        if self.header_bar.connection != state:
            self.header_bar.connection = state
            self.header_bar.sync()

    # ------------------------------------------------------------------ input

    def complete_command(self, text: str) -> str | None:
        if not text.startswith("/") or " " in text or "\n" in text:
            return None
        matches = [c.name for c in COMMANDS if c.name.startswith(text[1:].lower())]
        return f"/{matches[0]} " if matches else None

    @property
    def command_menu_open(self) -> bool:
        return bool(self._command_matches) and self.query_one("#suggest").display

    def selected_command(self) -> str:
        return self._command_matches[self._command_index].name

    def move_command(self, step: int) -> None:
        self._command_index = (self._command_index + step) % len(self._command_matches)
        self._render_commands()

    @on(TextArea.Changed, "#composer")
    def _suggest(self, event: TextArea.Changed) -> None:
        text = event.text_area.text
        if not text.startswith("/") or " " in text or "\n" in text:
            self._command_matches = []
        else:
            self._command_matches = [c for c in COMMANDS if c.name.startswith(text[1:].lower())]
        self._command_index = 0
        self._render_commands()

    def _render_commands(self) -> None:
        suggest = self.query_one("#suggest", Static)
        matches = self._command_matches
        if not matches:
            suggest.display = False
            return
        window = 6
        start = min(max(0, self._command_index - window + 1), max(0, len(matches) - window))
        rendered = Text(no_wrap=True, overflow="ellipsis")
        for offset, command in enumerate(matches[start:start + window]):
            selected = start + offset == self._command_index
            if offset:
                rendered.append("\n")
            row = Text(no_wrap=True, overflow="ellipsis")
            row.append("› " if selected else "  ", style="bold #FF9E64")
            row.append(f"/{command.name}", style="bold #FF9E64" if selected else "bold")
            row.append(f"  {command.description}", style="" if selected else "dim")
            if not command.local:
                row.append("  agent", style="dim italic")
            if selected:
                row.stylize("on #2A2D3E")
                row.pad_right(200)
            rendered.append_text(row)
        suggest.update(rendered)
        suggest.display = True

    @on(Composer.Submitted)
    async def _submitted(self, event: Composer.Submitted) -> None:
        text = event.text
        self.query_one("#suggest").display = False
        if text.startswith("/") and await self._local_command(text):
            return
        self.transcript.submit_local(text)
        self.query_one("#transcript", VerticalScroll).anchor()
        steering = self.sending
        if not steering:
            self.sending = True
            self._local_status = None
            self.transcript.begin_local_turn()
        worker = self._send(text, steering)
        if not steering:
            self._send_worker = worker
        self._render_status()

    @work(group="send")
    async def _send(self, text: str, steering: bool) -> None:
        try:
            async for event in self.client.send(text):
                kind = event.get("type")
                if kind == "status":
                    status = event.get("status")
                    if isinstance(event.get("contextTransition"), dict):
                        self.transcript.apply_transition(event["contextTransition"])
                    elif status == "steering":
                        self._local_status = "Steering"
                    elif status not in ("accepted", None) and not steering:
                        self._local_status = str(event.get("message") or "Working").rstrip(". …")
                elif kind == "error":
                    self.transcript.error(str(event.get("message") or "Unknown error"))
                self._render_status()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            if not self.stopping:
                self.transcript.error(str(error))
        finally:
            if not steering:
                self.sending = False
                self._send_worker = None
                self._local_status = None
                self.transcript.end_local_turn()
            self._render_status()

    async def _local_command(self, text: str) -> bool:
        command = text.split()[0][1:].lower()
        if command not in LOCAL:
            return False
        if command in ("quit", "exit"):
            await self.action_quit_app()
        elif command == "help":
            self.transcript.notice(HELP)
        elif command == "stop":
            self.action_stop()
        elif command == "tools":
            self._set_all_tools(True)
        elif command == "collapse":
            self._set_all_tools(False)
        elif command == "thinking":
            self._toggle_thinking()
        elif command == "reload":
            self._reload()
        elif command == "status":
            self._refresh_status()
        return True

    @work(group="status-refresh")
    async def _refresh_status(self) -> None:
        try:
            status = await self.client.status()
            self.header_bar.status = status
            self.header_bar.sync()
            self.transcript.notice(f"{status.agent_name} is connected · {status.runtime} · {status.mode}", "success")
        except Exception as error:  # noqa: BLE001
            self.transcript.error(str(error))

    @work(group="reload", exclusive=True)
    async def _reload(self) -> None:
        try:
            lines = await self.client.backlog(HISTORY_LIMIT)
        except Exception as error:  # noqa: BLE001
            self.transcript.error(str(error))
            return
        self.transcript.clear()
        self.transcript.load_history(lines)
        self.query_one("#transcript", VerticalScroll).anchor()

    def _toggle_thinking(self) -> None:
        thinking = self.profile.presentation != "pi-thinking"
        self.profile = self.profile.with_presentation("pi-thinking" if thinking else "pi")
        self.client.profile = self.profile
        self.transcript.show_thinking = thinking
        self.header_bar.profile = self.profile
        self.header_bar.sync()
        self.transcript.notice("Thinking will stream live." if thinking else "Thinking hidden.")
        self._live_worker = self._live_loop()  # exclusive: replaces the running stream

    # ------------------------------------------------------------------ tools

    def _tool_rows(self) -> list[ToolRow]:
        return [row for row in self.query(ToolRow) if row.display and row.parent and row.parent.display]

    def _set_all_tools(self, expanded: bool) -> None:
        for row in self.query(ToolRow):
            row.set_expanded(expanded)

    def action_toggle_all_tools(self) -> None:
        rows = list(self.query(ToolRow))
        self._set_all_tools(not any(row.expanded for row in rows))

    def action_focus_tools(self) -> None:
        rows = self._tool_rows()
        if not rows:
            self.notify("No tool calls yet.", timeout=2)
            return
        if isinstance(self.focused, ToolRow):
            self.query_one(Composer).focus()
            return
        self.query_one("#transcript", VerticalScroll).release_anchor()
        rows[-1].focus()

    @on(ToolRow.Move)
    def _move_tool(self, event: ToolRow.Move) -> None:
        rows = self._tool_rows()
        if event.row in rows:
            index = max(0, min(len(rows) - 1, rows.index(event.row) + event.step))
            rows[index].focus()

    @on(ToolRow.Leave)
    def _leave_tools(self) -> None:
        self.query_one(Composer).focus()
        self.query_one("#transcript", VerticalScroll).anchor()

    # ------------------------------------------------------------------ actions

    def on_click(self, event: events.Click) -> None:
        """Clicking anywhere puts the cursor back in the input."""
        composer = self.query_one(Composer)
        if self.screen is self.screen_stack[0] and not composer.has_focus:
            composer.focus(scroll_visible=False)

    def action_scroll_page(self, direction: int) -> None:
        transcript = self.query_one("#transcript", VerticalScroll)
        if direction < 0:
            transcript.release_anchor()
            transcript.scroll_page_up()
        else:
            transcript.scroll_page_down()

    def action_stop(self) -> None:
        if isinstance(self.focused, ToolRow):
            self._leave_tools()
            return
        if self.query_one("#suggest").display:
            self.query_one("#suggest").display = False
            return
        if not (self.sending or self.transcript.activity()):
            return
        self._stop()

    @work(group="stop", exclusive=True)
    async def _stop(self) -> None:
        if self.stopping:
            return
        self.stopping = True
        self._render_status()
        try:
            await self.client.stop()
            if self._send_worker is not None:
                self._send_worker.cancel()
            self.transcript.notice("Stopped.", "warning")
        except Exception as error:  # noqa: BLE001
            self.transcript.error(str(error))
        finally:
            self.stopping = False
            self._render_status()

    def action_interrupt(self) -> None:
        if self.sending or self.transcript.activity():
            if self.stopping:
                self.exit()
            else:
                self._stop()
            return
        composer = self.query_one(Composer)
        if composer.text:
            composer.clear()
            return
        self.exit()

    def action_quit_if_empty(self) -> None:
        if not self.query_one(Composer).text:
            self.exit()

    async def action_quit_app(self) -> None:
        self.exit()

    async def on_unmount(self) -> None:
        if self.sending and not self.stopping:
            # Leaving mid-turn stops it, as the TypeScript terminal does.
            try:
                await asyncio.wait_for(self.client.stop(), timeout=3)
            except Exception:  # noqa: BLE001
                pass
        await self.client.aclose()


__all__ = ["TroublemakerApp", "AssistantItem"]
