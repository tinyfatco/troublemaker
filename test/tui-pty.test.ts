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
const ambientLine = JSON.stringify({
	type: "message",
	id: "ambient-1",
	timestamp: "2026-01-02T03:04:05Z",
	message: {
		role: "user",
		content: [{ type: "text", text: "[2026-01-02 03:04:05+00:00] [#general] [Taylor]: ambient update" }],
	},
});

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
		const timer = setTimeout(() => {
			res.write(`id: ambient-1\ndata: ${ambientLine}\n\n`);
		}, 100);
		req.on("close", () => clearTimeout(timer));
		return;
	}
	if (req.url === "/api/v2/agents/current/messages") {
		const body = await readJson(req);
		assert.equal(body.channelId, "terminal:demo-agent");
		writeTurn(res);
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
send -- "run a check\\r"
expect {
  {All done.} {}
  timeout { puts stderr "TUI response timeout"; exit 4 }
  eof { puts stderr "TUI exited before response"; exit 5 }
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
	assert.match(rendered, /ambient update/);
	assert.match(rendered, /\[slack:#general\] Taylor/);
	assert.match(rendered, /awareness live/);
	assert.match(rendered, /\[terminal:demo-agent\] you/);
	assert.doesNotMatch(rendered, /TOP_SECRET_COMMAND/);
	console.log("troublemaker TUI PTY smoke test passed");
} finally {
	if (terminal && !terminal.killed) terminal.kill();
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	await rm(tempRoot, { recursive: true, force: true });
}

function writeTurn(res: ServerResponse): void {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	res.write(`data: ${JSON.stringify({ type: "status", status: "accepted" })}\n\n`);
	res.write(`data: ${JSON.stringify({
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
	})}\n\n`);
	setTimeout(() => {
		res.write(`data: ${JSON.stringify({
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
				isStreaming: false,
			},
		})}\n\n`);
		res.write(`data: ${JSON.stringify({ type: "run_complete", channelId: "terminal:demo-agent" })}\n\n`);
		res.end("data: [DONE]\n\n");
	}, 80);
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
