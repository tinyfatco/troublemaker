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
			arguments: { unsafe: "RAW_ARGUMENT_MUST_NOT_RENDER" },
			displayDetails: {
				toolName: "read",
				invocation: { text: '{\n  "path": "/tmp/example.txt"\n}', format: "json", language: "json", isTruncated: false },
				artifacts: [],
			},
		},
		{
			type: "toolOutput",
			toolCallId: "tool-example-1",
			stream: "stdout",
			text: "RAW_OUTPUT_MUST_NOT_RENDER",
			pid: 1234,
			displayDetails: {
				result: { text: "VISIBLE_OUTPUT\n", format: "text", isTruncated: false },
				artifacts: [],
			},
		},
		{
			type: "toolCall",
			id: "tool-example-2",
			name: "search",
			label: "Searching 🧭 東京",
			arguments: {},
			displayDetails: {
				toolName: "search",
				invocation: { text: '{\n  "query": "example"\n}', format: "json", language: "json", isTruncated: false },
				artifacts: [],
			},
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
assert.doesNotMatch(stripTerminalSequences(formatToolLabel(first)), /RAW_ARGUMENT|RAW_OUTPUT|VISIBLE_OUTPUT/);

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
			result: "RAW_RESULT_MUST_NOT_RENDER",
			isError: false,
			displayDetails: {
				result: { text: "VISIBLE_RESULT", format: "text", isTruncated: false },
				artifacts: [],
			},
		},
	],
};
const completedViews = registry.updateSnapshot(completedSnapshot, false);
assert.equal(completedViews.get(0), first, "cumulative snapshots retain the mounted tool view");
assert.equal(completedViews.get(2), second, "a stable tool id retains its session selector");
assert.equal(completedViews.get(2)?.expanded, true, "expansion survives cumulative snapshot repaint");
assert.equal(completedViews.get(2)?.state, "success");
assert.equal(completedViews.get(0)?.state, "unknown", "a final snapshot without a matching result never implies success");
assert.match(stripTerminalSequences(formatToolLabel(first)), /^\[1\] ▸ \? Inspecting files$/, "final no-result state is visibly unknown");
assert.match(stripTerminalSequences(formatToolDetails(second)), /VISIBLE_RESULT/);
assert.doesNotMatch(stripTerminalSequences(formatToolDetails(second)), /RAW_RESULT_MUST_NOT_RENDER/);

assert.equal(registry.toggle(1), true);
const expandedDetails = stripTerminalSequences(formatToolDetails(first));
assert.match(expandedDetails, /read/);
assert.match(expandedDetails, /example.txt/);
assert.match(expandedDetails, /stdout · pid 1234/);
assert.match(expandedDetails, /VISIBLE_OUTPUT/);
assert.doesNotMatch(expandedDetails, /RAW_ARGUMENT_MUST_NOT_RENDER|RAW_OUTPUT_MUST_NOT_RENDER/);

const interruptedRegistry = new TerminalToolCallRegistry();
const interruptedStart: RuntimeAssistantSnapshotEntry = {
	id: "assistant-interrupted",
	type: "message",
	timestamp: "2026-01-02T03:04:06Z",
	role: "assistant",
	isStreaming: true,
	content: [{ type: "toolCall", id: "tool-interrupted", name: "read", label: "Interrupted operation", arguments: {} }],
};
const interruptedView = interruptedRegistry.updateSnapshot(interruptedStart, false).get(0);
assert.equal(interruptedView?.state, "pending");
const interruptedFinal = interruptedRegistry.updateSnapshot({ ...interruptedStart, isStreaming: false }, false).get(0);
assert.equal(interruptedFinal, interruptedView, "interrupted final snapshots retain the same mounted tool view");
assert.equal(interruptedFinal?.state, "unknown", "an interrupted final snapshot without an abort reason stays explicitly unknown");
assert.match(stripTerminalSequences(formatToolLabel(interruptedFinal!)), /^\[1\] ▸ \? Interrupted operation$/);
assert.doesNotMatch(stripTerminalSequences(formatToolLabel(interruptedFinal!)), /✓/);

const abortedRegistry = new TerminalToolCallRegistry();
const abortedView = abortedRegistry.updateSnapshot({
	...interruptedStart,
	id: "assistant-aborted",
	stopReason: "aborted",
	isStreaming: false,
	content: [{ type: "toolCall", id: "tool-aborted", name: "read", label: "Aborted operation", arguments: {} }],
}, false).get(0);
assert.equal(abortedView?.state, "cancelled", "an aborted no-result tool is explicitly cancelled");
assert.match(stripTerminalSequences(formatToolLabel(abortedView!)), /^\[1\] ▸ − Aborted operation$/);
assert.doesNotMatch(stripTerminalSequences(formatToolLabel(abortedView!)), /✓/);

const boundedRegistry = new TerminalToolCallRegistry();
for (let index = 1; index <= 129; index++) {
	boundedRegistry.updateSnapshot({
		id: `bounded-${index}`,
		type: "message",
		timestamp: "2026-01-02T03:04:05Z",
		role: "assistant",
		isStreaming: false,
		content: [{ type: "toolCall", id: `bounded-tool-${index}`, name: "read", label: `Call ${index}`, arguments: {} }],
	}, false);
}
assert.equal(boundedRegistry.get(1), undefined, "session-local inspection evicts the oldest call beyond its bound");
assert.equal(boundedRegistry.get(129)?.label, "Call 129", "the newest bounded tool call remains inspectable");

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
assert(expandedLines.some((line) => stripTerminalSequences(line).includes("VISIBLE_RESULT")));

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
	assert.equal(sequence.handleInput("\u001b[27;5;50~"), true, "xterm modifier reporting extends the selector");
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
	assert.deepEqual(nativeSelectors, [12], "native modifier detection recovers Ctrl+digits from legacy terminals");
} finally {
	nativeSequence.dispose();
}

const fallbackSelectors: number[] = [];
const fallbackSequence = new ToolSelectorSequence((selector) => fallbackSelectors.push(selector), 5, () => false);
try {
	assert.equal(fallbackSequence.handleInput("1"), false, "ordinary digits still reach the composer without Control");
	assert.equal(fallbackSequence.handleInput("\u0014"), true, "Ctrl+T opens terminal-independent selector entry");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
	assert.equal(fallbackSequence.handleInput("1"), true);
	assert.equal(fallbackSequence.handleInput("2"), true);
	fallbackSequence.flush();
	assert.deepEqual(fallbackSelectors, [12], "the Ctrl+T leader remains armed after release");
} finally {
	fallbackSequence.dispose();
}

console.log("troublemaker TUI tool inspector tests passed");
