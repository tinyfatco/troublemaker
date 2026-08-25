import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { RuntimeAssistantSnapshotEntry } from "../src/core/runtime-contract.js";
import {
	formatToolDetails,
	formatToolLabel,
	sanitizeDetail,
	TerminalToolCallRegistry,
	TerminalToolCallStream,
	ToolSelectorSequence,
} from "../src/tui/tool-inspector.js";

const snapshot: RuntimeAssistantSnapshotEntry = {
	id: "assistant-example",
	type: "message",
	timestamp: "2026-01-02T03:04:05Z",
	role: "assistant",
	isStreaming: true,
	content: [
		{
			type: "toolCall",
			id: "tool-example-1",
			name: "read",
			label: "Inspecting files",
			arguments: { path: "/tmp/example.txt", marker: "SYNTHETIC_ARGUMENT" },
		},
		{
			type: "toolOutput",
			toolCallId: "tool-example-1",
			stream: "stdout",
			text: "SYNTHETIC_OUTPUT\n",
			pid: 1234,
		},
		{
			type: "toolCall",
			id: "tool-example-2",
			name: "search",
			label: "Searching 🧭 東京",
			arguments: { query: "example" },
		},
	],
};

const registry = new TerminalToolCallRegistry();
const firstViews = registry.updateSnapshot(snapshot, false);
const first = firstViews.get(0);
const second = firstViews.get(2);
assert(first && second);
assert.equal(first.selector, 1);
assert.equal(second.selector, 2);
assert.equal(first.expanded, false);
assert.match(stripTerminalSequences(formatToolLabel(first)), /^\[1\] ▸ → Inspecting files$/);
assert.doesNotMatch(stripTerminalSequences(formatToolLabel(first)), /SYNTHETIC_ARGUMENT|SYNTHETIC_OUTPUT/);

assert.equal(registry.toggle(2), true);
assert.equal(first.expanded, false, "toggling one selector leaves other calls collapsed");
assert.equal(second.expanded, true, "the selected call expands");
assert.equal(registry.toggle(999), false, "unknown selectors do nothing");

const completedSnapshot: RuntimeAssistantSnapshotEntry = {
	...snapshot,
	isStreaming: false,
	content: [
		...snapshot.content,
		{
			type: "toolResult",
			toolCallId: "tool-example-2",
			result: "SYNTHETIC_RESULT",
			isError: false,
		},
	],
};
const completedViews = registry.updateSnapshot(completedSnapshot, false);
assert.equal(completedViews.get(0), first, "cumulative snapshots retain the mounted tool view");
assert.equal(completedViews.get(2), second, "a stable tool id retains its session selector");
assert.equal(completedViews.get(2)?.expanded, true, "expansion survives cumulative snapshot repaint");
assert.equal(completedViews.get(2)?.state, "success");
assert.match(stripTerminalSequences(formatToolDetails(second)), /SYNTHETIC_RESULT/);

assert.equal(registry.toggle(1), true);
const expandedDetails = stripTerminalSequences(formatToolDetails(first));
assert.match(expandedDetails, /read/);
assert.match(expandedDetails, /SYNTHETIC_ARGUMENT/);
assert.match(expandedDetails, /stdout · pid 1234/);
assert.match(expandedDetails, /SYNTHETIC_OUTPUT/);

registry.updateResults([{
	type: "toolResult",
	toolCallId: "tool-example-1",
	result: "SYNTHETIC_ERROR_RESULT",
	isError: true,
}]);
assert.equal(first.state, "error");
assert.match(stripTerminalSequences(formatToolLabel(first)), /× Inspecting files$/);
assert.match(stripTerminalSequences(formatToolDetails(first)), /error\nSYNTHETIC_ERROR_RESULT/);

const reloadedViews = registry.updateSnapshot(snapshot, true);
assert.equal(reloadedViews.get(0)?.selector, 1, "history reload retains the original selector");
assert.equal(reloadedViews.get(0)?.expanded, true, "history reload retains expansion state");

const terminalInjection = "before\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u001b[31mred\u001b[0m\u0000after";
const sanitized = sanitizeDetail(terminalInjection);
assert.equal(sanitized, "beforelinkredafter", "tool details cannot inject ANSI, OSC, or control bytes");

