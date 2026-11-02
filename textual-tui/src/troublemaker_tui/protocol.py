"""Wire-format parsing for the Troublemaker console API.

This is a faithful port of the display rules in ``src/tui/protocol.ts`` and
``src/user-input-display.ts``. Everything here is pure: no I/O, no UI.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

Block = dict[str, Any]
"""One runtime content block (text, thinking, toolCall, toolOutput, toolResult)."""

_MODEL_CONTEXT_BLOCK_RE = re.compile(r"\s*<(session_context|delivery_context)>[\s\S]*?</\1>\s*")
_USER_PREFIX_RE = re.compile(r"^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$")
_FOLLOW_UP_RE = re.compile(
    r"^\[ATTENTION:follow-up-[^\]\n]+:one-shot:[^\]\n]+\]\s+\[FOLLOW_UP\s+(\d+)/(\d+)\s+after\s+(\d+)\s+minutes?"
    r"\s+since the latest completed wake\]"
)
_HEARTBEAT_RE = re.compile(r"^\[ATTENTION:[^\]\r\n]+:(?:immediate|one-shot|periodic):[^\]\r\n]+\]\s+[\s\S]*\S$")
_BATCH_HEADER_RE = re.compile(r"^\[([^\]\n]+)\]\s+\[([^\]\n]+)\]\s+\[([^\]\n]+)\]:[ \t]*", re.MULTILINE)
_SLACK_MENTION_RE = re.compile(r"<@([A-Z0-9]+)(?:\|([^>]+))?>")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])")


@dataclass(frozen=True)
class UserInput:
    channel: str
    user: str
    text: str

    @property
    def is_compact_generated(self) -> bool:
        """Follow-up and heartbeat wakes are painted as a single dim line."""
        if self.channel == "follow-up" and self.user == "follow-up":
            return bool(re.fullmatch(r"Follow-up \d+/\d+ · \d+m", self.text))
        if self.channel in ("heartbeat", "heartbeat:heartbeat") and self.user == "heartbeat":
            return self.text == "Heartbeat"
        return False


@dataclass
class HistoryEntry:
    """One durable awareness record (a line of the agent's context log)."""

    id: str
    role: Literal["user", "assistant", "toolResult"]
    content: list[Block]
    timestamp: str
    parent_id: str | None = None
    model: str | None = None
    stop_reason: str | None = None
    inputs: list[UserInput] = field(default_factory=list)
    is_ambient: bool = False


# --------------------------------------------------------------------------- user input envelopes


def strip_model_context_blocks(text: str) -> str:
    return _MODEL_CONTEXT_BLOCK_RE.sub("\n", text)


def parse_envelope(prompt: str) -> tuple[str, str, str, str] | None:
    """Return ``(timestamp, channel, user, text)`` for a model-visible user prompt."""
    match = _USER_PREFIX_RE.match(strip_model_context_blocks(prompt).strip())
    if not match:
        return None
    return match[1], match[2].strip() or "unknown", match[3].strip() or "user", match[4].lstrip()


def parse_interrupt_batch(text: str) -> list[UserInput]:
    prefix = "Recent messages:\n"
    if not text.startswith(prefix):
        return []
    body = text[len(prefix):]
    matches = list(_BATCH_HEADER_RE.finditer(body))
    # Harness batches always carry at least two messages; a single match is user prose.
    if len(matches) < 2:
        return []
    inputs = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        text_value = body[match.end():end].rstrip()
        if text_value:
            inputs.append(UserInput(match[2].strip() or "unknown", match[3].strip() or "user", text_value))
    return inputs


def _compact_generated(channel: str, user: str, text: str) -> str:
    if channel == "follow-up" and user == "follow-up":
        match = _FOLLOW_UP_RE.match(text)
        return f"Follow-up {match[1]}/{match[2]} · {match[3]}m" if match else text
    if channel in ("heartbeat", "heartbeat:heartbeat") and user == "heartbeat":
        return "Heartbeat" if _HEARTBEAT_RE.match(text) else text
    return text


def parse_visible_inputs(prompt: str) -> list[UserInput]:
    envelope = parse_envelope(prompt)
    if not envelope:
        return []
    _, channel, user, text = envelope
    if text.startswith("[AMBIENT]"):
        return []
    batched = parse_interrupt_batch(text)
    if batched:
        return batched
    if not text:
        return []
    return [UserInput(channel, user, _compact_generated(channel, user, text))]


def normalize_channel(channel: str) -> str:
    value = channel.strip()
    if not value:
        return "unknown"
    if value.startswith(("terminal:", "slack:", "telegram:", "discord:", "email:", "phone:")):
        return value
    if value.startswith("#"):
        return f"slack:{value}"
    if re.fullmatch(r"[CDG][A-Z0-9]+", value):
        return f"slack:#{value}"
    if re.fullmatch(r"-?\d+", value):
        return f"telegram:{value}"
    if value.startswith("email-"):
        return "email"
    if value.startswith("phone-"):
        return "phone"
    return value


def normalize_input(entry: dict[str, Any]) -> UserInput:
    return UserInput(
        normalize_channel(str(entry.get("channel") or "")),
        str(entry.get("userName") or "user"),
        str(entry.get("text") or ""),
    )


# --------------------------------------------------------------------------- ambient awareness


def _ambient_message_block(raw: str) -> str:
    tagged = re.search(r"<ambient_messages>\s*([\s\S]*?)\s*</ambient_messages>", raw)
    if tagged and tagged[1]:
        return tagged[1].strip()
    text = re.sub(r"^\[AMBIENT\]\s*", "", raw).strip()
    for pattern in (
        r"New unseen(?:, complete)? messages since your last ambient wake:\s*\n\n([\s\S]*?)(?:\n\nChannel pulse:|\n\nYou're observing|$)",
        r"Recent messages:\s*\n\n([\s\S]*?)(?:\n\nChannel pulse:|\n\nYou're observing|$)",
    ):
        match = re.search(pattern, text)
        if match and match[1]:
            return match[1].strip()
    return ""


def _clean_ambient_line(line: str) -> str:
    line = re.sub(r"\s+\[Reply target:[^\]]+\]", "", line)
    line = re.sub(r"^([^:\n]+?)\s+\([A-Z0-9._-]+\)(?=:)", r"\1", line)
    return line.strip()


def _slack_users(text: str) -> dict[str, str]:
    users: dict[str, str] = {}
    match = re.search(r"<session_context>([\s\S]*?)</session_context>", text)
    if not match:
        return users
    reading = False
    for raw_line in match[1].split("\n"):
        line = raw_line.strip()
        if line == "Users:":
            reading = True
            continue
        if not reading:
            continue
        if re.fullmatch(r"[A-Za-z][^:]*:", line):
            break
        parts = line.split()
        if len(parts) >= 2 and re.fullmatch(r"U[A-Z0-9]+", parts[0]) and parts[1].startswith("@"):
            users[parts[0]] = parts[1]
    return users


def resolve_slack_mentions(text: str, users: dict[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        if match[1] in users:
            return users[match[1]]
        if match[2] and match[2].strip():
            return "@" + match[2].strip().lstrip("@")
        return match[0]

    return _SLACK_MENTION_RE.sub(replace, text)


def _ambient_input(raw: str, users: dict[str, str], fallback_channel: str | None = None) -> UserInput:
    label = re.match(r"^\[AMBIENT\]\s+A conversation is happening in ([^.\n]+)\.", raw)
    channel = normalize_channel(label[1]) if label else fallback_channel or "awareness"
    lines = [_clean_ambient_line(line) for line in _ambient_message_block(raw).split("\n")]
    text = "\n".join(resolve_slack_mentions(line, users) for line in lines if line)
    return UserInput(channel, "ambient", text)


# --------------------------------------------------------------------------- durable context lines


def _normalize_content(value: Any) -> list[Block]:
    if isinstance(value, str):
        return [{"type": "text", "text": value}]
    if not isinstance(value, list):
        return []
    content: list[Block] = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("type"), str):
            continue
        kind = item["type"]
        if kind == "text":
            content.append({"type": "text", "text": str(item.get("text") or "")})
        elif kind == "thinking":
            content.append({"type": "thinking", "thinking": str(item.get("thinking") or "")})
        elif kind in ("toolCall", "tool_call", "tool_use"):
            args = next((a for a in (item.get("arguments"), item.get("args"), item.get("input")) if isinstance(a, dict)), {})
            label = str(item.get("label") or (args.get("label") if isinstance(args.get("label"), str) else "") or "").strip()
            block: Block = {
                "type": "toolCall",
                "id": str(item.get("id") or item.get("toolCallId") or item.get("tool_call_id") or ""),
                "name": str(item.get("name") or item.get("toolName") or "tool"),
                "arguments": args,
            }
            if label:
                block["label"] = label
            content.append(block)
        elif kind in ("toolResult", "tool_result"):
            result = next((r for r in (item.get("result"), item.get("content"), item.get("output")) if r is not None), "")
            content.append({
                "type": "toolResult",
                "toolCallId": str(item.get("toolCallId") or item.get("tool_call_id") or ""),
                "result": result if isinstance(result, str) else json.dumps(result),
                "isError": bool(item.get("isError", item.get("is_error"))),
            })
    return content


def parse_context_line(line: str) -> HistoryEntry | None:
    try:
        raw = json.loads(line)
    except (ValueError, TypeError):
        return None
    if not isinstance(raw, dict) or raw.get("type") != "message" or not isinstance(raw.get("message"), dict):
        return None
    message = raw["message"]
    role = message.get("role")
    if role not in ("user", "assistant", "toolResult"):
        return None
    content = _normalize_content(message.get("content"))
    timestamp = str(raw.get("timestamp") or "") or datetime.now(timezone.utc).isoformat()
    entry = HistoryEntry(
        id=str(raw.get("id") or f"message-{timestamp}"),
        role=role,
        content=content,
        timestamp=timestamp,
        parent_id=str(raw.get("parentId") or "") or None,
        model=str(message.get("model") or raw.get("model") or "") or None,
        stop_reason=str(message.get("stopReason") or raw.get("stopReason") or "") or None,
    )
    if role != "user":
        return entry
    text_block = next((block for block in content if block["type"] == "text"), None)
    if not text_block:
        return entry
    text = text_block["text"]
    users = _slack_users(text)
    visible = strip_model_context_blocks(text).strip()
    envelope = parse_envelope(text)
    if envelope and envelope[3].startswith("[AMBIENT]"):
        entry.is_ambient = True
        entry.inputs = [_ambient_input(envelope[3], users, normalize_channel(envelope[1]))]
    elif envelope:
        entry.inputs = [
            UserInput(normalize_channel(item.channel), item.user, item.text) for item in parse_visible_inputs(text)
        ]
    elif visible.startswith("[AMBIENT]"):
        # Same-thread ambient context can be steered into an active run without an envelope.
        entry.is_ambient = True
        entry.inputs = [_ambient_input(visible, users)]
    elif visible:
        entry.inputs = [UserInput("awareness", "user", visible)]
    entry.inputs = [item for item in entry.inputs if item.text]
    return entry


# --------------------------------------------------------------------------- assistant snapshots


def content_delta(current: list[Block], baseline: list[Block], include_thinking: bool) -> list[Block]:
    """Project a cumulative snapshot onto content that arrived after ``baseline``.

    A run that is steered mid-flight keeps one cumulative snapshot; each visible
    user input splits it so new output paints below that input.
    """
    base_text = [b for b in baseline if b["type"] == "text"]
    base_thinking = [b for b in baseline if b["type"] == "thinking"] if include_thinking else []
    # A tool call belongs to the segment where it started; its row updates in
    # place when it finishes, so it is never repainted below a later input.
    base_calls = {b.get("id") for b in baseline if b["type"] == "toolCall"}

    def suffix(block: Block, previous: Block | None, key: str) -> Block | None:
        if previous is None:
            return block
        if block[key].startswith(previous[key]):
            rest = block[key][len(previous[key]):]
            return {**block, key: rest} if rest else None
        return block if block[key] != previous[key] else None

    delta: list[Block] = []
    included_calls: set[str] = set()
    text_index = thinking_index = 0
    for block in current:
        kind = block["type"]
        if kind == "thinking":
            if not include_thinking:
                continue
            previous = base_thinking[thinking_index] if thinking_index < len(base_thinking) else None
            thinking_index += 1
            if (projected := suffix(block, previous, "thinking")) is not None:
                delta.append(projected)
        elif kind == "text":
            previous = base_text[text_index] if text_index < len(base_text) else None
            text_index += 1
            if (projected := suffix(block, previous, "text")) is not None:
                delta.append(projected)
        elif kind == "toolCall":
            if block.get("id") not in base_calls:
                delta.append(block)
                included_calls.add(block.get("id"))
        elif kind in ("toolResult", "toolOutput") and block.get("toolCallId") in included_calls:
            delta.append(block)
    return delta


def _visible_tokens(content: list[Block]) -> list[str]:
    tokens = []
    for block in content:
        if block["type"] == "toolCall" and block.get("id"):
            tokens.append(f"tool:{block['id']}")
        elif block["type"] == "text" and block.get("text", "").strip():
            tokens.append(f"text:{block['text'].strip()}")
    return tokens


def is_covered_by_snapshot(durable: list[Block], snapshot: list[Block]) -> bool:
    """True when a durable assistant record was already shown from a live snapshot."""
    if any(b["type"] == "toolCall" and not b.get("id") for b in durable):
        return False
    wanted = _visible_tokens(durable)
    if not wanted:
        return False
    available: dict[str, int] = {}
    for token in _visible_tokens(snapshot):
        available[token] = available.get(token, 0) + 1
    for token in wanted:
        if available.get(token, 0) == 0:
            return False
        available[token] -= 1
    return True


# --------------------------------------------------------------------------- tool presentation


def sanitize(value: str) -> str:
    return _CONTROL_RE.sub("", _ANSI_RE.sub("", value).replace("\r\n", "\n").replace("\r", "\n"))


def one_line(value: str) -> str:
    return " ".join(sanitize(value).split())


def readable_tool_name(name: str) -> str:
    leaf = name.split("__")[-1] or name
    words = " ".join(re.sub(r"[_-]+", " ", leaf).split()) or "Tool"
    return words[0].upper() + words[1:]


def tool_label(block: Block) -> str:
    args = block.get("arguments") if isinstance(block.get("arguments"), dict) else {}
    argument_label = args.get("label").strip() if isinstance(args.get("label"), str) else ""
    explicit = (block.get("label") or "").strip() or argument_label
    name = str(block.get("name") or "tool")
    return one_line(explicit if explicit and explicit != name else readable_tool_name(name)) or "Tool"


def merge_details(current: dict | None, newer: dict | None) -> dict | None:
    if not current:
        return newer
    if not newer:
        return current
    merged = {**current, **{k: v for k, v in newer.items() if v is not None and k != "artifacts"}}
    seen: set[str] = set()
    merged["artifacts"] = []
    for artifact in [*(current.get("artifacts") or []), *(newer.get("artifacts") or [])]:
        if artifact.get("id") not in seen:
            seen.add(artifact.get("id"))
            merged["artifacts"].append(artifact)
    return merged


def is_tool_use_stop(stop_reason: str | None) -> bool:
    return bool(stop_reason) and re.sub(r"[-_\s]", "", stop_reason).lower() == "tooluse"
