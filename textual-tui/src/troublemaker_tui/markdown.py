"""Markdown as one widget.

Textual's ``Markdown`` mounts a widget per block, and four per list item. Every
layout pass walks all of them, so a long transcript made each streamed frame
(and every idle repaint) cost tens of milliseconds. Here a text part is a
single widget: Rich renders the Markdown once per (text, width), and the
result is kept as plain ``Text`` so it stays selectable like any other line.
"""

from __future__ import annotations

import io
import re

from rich import box
from rich.console import Console, ConsoleOptions, RenderResult
from rich.segment import Segment
from rich.markdown import CodeBlock, Heading, ListItem, Markdown, TableElement
from rich.syntax import Syntax
from rich.table import Table
from rich.text import Text
from rich.theme import Theme
from textual.geometry import Size
from textual.widget import Widget

INSET = "#101118"

THEME = Theme({
    "markdown.paragraph": "",
    "markdown.text": "",
    "markdown.code": "#E0AF68 on #232533",
    "markdown.code_block": f"on {INSET}",
    "markdown.block_quote": "#A9B1D6",
    "markdown.list": "",
    "markdown.item": "",
    "markdown.item.bullet": "bold #9D7CD8",
    "markdown.item.number": "#9D7CD8",
    "markdown.hr": "#3B4261",
    "markdown.h1": "bold underline #9D7CD8",
    "markdown.h2": "underline #9D7CD8",
    "markdown.h3": "bold #9D7CD8",
    "markdown.h4": "bold",
    "markdown.h5": "italic",
    "markdown.h6": "dim",
    "markdown.link": "underline",
    "markdown.link_url": "underline #7AA2F7",
    "markdown.s": "strike",
    "markdown.table.border": "#3B4261",
    "markdown.table.header": "#9D7CD8",
})


class _Heading(Heading):
    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        text = self.text.copy()
        text.justify = "left"  # Rich centers h1 in a box; the transcript reads left to right.
        yield text


class _CodeBlock(CodeBlock):
    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        yield Syntax(str(self.text).rstrip(), self.lexer_name, theme="monokai", word_wrap=True,
                     padding=(1, 2), background_color=INSET)


class _Table(TableElement):
    def __rich_console__(self, console: Console, options: ConsoleOptions) -> RenderResult:
        table = Table(box=box.SQUARE, border_style="markdown.table.border", header_style="markdown.table.header",
                      show_edge=True, show_lines=True, expand=False, padding=(0, 1))
        if self.header is not None and self.header.row is not None:
            for column in self.header.row.cells:
                table.add_column(column.content)
        if self.body is not None:
            for row in self.body.rows:
                table.add_row(*(cell.content for cell in row.cells))
        yield table


class _ListItem(ListItem):
    def render_number(self, console: Console, options: ConsoleOptions, number: int, last_number: int) -> RenderResult:
        # "1." rather than Rich's bare "1", matching how the transcript read before.
        number_width = len(str(last_number)) + 3
        lines = console.render_lines(self.elements, options.update(width=options.max_width - number_width), style=self.style)
        number_style = console.get_style("markdown.item.number", default="none")
        padding = Segment(" " * number_width, number_style)
        numeral = Segment(f"{number}.".rjust(number_width - 1) + " ", number_style)
        for index, line in enumerate(lines):
            yield padding if index else numeral
            yield from line
            yield Segment("\n")


class _Markdown(Markdown):
    elements = {**Markdown.elements, "heading_open": _Heading, "fence": _CodeBlock, "code_block": _CodeBlock,
                "table_open": _Table, "list_item_open": _ListItem}


_console = Console(file=io.StringIO(), width=80, color_system="truecolor", force_terminal=True,
                   theme=THEME, legacy_windows=False, emoji=False, highlight=False)


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_LIST = re.compile(r"^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)")


def _kind(line: str) -> str:
    stripped = line.lstrip()
    if _LIST.match(line):
        return "list"
    if stripped.startswith(">"):
        return "quote"
    if stripped.startswith("|"):
        return "table"
    return "other"


