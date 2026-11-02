"""``troublemaker-textual`` command line."""

from __future__ import annotations

import argparse
import sys

from .config import Profile, load_profiles, normalize_base_url, title_case


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="troublemaker-textual",
        description="Textual terminal client for a Troublemaker agent. "
        "Uses the profiles installed with `troublemaker-tui install`.",
    )
    parser.add_argument("agent", nargs="?", help="installed agent command, or `list`")
    parser.add_argument("--url", help="connect to an agent URL without an installed profile")
    parser.add_argument("--name", help="display name when using --url")
    parser.add_argument("--channel", help="terminal channel id (default terminal:<agent>)")
    parser.add_argument("--token-file", help="absolute path to a protected bearer token file")
    parser.add_argument("--thinking", action="store_true", help="stream model thinking live")
    args = parser.parse_args(argv)

    try:
        profiles = load_profiles()
    except ValueError as error:
        print(f"troublemaker-textual: {error}", file=sys.stderr)
        return 1

    if args.agent == "list":
        if not profiles:
            print("No agent commands installed. Run: troublemaker-tui install <agent> --url <agent-url>")
        for profile in sorted(profiles.values(), key=lambda p: p.command):
            print(f"{profile.command}\t{profile.name}\t{profile.base_url}")
        return 0

    try:
        profile = _resolve(args, profiles)
    except ValueError as error:
        print(f"troublemaker-textual: {error}", file=sys.stderr)
        return 1
    if args.channel:
        profile = Profile(**{**profile.__dict__, "channel_id": args.channel})
    if args.thinking:
        profile = profile.with_presentation("pi-thinking")
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("troublemaker-textual: requires an interactive terminal", file=sys.stderr)
        return 1

    from .app import TroublemakerApp  # Import Textual only once we know we'll run.

    TroublemakerApp(profile).run()
    return 0


def _resolve(args: argparse.Namespace, profiles: dict[str, Profile]) -> Profile:
    if args.url:
        command = (args.agent or "agent").lower()
        return Profile(
            command=command,
            name=args.name or title_case(command),
            base_url=normalize_base_url(args.url),
            channel_id=f"terminal:{command}",
            bearer_token_file=args.token_file,
        )
    if args.agent:
        profile = profiles.get(args.agent.lower())
        if not profile:
            installed = ", ".join(sorted(profiles)) or "none"
            raise ValueError(f'No profile for "{args.agent}" (installed: {installed}). Use --url or troublemaker-tui install.')
        return profile
    if len(profiles) == 1:
        return next(iter(profiles.values()))
    raise ValueError("Choose an agent: " + (", ".join(sorted(profiles)) or "none installed; use --url"))


if __name__ == "__main__":
    raise SystemExit(main())
