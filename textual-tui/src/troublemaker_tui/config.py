"""Reads the agent profiles shared with the TypeScript ``troublemaker-tui``.

Profiles are installed with ``troublemaker-tui install``; this client only
reads them, so both terminals always point at the same agents.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

Presentation = Literal["compact", "pi", "pi-thinking"]


@dataclass(frozen=True)
class Profile:
    command: str
    name: str
    base_url: str
    channel_id: str
    presentation: Presentation = "pi"
    bearer_token_file: str | None = None

    def with_presentation(self, presentation: Presentation) -> Profile:
        return replace(self, presentation=presentation)


def config_path() -> Path:
    return Path(os.environ.get("TROUBLEMAKER_TUI_CONFIG") or Path.home() / ".config" / "troublemaker" / "tui.json")


def title_case(command: str) -> str:
    return " ".join(part[:1].upper() + part[1:] for part in command.split("-") if part)


def normalize_command(value: str) -> str:
    command = value.strip().lower()
    if not re.fullmatch(r"[a-z][a-z0-9-]*", command):
        raise ValueError("Agent command must start with a letter and contain only lowercase letters, numbers, or hyphens")
    return command


def normalize_base_url(value: str) -> str:
    url = urlsplit(value.strip())
    if url.scheme not in ("http", "https") or not url.netloc:
        raise ValueError(f"Invalid agent URL: {value}")
    if url.username or url.password or url.query or url.fragment:
        raise ValueError("Agent URL cannot contain credentials, query parameters, or a fragment")
    return f"{url.scheme}://{url.netloc}{url.path.rstrip('/')}"


def load_profiles(path: Path | None = None) -> dict[str, Profile]:
    path = path or config_path()
    if not path.exists():
        return {}
    try:
        parsed = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"Could not read TUI config {path}: {error}") from error
    if not isinstance(parsed, dict) or parsed.get("version") != 1 or not isinstance(parsed.get("agents"), dict):
        raise ValueError(f"Invalid TUI config: {path}")
    profiles: dict[str, Profile] = {}
    for key, raw in parsed["agents"].items():
        if not isinstance(raw, dict):
            continue
        try:
            command = normalize_command(raw.get("command") if isinstance(raw.get("command"), str) else key)
            token_file = raw.get("bearerTokenFile") if isinstance(raw.get("bearerTokenFile"), str) else None
            # The Textual client always asks for the bounded, redacted Pi detail
            # projection so every tool call can expand. Thinking stays opt-in.
            presentation: Presentation = "pi-thinking" if raw.get("presentation") == "pi-thinking" else "pi"
            profiles[command] = Profile(
                command=command,
                name=(raw.get("name") or "").strip() or title_case(command),
                base_url=normalize_base_url(str(raw.get("baseUrl") or "")),
                channel_id=(raw.get("channelId") or "").strip() or f"terminal:{command}",
                presentation=presentation,
                bearer_token_file=token_file.strip() if token_file and token_file.strip() else None,
            )
        except (ValueError, AttributeError):
            continue  # One stale profile should not make every agent unusable.
    return profiles
