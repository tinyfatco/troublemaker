"""Zulip inbound cleanup: turn forwarded Zulip markup into readable, styled chat text.

Forwarded Zulip messages arrive as ``[stamp] [zulip:Stream] [sender@host]: body`` with
the body in Zulip markdown, often backslash-escaped (``@\\*\\*Name\\*\\*``). This module
parses that header into a compact source label and renders mentions, stream links and
escapes as plain styled text. Fenced code blocks are left untouched.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from rich.text import Text

MENTION_STYLE = "bold #7DCFFF"
STREAM_STYLE = "bold #BB9AF7"
LABEL_STYLE = "dim"

_HEADER_RE = re.compile(
    r"^(?:\[(?P<stamp>[^\]\n]*)\]\s*)?\[zulip:(?P<stream>[^\]\n]*)\]\s*\[(?P<sender>[^\]\n]*)\]:[ \t]*",
)
_ESCAPE_RE = re.compile(r"\\([*_`])")
# @**Name**, @_**Name**, @**Name|123**, #**stream>topic**
_TOKEN_RE = re.compile(r"(?P<kind>@_?|#)\*\*(?P<name>[^*\n|]+?)(?:\|\d+)?\*\*")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")


@dataclass(frozen=True)
class ZulipInbound:
    stream: str
    sender: str
    stamp: str | None
    body: str

    @property
    def sender_name(self) -> str:
        return self.sender.split("@", 1)[0] if "@" in self.sender else self.sender

    @property
    def label(self) -> str:
        return f"{self.stream} · {self.sender_name}"


def parse_inbound(text: str) -> ZulipInbound | None:
    """Split a forwarded Zulip line into header parts and body, or ``None`` if it isn't one."""
    match = _HEADER_RE.match(text)
    if not match:
        return None
    return ZulipInbound(match["stream"].strip(), match["sender"].strip(), match["stamp"], text[match.end():])


def has_zulip_markup(text: str) -> bool:
    return bool(_ESCAPE_RE.search(text) or _TOKEN_RE.search(text))


def _render_line(line: str, out: Text, style: str) -> None:
    line = _ESCAPE_RE.sub(r"\1", line)
    pos = 0
    for match in _TOKEN_RE.finditer(line):
        out.append(line[pos:match.start()], style=style)
        name = match["name"].strip()
        if match["kind"] == "#":
            out.append("#" + name.replace(">", " › "), style=STREAM_STYLE)
        elif match["kind"] == "@_":
            out.append("@" + name, style=f"{MENTION_STYLE} italic")
        else:
            out.append("@" + name, style=MENTION_STYLE)
        pos = match.end()
    out.append(line[pos:], style=style)


def render_body(body: str, style: str = "") -> Text:
    """Render a Zulip body: unescape markdown escapes and style mentions, skipping fenced code."""
    out = Text()
    in_fence = False
    lines = body.split("\n")
    for index, line in enumerate(lines):
        if index:
            out.append("\n")
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            out.append(line, style=style)
        elif in_fence:
            out.append(line, style=style)
        else:
            _render_line(line, out, style)
    return out


def render_inbound(text: str, style: str = "") -> Text | None:
    """Full renderable for a Zulip-looking message, or ``None`` to fall back to plain text."""
    inbound = parse_inbound(text)
    if inbound is not None:
        out = Text()
        out.append(inbound.label, style=LABEL_STYLE)
        out.append("  ")
        out.append_text(render_body(inbound.body, style))
        return out
    if has_zulip_markup(text):
        return render_body(text, style)
    return None
