"""Single-widget Markdown: block splitting, cached rendering, and the perf contracts around it."""

from textual.app import App

from troublemaker_tui.app import TroublemakerApp
from troublemaker_tui.markdown import MarkdownBody, render_block, render_markdown, split_blocks

DOC = """## Build report

Two things changed: the **lockfile** was refreshed and tests run via `pytest -n auto`.

1. First step
2. Second step

- bullet one

- bullet two
  continued

> A quoted line
> and another.

| name | status |
|------|--------|
| unit | pass |

```python
def hello():


    return 1
```

~~~
raw

text
~~~

Done."""


def test_split_keeps_fences_lists_quotes_and_tables_whole():
    blocks = split_blocks(DOC)
    assert blocks[0] == "## Build report"
    assert any(block.startswith("```python") and block.endswith("```") for block in blocks)
    assert any(block.startswith("~~~") and "text" in block for block in blocks)
    assert any(block.startswith("1. First step") and block.endswith("- bullet two\n  continued") for block in blocks)
    assert "> A quoted line\n> and another." in blocks
    assert any(block.startswith("Two things") and block.endswith("auto`.") for block in blocks)
    assert blocks[-1] == "Done."


def test_block_rendering_matches_whole_document():
    for width in (30, 72, 120):
        whole = [line.rstrip() for line in render_block(DOC, width).plain.split("\n")]
        blocks = [line.rstrip() for line in render_markdown(DOC, width).plain.split("\n")]
        assert blocks == whole


def test_ordered_lists_keep_their_dot():
    assert "1. First step" in render_block("1. First step\n2. Second", 40).plain


def test_streaming_reuses_rendered_blocks():
    cache: dict = {}
    render_markdown(DOC, 80, cache)
    first = dict(cache)
    render_markdown(DOC + "\n\nOne more", 80, cache)
    # Every earlier block is reused by identity; only the new tail was rendered.
    assert all(cache[key] is value for key, value in first.items() if key in cache)
    assert len(cache) == len(first) + 1


def test_markdown_body_is_one_selectable_widget():
    body = MarkdownBody(DOC)
    text = body._rendered(60)
    assert "Build report" in text.plain and "def hello" in text.plain
    assert body.get_content_height(None, None, 60) == len(text.plain.split("\n"))  # type: ignore[arg-type]


def test_app_does_not_shadow_textual_internals():
    # App._flush is Textual's print-capture hook; overriding it broke stderr capture.
    assert TroublemakerApp._flush is App._flush
