"""Reconciliation scenarios: every input and reply appears exactly once, in order."""

from troublemaker_tui.transcript import AssistantItem, NoticeItem, Transcript, TransitionItem, UserItem

from .fixtures import CHANNEL, Live, assistant_line, result, text, tool, user_line


def visible(transcript: Transcript) -> list[str]:
    rows = []
    for item in transcript.items:
        if isinstance(item, UserItem):
            rows.append(f"user:{item.user}:{item.text}")
        elif isinstance(item, AssistantItem) and not item.is_empty:
            rows.append("assistant:" + "|".join(
                value if kind == "text" else f"tool:{value.label}:{value.state}" if kind == "tool" else f"think:{value}"
                for kind, value in item.parts
            ))
        elif isinstance(item, NoticeItem):
            rows.append(f"{item.tone}:{item.text}")
        elif isinstance(item, TransitionItem):
            rows.append(f"transition:{item.state}")
    return rows


def test_local_turn_paints_once_across_all_sources():
    t, live = Transcript(CHANNEL), Live()
    t.submit_local("hello")
    t.begin_local_turn()
    t.apply_live(live.user_input("r1", "hello"))
    t.apply_live(live.snapshot("r1", [text("Hi"), tool("t1", "bash", "Look around")]))
    t.apply_live(live.snapshot("r1", [text("Hi"), tool("t1", "bash", "Look around"), result("t1"), text("Done.")], streaming=False))
    u = user_line("hello", entry_id="u1")
    t.apply_live(live.awareness(u))
    t.apply_live(live.awareness(assistant_line([text("Hi"), tool("t1", "bash", "Look around"), text("Done.")], parent="u1")))
    t.apply_live(live.complete("r1"))
    t.end_local_turn()
    assert visible(t) == ["user:you:hello", "assistant:Hi|tool:Look around:success|Done."]


def test_snapshot_before_user_input_still_attaches_once():
    t, live = Transcript(CHANNEL), Live()
    t.submit_local("hello")
    t.begin_local_turn()
    t.apply_live(live.snapshot("r1", [text("Hi")]))
    t.apply_live(live.user_input("r1", "hello"))
    t.apply_live(live.snapshot("r1", [text("Hi there")], streaming=False))
    assert visible(t) == ["user:you:hello", "assistant:Hi there"]


def test_steering_splits_output_below_the_new_input():
    t, live = Transcript(CHANNEL), Live()
    t.submit_local("start")
    t.begin_local_turn()
    t.apply_live(live.user_input("r1", "start"))
    t.apply_live(live.snapshot("r1", [text("Step one."), tool("t1", "bash", "Build")]))
    t.submit_local("also do X")
    t.apply_live(live.user_input("r1", "also do X"))
    t.apply_live(live.snapshot("r1", [text("Step one."), tool("t1", "bash", "Build"), result("t1"), text("Doing X.")], streaming=False))
    assert visible(t) == [
        "user:you:start",
        "assistant:Step one.|tool:Build:success",
        "user:you:also do X",
        "assistant:Doing X.",
    ]


def test_external_channel_run_and_awareness_are_deduped():
    t, live = Transcript(CHANNEL), Live()
    slack = "slack:#general"
    t.apply_live(live.user_input("r2", "ping", channel=slack, user="casey"))
    t.apply_live(live.snapshot("r2", [text("pong")], streaming=False, channel=slack))
    t.apply_live(live.complete("r2", channel=slack))
    u = user_line("ping", slack, "casey", entry_id="u9")
    t.apply_live(live.awareness(u))
    t.apply_live(live.awareness(assistant_line([text("pong")], parent="u9")))
    assert visible(t) == ["user:casey:ping", "assistant:pong"]


def test_awareness_assistant_waits_for_active_run_then_dedupes():
    t, live = Transcript(CHANNEL), Live()
    t.apply_live(live.user_input("r1", "q", channel="slack:#a", user="casey"))
    t.apply_live(live.snapshot("r1", [text("answer")], channel="slack:#a"))
    # Durable record lands before the final snapshot: deferred, not double-painted.
    t.apply_live(live.awareness(assistant_line([text("answer")])))
    t.apply_live(live.complete("r1", channel="slack:#a"))
    assert visible(t) == ["user:casey:q", "assistant:answer"]


