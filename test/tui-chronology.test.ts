import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { TroublemakerTuiApp } from "../src/tui/app.js";
import type { TroublemakerTuiClient } from "../src/tui/client.js";
import type { RuntimeLiveEvent, RuntimeStreamEvent, RuntimeAssistantSnapshotContent } from "../src/core/runtime-contract.js";

const terminalChannel = "terminal:example";
const timestamp = "2040-01-01T00:00:00Z";

// Drive real transcript rendering without starting the terminal or any network loops.
function harness(presentation: "pi" | "pi-thinking" | "compact", channel: string) {
	const requests: Array<() => void> = [];
	const client = {
		streamMessage: () => new Promise<void>((resolve) => requests.push(resolve)),
		getBacklog: async () => ({ lines: [], total: 0, offset: 0 }),
	};
	const app = new TroublemakerTuiApp({ command: "example", name: "Example", baseUrl: "https://example.com", channelId: terminalChannel, presentation },
		client as unknown as TroublemakerTuiClient,
		{ agentName: "Example", runtime: "example", mode: "standalone", workspaceReady: true }) as unknown as {
		handleSubmit(text: string): Promise<void>;
		handleLiveEvent(event: RuntimeLiveEvent): void;
		chat: Container;
		ui: { requestRender(): void; setFocus(): void };
		showLoader(): void;
		showExternalLoader(): void;
		clearLoader(): void;
	};
	app.ui.requestRender = () => {};
	app.ui.setFocus = () => {};
	app.showLoader = app.showExternalLoader = app.clearLoader = () => {};
	let sequence = 0;
	const emit = (event: RuntimeStreamEvent, runId = "example-run") => app.handleLiveEvent({ kind: "runtime", streamId: "example-stream", id: `event-${++sequence}`, sequence, timestamp, channelId: channel, runId, event });
	const input = (texts: string[], runId?: string) => emit({ type: "user_input", entries: texts.map((text) => ({ channel: terminalChannel, userName: "you", text })) }, runId);
	const awareness = (text: string) => app.handleLiveEvent({ kind: "awareness", streamId: "example-stream", id: `event-${++sequence}`, sequence, timestamp,
		line: JSON.stringify({ type: "message", id: `awareness-${sequence}`, timestamp, message: { role: "user", content: [{ type: "text", text: `[2040-01-01 00:00:00+00:00] [${terminalChannel}] [you]: ${text}` }] } }) });
	const content: RuntimeAssistantSnapshotContent[] = [];
	const snapshot = (text: string, runId?: string) => {
		content.push({ type: "text", text });
		emit({ type: "assistant_snapshot", entry: { id: "example-assistant", type: "message", timestamp, role: "assistant", isStreaming: true, content: [...content] } }, runId);
	};
	const rendered = () => stripTerminalSequences(app.chat.render(120).join("\n"));
	const ordered = (...tokens: string[]) => {
		const output = rendered();
		let previous = -1;
		for (const token of tokens) {
			const index = output.indexOf(token);
			assert(index > previous, `Expected ${token} after previous token:\n${output}`);
			assert.equal(output.indexOf(token, index + token.length), -1, `Duplicate ${token}:\n${output}`);
			previous = index;
		}
	};
	emit({ type: "user_input", entries: [{ channel, userName: "Casey", text: "INITIAL_INPUT" }] });
	snapshot("BEFORE_INPUT");
	return { app, emit, input, awareness, snapshot, rendered, ordered, content, finish: () => requests.forEach((resolve) => resolve()) };
}

test("Pi paints each cumulative assistant text update immediately", () => {
	const h = harness("pi", terminalChannel);
	h.content[0] = { type: "text", text: "BEFORE_INPUT FIRST_TEXT_FRAGMENT" };
	h.emit({ type: "assistant_snapshot", entry: {
		id: "example-assistant",
		type: "message",
		timestamp,
		role: "assistant",
		isStreaming: true,
		content: [...h.content],
	} });
	assert.match(h.rendered(), /BEFORE_INPUT FIRST_TEXT_FRAGMENT/);
	h.content[0] = { type: "text", text: "BEFORE_INPUT FIRST_TEXT_FRAGMENT SECOND_TEXT_FRAGMENT" };
	h.emit({ type: "assistant_snapshot", entry: {
		id: "example-assistant",
		type: "message",
		timestamp,
		role: "assistant",
		isStreaming: true,
		content: [...h.content],
	} });
	assert.match(h.rendered(), /FIRST_TEXT_FRAGMENT SECOND_TEXT_FRAGMENT/);
});

