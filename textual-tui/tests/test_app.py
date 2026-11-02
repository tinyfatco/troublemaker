"""Headless end-to-end runs of the Textual app against a synthetic agent."""

import asyncio
import os

from troublemaker_tui.app import Composer, TroublemakerApp
from troublemaker_tui.client import AgentClient
from troublemaker_tui.config import Profile
from troublemaker_tui.widgets import AssistantMessage, ToolRow, UserMessage

from .fixtures import CHANNEL, FakeAgent, Live, assistant_line, result, text, tool, user_line

PROFILE = Profile(command="casey", name="Casey", base_url="http://agent.example.com", channel_id=CHANNEL)
SHOTS = os.environ.get("TUI_SCREENSHOT_DIR")


def make_app(agent: FakeAgent) -> TroublemakerApp:
    return TroublemakerApp(PROFILE, AgentClient(PROFILE, transport=agent.transport))


async def settle(pilot, times: int = 6) -> None:
    for _ in range(times):
        await asyncio.sleep(0.04)
        await pilot.pause()


def shot(app: TroublemakerApp, name: str) -> None:
    if SHOTS:
        app.save_screenshot(filename=f"{name}.svg", path=SHOTS)


async def test_history_send_stream_and_expand_tools():
    agent = FakeAgent(backlog=[
        user_line("What changed in the build yesterday?", entry_id="u1"),
        assistant_line([text("Two things: the **lockfile** was refreshed and tests now run in parallel.")], parent="u1", entry_id="a1"),
    ])
    agent.release_send.clear()
    app = make_app(agent)
    live = Live()
    async with app.run_test(size=(100, 32)) as pilot:
        await settle(pilot)
        assert [w.item.text for w in app.query(UserMessage)] == ["What changed in the build yesterday?"]

        composer = app.query_one(Composer)
        composer.text = "Run the test suite and summarize failures"
        await pilot.press("enter")
        await settle(pilot)
        assert agent.sent[-1]["message"] == "Run the test suite and summarize failures"
        assert agent.sent[-1]["channelId"] == CHANNEL

        details = {"toolName": "bash", "invocation": {"text": "pnpm test", "format": "shell", "isTruncated": False}, "artifacts": []}
        await agent.push(
            live.user_input("r1", "Run the test suite and summarize failures"),
            live.snapshot("r1", [text("Running the suite now."), tool("t1", "bash", "Run tests", details)]),
        )
        await settle(pilot)
        shot(app, "1-running")
        done = {"result": {"text": "212 passed, 1 failed\nFAIL test/tui.test.ts", "format": "text", "isTruncated": False},
                "exitStatus": 1, "durationMilliseconds": 8400, "artifacts": []}
        final = [
            text("Running the suite now."), tool("t1", "bash", "Run tests", details), result("t1", "x", details=done),
            tool("t2", "read", "Read failing test"), result("t2"),
            text("One failure:\n\n- `test/tui.test.ts` expects the old loader text.\n\nEverything else passes."),
        ]
        await agent.push(live.snapshot("r1", final, streaming=False), live.complete("r1"))
        agent.release_send.set()
        await settle(pilot)

        assert len(app.query(UserMessage)) == 2
        rows = list(app.query(ToolRow))
        assert [row.tool.state for row in rows] == ["success", "success"]

        await pilot.press("ctrl+t")
        await settle(pilot, 2)
        assert app.focused is rows[-1]
        await pilot.press("up", "enter")
        await settle(pilot)
        assert rows[0].expanded and not rows[1].expanded
        shot(app, "2-expanded")

        # Duplicate durable records arriving afterwards change nothing.
        await agent.push(
            live.awareness(user_line("Run the test suite and summarize failures", entry_id="u2")),
            live.awareness(assistant_line(final[:2] + final[3:4] + final[5:], parent="u2")),
        )
        await settle(pilot)
        assert len(app.query(UserMessage)) == 2
        assert len([w for w in app.query(AssistantMessage) if w.display]) == 2


async def test_typing_while_busy_steers_and_escape_stops():
    agent = FakeAgent()
    agent.release_send.clear()
    app = make_app(agent)
    live = Live()
    async with app.run_test(size=(90, 24)) as pilot:
        await settle(pilot)
        app.query_one(Composer).text = "Draft the release notes"
        await pilot.press("enter")
        await agent.push(live.user_input("r1", "Draft the release notes"), live.snapshot("r1", [text("Drafting…")]))
        await settle(pilot)
        assert app.sending
        app.query_one(Composer).text = "keep it short"
        await pilot.press("enter")
        await settle(pilot)
        assert [s["message"] for s in agent.sent] == ["Draft the release notes", "keep it short"]
        shot(app, "3-steering")
        await pilot.press("escape")
        await settle(pilot)
        assert agent.stops == 1
        agent.release_send.set()
        await agent.push(live.complete("r1"))
        await settle(pilot)
        assert not app.sending


async def test_slash_commands_complete_and_run_locally():
    agent = FakeAgent()
    app = make_app(agent)
    async with app.run_test(size=(90, 24)) as pilot:
        await settle(pilot)
        composer = app.query_one(Composer)
        composer.text = "/he"
        await settle(pilot, 2)
        assert app.query_one("#suggest").display
        await pilot.press("tab")
        assert composer.text == "/help "
        await pilot.press("enter")
        await settle(pilot)
        assert agent.sent == []
        composer.text = "/compact"
        await pilot.press("enter")
        await settle(pilot)
        assert agent.sent[-1]["message"] == "/compact"  # agent-side commands go to the agent
        shot(app, "4-help")


async def test_clicking_anywhere_focuses_input_and_still_toggles_tools():
    agent = FakeAgent()
    app = make_app(agent)
    live = Live()
    async with app.run_test(size=(90, 24)) as pilot:
        await settle(pilot)
        await agent.push(live.snapshot("r1", [text("Checking."), tool("t1", "bash", "List files")], streaming=False), live.complete("r1"))
        await settle(pilot)
        row = app.query_one(ToolRow)
        await pilot.press("ctrl+t")
        assert app.focused is row
        await pilot.click("#header")
        await settle(pilot, 2)
        assert isinstance(app.focused, Composer)
        await pilot.click(row)
        await settle(pilot, 2)
        assert row.expanded and isinstance(app.focused, Composer)


async def test_arrow_keys_choose_a_command():
    agent = FakeAgent()
    app = make_app(agent)
    async with app.run_test(size=(90, 24)) as pilot:
        await settle(pilot)
        composer = app.query_one(Composer)
        composer.text = "/c"
        await settle(pilot, 2)
        names = [c.name for c in app._command_matches]
        assert names == ["collapse", "context", "compact", "clear", "cancel"]
        await pilot.press("down", "down")
        assert app.selected_command() == "compact"
        await pilot.press("up")
        assert app.selected_command() == "context"
        await pilot.press("tab")
        assert composer.text == "/context "
        composer.text = "/c"
        await settle(pilot, 2)
        await pilot.press("up", "enter")  # wraps to the last match and runs it
        await settle(pilot)
        assert agent.sent[-1]["message"] == "/cancel"
        assert not app.query_one("#suggest").display