def test_unrelated_awareness_reply_is_painted_after_run():
    t, live = Transcript(CHANNEL), Live()
    t.apply_live(live.user_input("r1", "q", channel="slack:#a", user="casey"))
    t.apply_live(live.snapshot("r1", [text("answer")], channel="slack:#a"))
    t.apply_live(live.awareness(assistant_line([text("an email reply")])))
    assert visible(t) == ["user:casey:q", "assistant:answer"]
    t.apply_live(live.complete("r1", channel="slack:#a"))
    assert visible(t)[-1] == "assistant:an email reply"


def test_history_then_catch_up_is_idempotent():
    lines = [user_line("old question", entry_id="u1"), assistant_line([text("old answer")], parent="u1", entry_id="a1")]
    t = Transcript(CHANNEL)
    t.load_history(lines)
    for line in lines:
        t.apply_awareness_line(line)
    assert visible(t) == ["user:user:old question", "assistant:old answer"]


def test_stream_restart_requests_catch_up_and_cancels_pending_tools():
    t, live = Transcript(CHANNEL), Live()
    t.apply_live(live.snapshot("r1", [tool("t1", "bash", "Long job")]))
    restarted = Live("stream-0002")
    assert t.apply_live(restarted.awareness(user_line("after restart")))
    assert "tool:Long job:cancelled" in visible(t)[0]


def test_duplicate_and_stale_sequences_are_ignored():
    t, live = Transcript(CHANNEL), Live()
    event = live.user_input("r1", "once", channel="slack:#a", user="casey")
    t.apply_live(event)
    t.apply_live(event)
    assert visible(t) == ["user:casey:once"]


def test_repeated_identical_messages_both_show():
    t, live = Transcript(CHANNEL), Live()
    t.submit_local("yes")
    t.apply_live(live.user_input("r1", "yes"))
    t.apply_live(live.complete("r1"))
    t.submit_local("yes")
    t.apply_live(live.user_input("r2", "yes"))
    assert visible(t) == ["user:you:yes", "user:you:yes"]


def test_context_transition_updates_in_place():
    t = Transcript(CHANNEL)
    t.apply_transition({"id": "x1", "kind": "compaction", "state": "preparing", "revision": 1})
    t.apply_transition({"id": "x1", "kind": "compaction", "state": "completed", "revision": 2, "tokensBefore": 120000, "tokensAfter": 30000})
    t.apply_transition({"id": "x1", "kind": "compaction", "state": "preparing", "revision": 1})
    assert visible(t) == ["transition:completed"]


def test_tool_details_merge_and_activity():
    t, live = Transcript(CHANNEL), Live()
    details = {"toolName": "bash", "invocation": {"text": "ls", "format": "shell", "isTruncated": False}, "artifacts": []}
    t.apply_live(live.snapshot("r1", [tool("t1", "bash", "List files", details)]))
    assert t.activity() == "List files"
    done = {"result": {"text": "a\nb", "format": "text", "isTruncated": False}, "exitStatus": 0, "artifacts": []}
    t.apply_live(live.snapshot("r1", [tool("t1", "bash", "List files", details), result("t1", details=done)], streaming=False))
    [call] = t.tools
    assert call.state == "success" and call.details["invocation"]["text"] == "ls" and call.details["result"]["text"] == "a\nb"
    t.apply_live(live.complete("r1"))
    assert t.activity() is None


def test_thinking_only_when_enabled():
    live = Live()
    hidden, shown = Transcript(CHANNEL), Transcript(CHANNEL, show_thinking=True)
    for t in (hidden, shown):
        t.apply_live(live.snapshot("r1", [{"type": "thinking", "thinking": "hmm"}, text("ok")]))
    assert visible(hidden) == ["assistant:ok"]
    assert visible(shown) == ["assistant:think:hmm|ok"]
