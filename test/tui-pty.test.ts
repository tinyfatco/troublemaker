import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { installTuiProfile } from "../src/tui/config.js";

const tempRoot = await mkdtemp(join(tmpdir(), "troublemaker-tui-pty-"));
let terminal: ChildProcessWithoutNullStreams | undefined;
const receivedMessages: string[] = [];
let resolveSteer!: () => void;
const steerReceived = new Promise<void>((resolvePromise) => {
	resolveSteer = resolvePromise;
});
const ambientLine = JSON.stringify({
	type: "message",
	id: "ambient-1",
	timestamp: "2026-01-02T03:04:05Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "[2026-01-02 03:04:05+00:00] [#general] [Taylor]: ambient update" }],
	},
});
const idleAssistantLine = JSON.stringify({
	type: "message",
	id: "ambient-assistant-1",
	parentId: "ambient-1",
	timestamp: "2026-01-02T03:04:06Z",
	message: {
		role: "assistant",
		content: [{
			type: "toolCall",
			id: "external-tool-1",
			name: "bash",
			label: "External check finished",
			arguments: { command: "EXTERNAL_PRIVATE_COMMAND" },
		}],
	},
});
const voiceLine = JSON.stringify({
	type: "message",
	id: "voice-1",
	timestamp: "2026-01-02T03:04:06Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "[2026-01-02 03:04:06+00:00] [voice] [user]: voice update" }],
	},
});
const activeAmbientLine = JSON.stringify({
	type: "message",
	id: "ambient-active",
	timestamp: "2026-01-02T03:04:07Z",
	message: {
		role: "user",
		content: [{
			type: "text",
			text: "<session_context>\nUsers:\nU123\t@robin\tRobin\nU456\t@observer\tObserver\nSkills:\n(none)\n</session_context>\n\n[2026-01-02 03:04:07+00:00] [general] [unknown]: [AMBIENT] A conversation is happening in slack:#general. New unseen, complete messages since your last ambient wake:\n\n<ambient_messages>\nRobin (U123) [Reply target: slack:C123:1; message_ts: 2; thread_ts: 1]: ambient during active turn <@U456>\n</ambient_messages>\n\nChannel pulse: 1 messages in last 15min.\n\nYou're observing this conversation naturally.",
		}],
	},
});
const activeYieldLine = JSON.stringify({
	type: "message",
	id: "ambient-yield",
	parentId: "ambient-active",
	timestamp: "2026-01-02T03:04:08Z",
	message: {
		role: "assistant",
		content: [{
			type: "toolCall",
			id: "yield-1",
			name: "yield_no_action",
			arguments: { reason: "nothing useful to add" },
		}],
	},
});
const terminalUserLine = JSON.stringify({
	type: "message",
	id: "terminal-user",
	timestamp: "2026-01-02T03:04:06Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "[2026-01-02 03:04:06+00:00] [terminal:demo-agent] [you]: run a check" }],
	},
});
const terminalDuringExternalRunLine = JSON.stringify({
	type: "message",
	id: "terminal-during-external-run",
	timestamp: "2026-01-02T03:04:09Z",
	message: {
		role: "user",
		content: [{
			type: "text",
			text: "[2026-01-02 03:04:09+00:00] [terminal:demo-agent] [you]: during external work",
		}],
	},
});
const terminalAssistantEchoLine = JSON.stringify({
	type: "message",
	id: "terminal-assistant-echo",
	parentId: "terminal-user",
	timestamp: "2026-01-02T03:04:06Z",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "PERSISTED_TERMINAL_ECHO" }],
	},
});
const zulipMentionLine = JSON.stringify({
	type: "message",
	id: "zulip-mention-input",
	timestamp: "2026-01-02T03:04:09Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "<delivery_context>private route</delivery_context>\n\n[2026-01-02 03:04:09+00:00] [zulip:10:topic:general%20chat] [Alex]: @**Batman** BATMAN_TAG_INPUT" }],
	},
});
const goalContinuationLine = JSON.stringify({
	type: "message",
	id: "goal-continuation-input",
	timestamp: "2026-01-02T03:04:11Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "<session_context>private runtime context</session_context>\n\n[2026-01-02 03:04:11+00:00] [terminal:ghost] [goal]: [GOAL CONTINUATION]\nContinue working toward the active goal.\n\nAutomatic goal turn: 1" }],
	},
});
const webhookSteerLine = JSON.stringify({
	type: "message",
	id: "webhook-steer",
	timestamp: "2026-01-02T03:04:10Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "<delivery_context>private route</delivery_context>\n\n[2026-01-02 03:04:10+00:00] [slack:#urgent] [Riley]: WEBHOOK_STEER_INPUT" }],
	},
});
let awarenessResponse: ServerResponse | undefined;
let liveResponse: ServerResponse | undefined;
let liveSequence = 0;
let runBusy = false;