test("Pi-thinking paints each cumulative reasoning update immediately", () => {
	const h = harness("pi-thinking", terminalChannel);
	h.content.push({ type: "thinking", thinking: "FIRST_REASONING_FRAGMENT" });
	h.emit({ type: "assistant_snapshot", entry: {
		id: "example-assistant",
		type: "message",
		timestamp,
		role: "assistant",
		isStreaming: true,
		content: [...h.content],
	} });
	assert.match(h.rendered(), /FIRST_REASONING_FRAGMENT/);
	h.content[h.content.length - 1] = { type: "thinking", thinking: "FIRST_REASONING_FRAGMENT SECOND_REASONING_FRAGMENT" };
	h.emit({ type: "assistant_snapshot", entry: {
		id: "example-assistant",
		type: "message",
		timestamp,
		role: "assistant",
		isStreaming: true,
		content: [...h.content],
	} });
	assert.match(h.rendered(), /FIRST_REASONING_FRAGMENT SECOND_REASONING_FRAGMENT/);
});

test("ordinary Pi keeps reasoning hidden", () => {
	const h = harness("pi", terminalChannel);
	h.content.push({ type: "thinking", thinking: "PRIVATE_REASONING_FRAGMENT" });
	h.emit({ type: "assistant_snapshot", entry: {
		id: "example-assistant",
		type: "message",
		timestamp,
		role: "assistant",
		isStreaming: true,
		content: [...h.content],
	} });
	assert.doesNotMatch(h.rendered(), /PRIVATE_REASONING_FRAGMENT/);
});

for (const presentation of ["pi", "pi-thinking", "compact"] as const) {
	test(`${presentation}: interrupted run cannot adopt an older local target on restart`, async () => {
		const h = harness(presentation, terminalChannel);
		const first = h.app.handleSubmit("FIRST_INPUT");
		h.snapshot("AFTER_FIRST");
		await h.app.handleSubmit("SECOND_INPUT");
		h.emit({ type: "run_complete", channelId: terminalChannel });
		h.content.length = 0;
		h.snapshot("RESTART_OUTPUT", "restarted-run");
		// Neither input has been persisted yet. Adoption on a different run ID
		// must respect the newer target even though its old adoption ID differs.
		h.input(["FIRST_INPUT"], "restarted-run");
		h.snapshot("AFTER_OLD_ECHO", "restarted-run");
		h.input(["SECOND_INPUT"], "restarted-run");
		h.awareness("FIRST_INPUT");
		h.awareness("SECOND_INPUT");
		h.snapshot("FINAL_OUTPUT", "restarted-run");
		h.ordered("BEFORE_INPUT", "FIRST_INPUT", "AFTER_FIRST", "SECOND_INPUT", "RESTART_OUTPUT", "AFTER_OLD_ECHO", "FINAL_OUTPUT");
		h.finish();
		await first;
	});
	test(`${presentation}: tools received before input acknowledgement remain after local input`, async () => {
		const h = harness(presentation, "computer:example");
		const first = h.app.handleSubmit("FIRST_INPUT");
		h.content.push({ type: "toolCall", id: "example-tool", name: "read", label: "TOOL_AFTER_INPUT", arguments: {} });
		h.snapshot("AFTER_TOOL");
		h.awareness("FIRST_INPUT");
		h.input(["FIRST_INPUT"]);
		h.content.push({ type: "toolResult", toolCallId: "example-tool", result: "example", isError: false });
		h.snapshot("FINAL_OUTPUT");
		h.ordered("BEFORE_INPUT", "FIRST_INPUT", "TOOL_AFTER_INPUT", "AFTER_TOOL", "FINAL_OUTPUT");
		h.finish();
		await first;
	});
	for (const channel of [terminalChannel, "computer:example"]) {
		for (const delivery of ["runtime-first", "awareness-first", "batched"] as const) {
			test(`${presentation}: ${channel} rapid local inputs with ${delivery} delayed adoption`, async () => {
				const h = harness(presentation, channel);
				const first = h.app.handleSubmit("FIRST_INPUT");
				h.snapshot("AFTER_FIRST");
				h.ordered("BEFORE_INPUT", "FIRST_INPUT", "AFTER_FIRST");
				await h.app.handleSubmit("SECOND_INPUT");
				h.snapshot("AFTER_SECOND");
				if (delivery === "awareness-first") {
					h.awareness("FIRST_INPUT");
					h.snapshot("AFTER_OLD_ECHO");
					h.awareness("SECOND_INPUT");
					h.input(["FIRST_INPUT", "SECOND_INPUT"]);
				} else {
					h.input(delivery === "batched" ? ["FIRST_INPUT", "SECOND_INPUT"] : ["FIRST_INPUT"]);
					h.snapshot("AFTER_OLD_ECHO");
					if (delivery !== "batched") h.input(["SECOND_INPUT"]);
					h.awareness("FIRST_INPUT");
					h.awareness("SECOND_INPUT");
				}
				h.snapshot("FINAL_OUTPUT");
				h.ordered("BEFORE_INPUT", "FIRST_INPUT", "AFTER_FIRST", "SECOND_INPUT", "AFTER_SECOND", "AFTER_OLD_ECHO", "FINAL_OUTPUT");
				h.finish();
				await first;
			});
		}
	}
}
