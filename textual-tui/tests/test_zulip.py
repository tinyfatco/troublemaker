from troublemaker_tui.zulip import parse_inbound, render_body, render_inbound

MENTION = "bold #7DCFFF"


def styled(text, needle):
    start = text.plain.index(needle)
    return [str(s.style) for s in text.spans if s.start <= start < s.end]


def test_escaped_mention_and_backticks():
    raw = "[2026-01-01 00:00:00-06:00] [zulip:Example crew] [casey-bot@example.com]: @\\*\\*Operator\\*\\* fyi it says \\`Not logged in\\`, \\_sorry\\_"
    out = render_inbound(raw)
    assert out.plain == "Example crew · casey-bot  @Operator fyi it says `Not logged in`, _sorry_"
    assert MENTION in styled(out, "@Operator")
    assert "dim" in styled(out, "Example crew")


def test_header_parse_keeps_full_info():
    inbound = parse_inbound("[t] [zulip:Example crew] [casey-bot@example.com]: hi")
    assert (inbound.stream, inbound.sender, inbound.stamp, inbound.body) == ("Example crew", "casey-bot@example.com", "t", "hi")
    assert parse_inbound("[zulip:S] [casey]: hi").label == "S · casey"


def test_mention_forms():
    assert render_body("@**Casey** hi").plain == "@Casey hi"
    silent = render_body("cc @_**Casey**")
    assert silent.plain == "cc @Casey"
    assert "italic" in styled(silent, "@Casey")[0]
    assert render_body("@**Casey|123** hi").plain == "@Casey hi"
    assert render_body("see #**general>deploys**").plain == "see #general › deploys"
    assert render_body("a \\* b").plain == "a * b"


def test_fenced_code_untouched():
    body = "@**Casey**\n```\n@**x** \\* y\n```\nafter \\_z\\_"
    assert render_body(body).plain == "@Casey\n```\n@**x** \\* y\n```\nafter _z_"


def test_plain_text_passes_through():
    assert render_inbound("just a normal message with **bold** and a_b") is None
    assert render_body("just a normal message").plain == "just a normal message"