function emitAwareness(id: string, line: string): void {
	awarenessResponse?.write(`id: ${id}\ndata: ${line}\n\n`);
	emitLive({ kind: "awareness", line, awarenessId: id });
}

function emitRuntime(runId: string, channelId: string, event: Record<string, unknown>, source = "test"): void {
	emitLive({ kind: "runtime", runId, channelId, channelLabel: channelId, source, event });
}

function emitLive(payload: Record<string, unknown>): void {
	const sequence = ++liveSequence;
	const envelope = {
		...payload,
		sequence,
		streamId: "test-stream",
		id: `live-${sequence}`,
		timestamp: new Date().toISOString(),
	};
	liveResponse?.write(`id: ${sequence}\ndata: ${JSON.stringify(envelope)}\n\n`);
}

const server = createServer(async (req, res) => {
	if (req.url === "/health") {
		res.writeHead(200);
		res.end("ok");
		return;
	}
	if (req.url === "/api/v2/agents/current/status") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ agent_name: "Demo Agent", runtime: "troublemaker", mode: "standalone", workspace_ready: true }));
		return;
	}
	if (req.url === "/status") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			running: runBusy ? ["awareness"] : [],
			idle: !runBusy,
			activeRun: runBusy ? "external run" : "idle",
		}));
		return;
	}
	if (req.url?.startsWith("/api/v2/agents/current/events")) {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ lines: [], total: 0, offset: 0 }));
		return;
	}
	if (req.url === "/awareness/stream") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		awarenessResponse = res;
		const ambientTimer = setTimeout(() => {
			runBusy = true;
			emitAwareness("ambient-1", ambientLine);
		}, 100);
		const assistantTimer = setTimeout(() => {
			emitAwareness("ambient-assistant-1", idleAssistantLine);
		}, 850);
		const idleTimer = setTimeout(() => {
			runBusy = false;
		}, 1_000);
		req.on("close", () => {
			clearTimeout(ambientTimer);
			clearTimeout(assistantTimer);
			clearTimeout(idleTimer);
			if (awarenessResponse === res) awarenessResponse = undefined;
		});
		return;
	}
	if (req.url?.startsWith("/api/v2/agents/current/live")) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		liveResponse = res;
		const ambientTimer = setTimeout(() => {
			runBusy = true;
			emitAwareness("ambient-1", ambientLine);
		}, 100);
		const assistantTimer = setTimeout(() => {
			emitRuntime("external-run", "slack:#general", {
				type: "assistant_snapshot",
				entry: {
					id: "external-live",
					type: "message",
					timestamp: "2026-01-02T03:04:06Z",
					role: "assistant",
					content: [{ type: "toolCall", id: "external-tool-1", name: "bash", label: "External check finished", arguments: {} }],
					isStreaming: true,
				},
			});
		}, 850);
		const voiceTimer = setTimeout(() => emitAwareness("voice-1", voiceLine), 1_050);
		const voiceToolTimer = setTimeout(() => {
			emitRuntime("voice-run", "voice", {
				type: "assistant_snapshot",
				entry: {
					id: "voice-live",
					type: "message",
					timestamp: "2026-01-02T03:04:07Z",
					role: "assistant",
					content: [{ type: "toolCall", id: "voice-tool-1", name: "bash", label: "Voice-side check", arguments: {} }],
					isStreaming: true,
				},
			}, "voice");
		}, 1_150);
		const webhookInputTimer = setTimeout(() => {
			emitRuntime("webhook-run", "zulip:10:topic:general%20chat", {
				type: "user_input",
				entries: [{ channel: "zulip:10:topic:general%20chat", userName: "Alex", text: "@**Batman** BATMAN_TAG_INPUT" }],
			}, "zulip");
		}, 1_400);
		const webhookOutputTimer = setTimeout(() => {
			emitRuntime("webhook-run", "zulip:10:topic:general%20chat", {
				type: "assistant_snapshot",
				entry: {
					id: "webhook-live",
					type: "message",
					timestamp: "2026-01-02T03:04:09Z",
					role: "assistant",
					content: [{ type: "text", text: "WEBHOOK_FIRST_OUTPUT" }],
					isStreaming: false,
				},
			}, "zulip");
		}, 1_480);
		const webhookAwarenessTimer = setTimeout(() => emitAwareness("zulip-mention-input", zulipMentionLine), 1_560);
		const webhookSteerTimer = setTimeout(() => {
			emitRuntime("webhook-run", "slack:#webhook", {
				type: "user_input",
				entries: [{ channel: "slack:#urgent", userName: "Riley", text: "WEBHOOK_STEER_INPUT" }],
			}, "slack");
		}, 1_640);
		const webhookSteerOutputTimer = setTimeout(() => {
			emitRuntime("webhook-run", "slack:#webhook", {
				type: "assistant_snapshot",
				entry: {
					id: "webhook-live",
					type: "message",
					timestamp: "2026-01-02T03:04:10Z",
					role: "assistant",
					content: [
						{ type: "text", text: "WEBHOOK_FIRST_OUTPUT" },
						{ type: "text", text: "TERMINAL_INTERPOLATED_OUTPUT" },
						{ type: "text", text: "WEBHOOK_SECOND_OUTPUT" },
					],
					isStreaming: false,
				},
			}, "slack");
		}, 1_720);
		const webhookSteerAwarenessTimer = setTimeout(() => emitAwareness("webhook-steer", webhookSteerLine), 1_800);
		const goalInputTimer = setTimeout(() => {
			emitRuntime("goal-run", "terminal:ghost", {
				type: "user_input",
				entries: [{ channel: "terminal:ghost", userName: "goal", text: "[GOAL CONTINUATION]\nContinue working toward the active goal.\n\nAutomatic goal turn: 1" }],
			}, "goal");
		}, 1_880);
		const goalOutputTimer = setTimeout(() => {
			emitRuntime("goal-run", "terminal:ghost", {
				type: "assistant_snapshot",
				entry: {
					id: "goal-live",
					type: "message",
					timestamp: "2026-01-02T03:04:11Z",
					role: "assistant",
					content: [{ type: "text", text: "GOAL_CONTINUED_OUTPUT" }],
					isStreaming: false,
				},
			}, "goal");
		}, 1_960);
		const goalAwarenessTimer = setTimeout(() => emitAwareness("goal-continuation-input", goalContinuationLine), 2_040);
		const webhookCompleteTimer = setTimeout(() => {
			emitRuntime("webhook-run", "slack:#webhook", { type: "run_complete", channelId: "slack:#webhook" }, "slack");
		}, 2_120);
		const idleTimer = setTimeout(() => {
			runBusy = false;
		}, 2_200);
		req.on("close", () => {
			clearTimeout(ambientTimer);
			clearTimeout(assistantTimer);
			clearTimeout(voiceTimer);
			clearTimeout(voiceToolTimer);
			clearTimeout(webhookInputTimer);
			clearTimeout(webhookOutputTimer);
			clearTimeout(webhookAwarenessTimer);
			clearTimeout(webhookSteerTimer);
			clearTimeout(webhookSteerOutputTimer);
			clearTimeout(webhookSteerAwarenessTimer);
			clearTimeout(goalInputTimer);
			clearTimeout(goalOutputTimer);
			clearTimeout(goalAwarenessTimer);
			clearTimeout(webhookCompleteTimer);
			clearTimeout(idleTimer);
			if (liveResponse === res) liveResponse = undefined;
		});
		return;
	}
	if (req.url === "/api/v2/agents/current/messages") {
		const body = await readJson(req);
		assert.equal(body.channelId, "terminal:demo-agent");
		assert.equal(typeof body.message, "string");
		receivedMessages.push(body.message as string);
		if (receivedMessages.length === 1) {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			res.write(`data: ${JSON.stringify({ type: "status", status: "accepted" })}\n\n`);
			res.write(`data: ${JSON.stringify({ type: "status", status: "steering", message: "Steering active run..." })}\n\n`);
			emitAwareness("terminal-during-external-run", terminalDuringExternalRunLine);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
			emitRuntime("webhook-run", "slack:#webhook", {
				type: "assistant_snapshot",
				entry: {
					id: "webhook-live",
					type: "message",
					timestamp: "2026-01-02T03:04:09Z",
					role: "assistant",
					content: [
						{ type: "text", text: "WEBHOOK_FIRST_OUTPUT" },
						{ type: "text", text: "TERMINAL_INTERPOLATED_OUTPUT" },
					],
					isStreaming: false,
				},
			}, "terminal");
			res.end("data: [DONE]\n\n");
		} else if (receivedMessages.length === 2) {
			await writeTurn(res, steerReceived, () => {
				emitAwareness("terminal-user", terminalUserLine);
				emitAwareness("terminal-assistant-echo", terminalAssistantEchoLine);
				emitAwareness("ambient-active", activeAmbientLine);
				emitAwareness("ambient-yield", activeYieldLine);
			});
		} else {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			res.write(`data: ${JSON.stringify({ type: "status", status: "accepted" })}\n\n`);
			res.write(`data: ${JSON.stringify({ type: "status", status: "steering", message: "Steering active run..." })}\n\n`);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
			res.end("data: [DONE]\n\n");
			resolveSteer();
		}
		return;
	}
	if (req.url === "/api/v2/agents/current/messages/stop") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}
	res.writeHead(404);
	res.end();
});

