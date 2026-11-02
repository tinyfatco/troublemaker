from troublemaker_tui.protocol import (
    UserInput,
    content_delta,
    is_covered_by_snapshot,
    normalize_channel,
    parse_context_line,
    parse_visible_inputs,
    tool_label,
)

from .fixtures import assistant_line, envelope, result, text, tool, user_line


def test_envelope_strips_model_context():
    assert parse_visible_inputs(envelope("hello there")) == [UserInput("terminal:casey", "user", "hello there")]


def test_interrupt_batch_splits_into_inputs():
    batch = "Recent messages:\n[t1] [slack:#general] [casey]: one\n[t2] [slack:#general] [operator]: two"
    inputs = parse_visible_inputs(envelope(batch, "slack:#general"))
    assert [(i.user, i.text) for i in inputs] == [("casey", "one"), ("operator", "two")]


def test_single_recent_messages_phrase_is_user_prose():
    prose = "Recent messages:\n[t1] [a] [b]: only one"
    assert len(parse_visible_inputs(envelope(prose))) == 1


def test_heartbeat_is_compacted():
    wake = "[ATTENTION:heartbeat:periodic:30m] Check the checklist."
    [value] = parse_visible_inputs(envelope(wake, "heartbeat", "heartbeat"))
    assert value.text == "Heartbeat" and value.is_compact_generated


def test_ambient_shows_only_posted_messages():
    ambient = "[AMBIENT] A conversation is happening in #general.\n<ambient_messages>\nCasey (U0001): hi <@U0002|op>\n</ambient_messages>\nDecide whether to reply."
    entry = parse_context_line(user_line(ambient, "slack:#general"))
    assert entry and entry.is_ambient
    assert entry.inputs[0].text == "Casey: hi @op"
    assert entry.inputs[0].channel == "slack:#general"


def test_channel_normalization():
    assert normalize_channel("C0123ABC") == "slack:#C0123ABC"
    assert normalize_channel("-100123") == "telegram:-100123"
    assert normalize_channel("email-xyz") == "email"


def test_content_delta_after_steer():
    base = [text("Working on it"), tool("t1"), result("t1")]
    current = [text("Working on it. Done."), tool("t1"), result("t1"), tool("t2")]
    delta = content_delta(current, base, include_thinking=False)
    assert delta == [text(". Done."), tool("t2")]


def test_content_delta_never_repaints_a_tool_from_before_the_boundary():
    base = [tool("t1")]
    current = [tool("t1"), result("t1")]
    assert content_delta(current, base, False) == []


def test_coverage():
    snapshot = [text("hello"), tool("t1"), text("bye")]
    assert is_covered_by_snapshot([text("hello"), tool("t1")], snapshot)
    assert not is_covered_by_snapshot([text("other")], snapshot)


def test_tool_labels():
    assert tool_label(tool("t", "mcp__files__read_file")) == "Read file"
    assert tool_label(tool("t", "bash", "List workspace")) == "List workspace"


def test_assistant_line_parses_tool_calls():
    entry = parse_context_line(assistant_line([text("hi"), tool("t1", "bash", "Run")]))
    assert entry and [b["type"] for b in entry.content] == ["text", "toolCall"]


def test_ambient_card_groups_speakers_and_unescapes():
    from troublemaker_tui.widgets import ambient_messages, speaker_color

    messages = ambient_messages("Casey: ship the \\`skip\\` link\nhttps://example.com/preview\nOperator: Thursday")
    assert messages == [("Casey", "ship the `skip` link\nhttps://example.com/preview"), ("Operator", "Thursday")]
    assert speaker_color("Casey") == speaker_color(" casey ")