def split_blocks(source: str) -> list[str]:
    """Split Markdown at blank lines between independent top-level blocks.

    Blocks are rendered and cached separately, so a streamed reply re-renders
    only its last block each frame instead of the whole message. Splits never
    fall inside a fence, and never between items of one list, quote, or table
    (a blank line inside a list makes it loose but keeps it one list).
    """
    blocks: list[str] = []
    current: list[str] = []
    kind = "other"
    fence: str | None = None
    blank = False
    for line in source.split("\n"):
        if fence is None and blank and current and line.strip():
            indented = line[:1] in (" ", "\t")
            if not indented and not (_kind(line) == kind != "other"):
                blocks.append("\n".join(current).strip("\n"))
                current = []
        if not current or not "".join(current).strip():
            kind = _kind(line)
        current.append(line)
        match = _FENCE.match(line)
        if match:
            marker = match.group(1)
            if fence is None:
                fence = marker[0] * len(marker)
            elif marker.startswith(fence):
                fence = None
        blank = fence is None and not line.strip()
    if current:
        blocks.append("\n".join(current).strip("\n"))
    return [block for block in blocks if block.strip()]


def _is_blank(line: list) -> bool:
    """Trailing filler Rich adds after a block; a padded code-fence row has a background and stays."""
    return all(not segment.text.strip() and not (segment.style and segment.style.bgcolor) for segment in line)


def render_block(source: str, width: int) -> Text:
    """Render one Markdown block at ``width`` columns into pre-wrapped, selectable Text."""
    width = max(1, width)
    options = _console.options.update(width=width, max_width=width)
    lines = _console.render_lines(_Markdown(source, hyperlinks=True), options, pad=False, new_lines=False)
    while lines and _is_blank(lines[-1]):
        lines.pop()
    start = 0
    while start < len(lines) and _is_blank(lines[start]):
        start += 1  # Rich opens a list or quote with a blank line when it comes first
    lines = lines[start:]
    out = Text(no_wrap=True, overflow="ignore", end="")
    for index, line in enumerate(lines):
        if index:
            out.append("\n")
        for segment in line:
            if segment.control:
                continue
            out.append(segment.text, segment.style)
    return out


def render_markdown(source: str, width: int, cache: dict[tuple[str, int], Text] | None = None) -> Text:
    """Render a whole document block by block, reusing ``cache`` for blocks already rendered."""
    out = Text(no_wrap=True, overflow="ignore", end="")
    used: dict[tuple[str, int], Text] = {}
    for index, block in enumerate(split_blocks(source)):
        key = (block, width)
        rendered = (cache or {}).get(key) or used.get(key) or render_block(block, width)
        used[key] = rendered
        if index:
            out.append("\n\n")  # Rich separates blocks with one blank line
        out.append_text(rendered)
    if cache is not None:
        cache.clear()
        cache.update(used)
    return out


class MarkdownBody(Widget):
    """One assistant text part. ``set_text`` replaces the source; rendering is lazy and cached by width."""

    DEFAULT_CSS = "MarkdownBody { height: auto; }"

    def __init__(self, text: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self._source = text
        self._cache: tuple[str, int, Text] | None = None
        self._blocks: dict[tuple[str, int], Text] = {}

    @property
    def source(self) -> str:
        return self._source

    def set_text(self, text: str) -> None:
        if text != self._source:
            self._source = text
            self.refresh(layout=True)

    def _rendered(self, width: int) -> Text:
        cache = self._cache
        if cache is not None and cache[0] == self._source and cache[1] == width:
            return cache[2]
        text = render_markdown(self._source, width, self._blocks)
        self._cache = (self._source, width, text)
        return text

    def get_content_width(self, container: Size, viewport: Size) -> int:
        return container.width

    def get_content_height(self, container: Size, viewport: Size, width: int) -> int:
        if not self._source.strip():
            return 0
        return len(self._rendered(width).plain.split("\n"))

    def render(self) -> Text:
        if not self._source.strip():
            return Text("")
        return self._rendered(self.content_region.width or self.size.width)