try {
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address !== "string");
	const installed = installTuiProfile({
		command: "demo-agent",
		name: "Demo Agent",
		baseUrl: `http://127.0.0.1:${address.port}`,
		executablePath: resolve("dist/tui.js"),
		configPath: join(tempRoot, "config", "tui.json"),
		binDir: join(tempRoot, "bin"),
	});

	let output = "";
	let exited = false;
	const expectScript = `
set timeout 8
spawn -noecho {${installed.commandPath}}
expect {
  -re {enter.*send} {}
  timeout { puts stderr "TUI prompt timeout"; exit 2 }
  eof { puts stderr "TUI exited before prompt"; exit 3 }
}
expect {
  {ambient update} {}
  timeout { puts stderr "Ambient update timeout"; exit 6 }
  eof { puts stderr "TUI exited before ambient update"; exit 7 }
}
expect {
  {Working...} {}
  timeout { puts stderr "External working indicator timeout"; exit 16 }
  eof { puts stderr "TUI exited before external working indicator"; exit 17 }
}
expect {
  {External check finished} {}
  timeout { puts stderr "Idle external assistant repaint timeout"; exit 14 }
  eof { puts stderr "TUI exited before idle external assistant update"; exit 15 }
}
expect {
  {voice update} {}
  timeout { puts stderr "External voice prompt repaint timeout"; exit 18 }
  eof { puts stderr "TUI exited before external voice prompt"; exit 19 }
}
expect {
  {Voice-side check} {}
  timeout { puts stderr "External voice tool repaint timeout"; exit 20 }
  eof { puts stderr "TUI exited before external voice tool"; exit 21 }
}
expect {
  {BATMAN_TAG_INPUT} {}
  timeout { puts stderr "Zulip Batman mention paint timeout"; exit 22 }
  eof { puts stderr "TUI exited before Zulip Batman mention"; exit 23 }
}
expect {
  {WEBHOOK_FIRST_OUTPUT} {}
  timeout { puts stderr "Webhook first output ordering timeout"; exit 24 }
  eof { puts stderr "TUI exited before webhook first output"; exit 25 }
}
send -- "during external work\\r"
expect {
  {TERMINAL_INTERPOLATED_OUTPUT} {}
  timeout { puts stderr "Terminal-during-external interpolation timeout"; exit 34 }
  eof { puts stderr "TUI exited before interpolated terminal output"; exit 35 }
}
expect {
  {WEBHOOK_STEER_INPUT} {}
  timeout { puts stderr "Webhook steering input paint timeout"; exit 26 }
  eof { puts stderr "TUI exited before webhook steering input"; exit 27 }
}
expect {
  {WEBHOOK_SECOND_OUTPUT} {}
  timeout { puts stderr "Webhook steering output ordering timeout"; exit 28 }
  eof { puts stderr "TUI exited before webhook steering output"; exit 29 }
}
expect {
  {GOAL CONTINUATION} {}
  timeout { puts stderr "Goal continuation input paint timeout"; exit 30 }
  eof { puts stderr "TUI exited before goal continuation input"; exit 31 }
}
expect {
  {GOAL_CONTINUED_OUTPUT} {}
  timeout { puts stderr "Goal continuation output ordering timeout"; exit 32 }
  eof { puts stderr "TUI exited before goal continuation output"; exit 33 }
}
send -- "run a check\\r"
expect {
  {All done.} {}
  timeout { puts stderr "TUI response timeout"; exit 4 }
  eof { puts stderr "TUI exited before response"; exit 5 }
}
expect {
  {Compacting context...} {}
  timeout { puts stderr "Compaction status timeout"; exit 8 }
  eof { puts stderr "TUI exited before compaction status"; exit 9 }
}
send -- "look at the newer results instead\\r"
expect {
  {Steered answer.} {}
  timeout { puts stderr "Steering response timeout"; exit 10 }
  eof { puts stderr "TUI exited before steering response"; exit 11 }
}
expect {
  {yield_no_action} {}
  timeout { puts stderr "Deferred ambient yield timeout"; exit 12 }
  eof { puts stderr "TUI exited before deferred ambient yield"; exit 13 }
}
send -- "\\003"
expect eof
`;
	terminal = spawn("/usr/bin/expect", ["-c", expectScript], {
		cwd: process.cwd(),
		env: {
			...process.env,
			TERM: "xterm-256color",
			TROUBLEMAKER_TUI_CONFIG: installed.configPath,
		},
	});
	terminal.stdout.on("data", (data: Buffer) => {
		output = `${output}${data.toString("utf8")}`.slice(-200_000);
	});
	terminal.stderr.on("data", (data: Buffer) => {
		output = `${output}${data.toString("utf8")}`.slice(-200_000);
	});
	terminal.on("exit", () => {
		exited = true;
	});

	await waitFor(() => exited, 12_000, () => visibleOutput(output));
	assert.equal(terminal.exitCode, 0, visibleOutput(output));
	assert.match(visibleOutput(output), /Demo Agent/);
	assert.match(visibleOutput(output), /terminal:demo-agent/);

	const rendered = visibleOutput(output);
	assert.match(rendered, /Checking the workspace/);
	assert.match(rendered, /All done\./);
	assert.match(rendered, /Compacting context\.\.\./);
	assert.match(rendered, /Steering(?: active run)?\.\.\./);
	assert.match(rendered, /Steered answer\./);
	assert.match(rendered, /ambient update/);
	assert.match(rendered, /Working\.\.\./);
	assert.match(rendered, /External check finished/);
	assert.match(rendered, /voice update/);
	assert.match(rendered, /Voice-side check/);
	assert.match(rendered, /BATMAN_TAG_INPUT/);
	assert.match(rendered, /WEBHOOK_FIRST_OUTPUT/);
	assert.match(rendered, /during external work/);
	assert.match(rendered, /TERMINAL_INTERPOLATED_OUTPUT/);
	assert.match(rendered, /WEBHOOK_STEER_INPUT/);
	assert.match(rendered, /WEBHOOK_SECOND_OUTPUT/);
	assert.match(rendered, /GOAL CONTINUATION/);
	assert.match(rendered, /GOAL_CONTINUED_OUTPUT/);
	assert.match(rendered, /Robin: ambient during active turn @observer/);
	assert.doesNotMatch(rendered, /<@U456>/);
	assert.match(rendered, /yield_no_action/);
	assert.doesNotMatch(rendered, /Channel pulse:/);
	assert.doesNotMatch(rendered, /Reply target:/);
	assert.doesNotMatch(rendered, /PERSISTED_TERMINAL_ECHO/);
	assert.match(rendered, /\[slack:#general\] Taylor/);
	assert.match(rendered, /awareness live/);
	assert.match(rendered, /\[terminal:demo-agent\] you/);
	assert.doesNotMatch(rendered, /TOP_SECRET_COMMAND/);
	assert.doesNotMatch(rendered, /EXTERNAL_PRIVATE_COMMAND/);
	assert.doesNotMatch(rendered, /private route/);
	assert(
		rendered.lastIndexOf("during external work") < rendered.lastIndexOf("TERMINAL_INTERPOLATED_OUTPUT"),
		"terminal input remains above the assistant output that follows it during an external run",
	);
	assert.deepEqual(receivedMessages, [
		"during external work",
		"run a check",
		"look at the newer results instead",
	]);
	console.log("troublemaker TUI PTY smoke test passed");
} finally {
	resolveSteer();
	if (terminal && !terminal.killed) terminal.kill();
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	await rm(tempRoot, { recursive: true, force: true });
}

async function writeTurn(res: ServerResponse, waitForSteer: Promise<void>, emitActiveAwareness: () => void): Promise<void> {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	res.write(`data: ${JSON.stringify({ type: "status", status: "accepted" })}\n\n`);
	const firstSnapshot = {
		type: "assistant_snapshot",
		entry: {
			id: "live",
			type: "message",
			timestamp: "2026-01-02T03:04:06Z",
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "tool-1",
				name: "bash",
				label: "Checking the workspace",
				arguments: { command: "TOP_SECRET_COMMAND" },
			}],
			isStreaming: true,
		},
	};
	res.write(`data: ${JSON.stringify(firstSnapshot)}\n\n`);
	emitRuntime("terminal-run", "terminal:demo-agent", firstSnapshot, "terminal");
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
	const completedSnapshot = {
		type: "assistant_snapshot",
		entry: {
			id: "live",
			type: "message",
			timestamp: "2026-01-02T03:04:06Z",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "bash", label: "Checking the workspace", arguments: { command: "TOP_SECRET_COMMAND" } },
				{ type: "toolResult", toolCallId: "tool-1", result: "private output", isError: false },
				{ type: "text", text: "All done." },
			],
			stopReason: "stop",
			isStreaming: false,
		},
	};
	res.write(`data: ${JSON.stringify(completedSnapshot)}\n\n`);
	emitRuntime("terminal-run", "terminal:demo-agent", completedSnapshot, "terminal");
	const compacting = { type: "status", status: "compacting", message: "Compacting context..." };
	res.write(`data: ${JSON.stringify(compacting)}\n\n`);
	emitRuntime("terminal-run", "terminal:demo-agent", compacting, "terminal");
	emitActiveAwareness();
	await waitForSteer;
	const resumed = { type: "status", status: "streaming", message: "Context compacted; resuming..." };
	res.write(`data: ${JSON.stringify(resumed)}\n\n`);
	emitRuntime("terminal-run", "terminal:demo-agent", resumed, "terminal");
	const steeredSnapshot = {
		type: "assistant_snapshot",
		entry: {
			id: "live",
			type: "message",
			timestamp: "2026-01-02T03:04:06Z",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "bash", label: "Checking the workspace", arguments: { command: "TOP_SECRET_COMMAND" } },
				{ type: "toolResult", toolCallId: "tool-1", result: "private output", isError: false },
				{ type: "text", text: "All done." },
				{ type: "text", text: "Steered answer." },
			],
			stopReason: "stop",
			isStreaming: false,
		},
	};
	res.write(`data: ${JSON.stringify(steeredSnapshot)}\n\n`);
	emitRuntime("terminal-run", "terminal:demo-agent", steeredSnapshot, "terminal");
	res.write(`data: ${JSON.stringify({ type: "run_complete", channelId: "terminal:demo-agent" })}\n\n`);
	emitRuntime("terminal-run", "terminal:demo-agent", { type: "run_complete", channelId: "terminal:demo-agent" }, "terminal");
	res.end("data: [DONE]\n\n");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	let body = "";
	for await (const chunk of req) body += Buffer.from(chunk).toString("utf8");
	return JSON.parse(body) as Record<string, unknown>;
}

function visibleOutput(value: string): string {
	return stripVTControlCharacters(value).replace(/\x1b_[^\x07]*\x07/g, "");
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, debug?: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
	const detail = debug?.().slice(-2_000).replace(/\s+/g, " ").trim();
	throw new Error(`Timed out waiting for TUI state${detail ? `: ${detail}` : ""}`);
}