const stream = new TerminalToolCallStream([first, second]);
first.expanded = false;
second.expanded = false;
const wide = stream.render(120);
assert.equal(wide.length, 1, "consecutive collapsed tool calls share one wide terminal line");
assert.match(stripTerminalSequences(wide[0] || ""), /\[1\].*\[2\]/);

const narrow = stream.render(24);
assert(narrow.length > 1, "the inline tool stream wraps at narrow terminal widths");
assert(narrow.every((line) => visibleWidth(line) <= 24), "wrapped labels respect ANSI and wide-grapheme width");
assert.deepEqual(stream.render(120), wide, "wide rendering is stable after a narrow resize");

second.expanded = true;
const expandedLines = stream.render(32);
assert(expandedLines.every((line) => visibleWidth(line) <= 32), "expanded details respect terminal width");
assert(expandedLines.some((line) => stripTerminalSequences(line).includes("SYNTHETIC_RESULT")));

const selectors: number[] = [];
const sequence = new ToolSelectorSequence((selector) => selectors.push(selector), 10_000);
try {
	assert.equal(sequence.handleInput("\u001b[49;5u"), true, "Ctrl+1 is consumed");
	assert.equal(sequence.handleInput("\u001b[49;5:2u"), true, "Ctrl+1 repeat is consumed but not appended");
	assert.equal(sequence.handleInput("\u001b[49;5:3u"), true, "Ctrl+1 release is consumed but not appended");
	assert.equal(sequence.handleInput("\u001b[50;5u"), true, "Ctrl+2 extends the selector");
	sequence.flush();
	assert.deepEqual(selectors, [12], "a Ctrl+digit burst commits one multi-digit selector");

	assert.equal(sequence.handleInput("\u001b[51;5u"), true);
	assert.equal(sequence.handleInput("x"), false, "ordinary editor input is not consumed");
	assert.deepEqual(selectors, [12, 3], "ordinary input commits a pending selector before reaching the editor");

	assert.equal(sequence.handleInput("\u001b[27;5;49~"), true, "xterm modifyOtherKeys Ctrl+1 is consumed");
	assert.equal(sequence.handleInput("\u001b[27;5;50~"), true, "xterm modifyOtherKeys Ctrl+2 extends the selector");
	sequence.flush();
	assert.deepEqual(selectors, [12, 3, 12], "xterm modifier reporting commits the same selector");
} finally {
	sequence.dispose();
}

const nativeSelectors: number[] = [];
const nativeSequence = new ToolSelectorSequence((selector) => nativeSelectors.push(selector), 10_000, () => true);
try {
	assert.equal(nativeSequence.handleInput("1"), true, "a plain digit is consumed while native Control is held");
	assert.equal(nativeSequence.handleInput("2"), true, "native Control preserves a multi-digit sequence");
	nativeSequence.flush();
	assert.deepEqual(nativeSelectors, [12], "native macOS modifier detection recovers Ctrl+digits from legacy terminals");

	assert.equal(nativeSequence.handleInput("\u001b"), true, "legacy Ctrl+3 is decoded while native Control is held");
	assert.equal(nativeSequence.handleInput("\u001c"), true, "legacy Ctrl+4 is decoded while native Control is held");
	nativeSequence.flush();
	assert.deepEqual(nativeSelectors, [12, 34], "legacy control bytes retain their physical digit identities");
} finally {
	nativeSequence.dispose();
}

const fallbackSelectors: number[] = [];
const fallbackSequence = new ToolSelectorSequence((selector) => fallbackSelectors.push(selector), 10_000, () => false);
try {
	assert.equal(fallbackSequence.handleInput("1"), false, "ordinary digits still reach the composer without Control");
	assert.equal(fallbackSequence.handleInput("\u0014"), true, "Ctrl+T opens terminal-independent selector entry");
	assert.equal(fallbackSequence.handleInput("1"), true);
	assert.equal(fallbackSequence.handleInput("2"), true);
	fallbackSequence.flush();
	assert.deepEqual(fallbackSelectors, [12], "Ctrl+T followed by plain digits selects a tool on legacy terminals");
} finally {
	fallbackSequence.dispose();
}

console.log("troublemaker TUI tool inspector tests passed");
