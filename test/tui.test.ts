import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TroublemakerTuiClient } from "../src/tui/client.js";
import {
	installTuiProfile,
	loadTuiProfiles,
	normalizeTuiBaseUrl,
	normalizeTuiCommand,
	resolveInvokedAgent,
} from "../src/tui/config.js";
import { assistantContentDelta, getAmbientDisplayLines, normalizeChannelLabel, parseContextLine, readRuntimeSse, safeToolLabel } from "../src/tui/protocol.js";

const tempRoot = await mkdtemp(join(tmpdir(), "troublemaker-tui-test-"));

try {
	const executablePath = join(tempRoot, "dist", "tui.js");
	const configPath = join(tempRoot, "config", "tui.json");
	const binDir = join(tempRoot, "bin");
	await mkdir(dirname(executablePath), { recursive: true });
	await writeFile(executablePath, "#!/usr/bin/env node\n", { mode: 0o755 });

	const installed = installTuiProfile({
		command: "example-agent",
		name: "Example Agent",
		baseUrl: "http://127.0.0.1:43123/",
		executablePath,
		configPath,
		binDir,
	});
	assert.equal(installed.profile.command, "example-agent");
	assert.equal(installed.profile.channelId, "terminal:example-agent");
	assert.equal(installed.profile.baseUrl, "http://127.0.0.1:43123");
	assert.equal(resolve(dirname(installed.commandPath), await readlink(installed.commandPath)), resolve(executablePath));
	assert.equal((await stat(configPath)).mode & 0o777, 0o600);
	assert.deepEqual(loadTuiProfiles(configPath)["example-agent"], installed.profile);
	assert.equal(resolveInvokedAgent("/tmp/example-agent"), "example-agent");
	assert.equal(resolveInvokedAgent("/tmp/troublemaker-tui"), undefined);
	assert.equal(normalizeTuiCommand(" Example-Agent "), "example-agent");
	assert.throws(() => normalizeTuiCommand("not_valid"), /Agent command/);
	assert.equal(normalizeTuiBaseUrl("https://agent.example.com/"), "https://agent.example.com");
	assert.throws(() => normalizeTuiBaseUrl("file:///tmp/agent"), /http or https/);

	const stored = JSON.parse(await readFile(configPath, "utf8"));
	assert.equal(stored.version, 1);
	assert.equal(stored.agents["example-agent"].name, "Example Agent");
	await writeFile(join(binDir, "blocked-agent"), "existing command\n");
	assert.throws(() => installTuiProfile({
		command: "blocked-agent",
		baseUrl: "http://127.0.0.1:43124",
		executablePath,
		configPath,
		binDir,
	}), /Refusing to replace existing command/);
	assert.equal(loadTuiProfiles(configPath)["blocked-agent"], undefined);

	const historyLine = JSON.stringify({
		type: "message",
		id: "message-1",
		timestamp: "2026-01-02T03:04:05Z",
		message: {
			role: "user",
			content: [{
				type: "text",
				text: "<session_context>private model context</session_context>\n\n<delivery_context>routing metadata</delivery_context>\n\n[2026-01-02 03:04:05+00:00] [#general] [Taylor]: hello there",
			}],
		},
	});
	const parsedHistory = parseContextLine(historyLine);
	assert.equal(parsedHistory?.channel, "slack:#general");
	assert.equal(parsedHistory?.userName, "Taylor");
	assert.equal(parsedHistory?.text, "hello there");
	const ambientPrompt = `[AMBIENT] A conversation is happening in slack:#biz. New unseen, complete messages since your last ambient wake:\n\n<ambient_messages>\nAlex (U123) [Reply target: slack:C123:1; message_ts: 2; thread_ts: 1]: ship the fix <@U456>\nBatman (U456): on it\n</ambient_messages>\n\nChannel pulse: 2 messages in last 15min.\n\nYou're observing this conversation naturally.`;
	assert.deepEqual(getAmbientDisplayLines(ambientPrompt), ["Alex: ship the fix <@U456>", "Batman: on it"]);
	const parsedAmbient = parseContextLine(JSON.stringify({
		type: "message",
		id: "ambient-current",
		parentId: "ambient-parent",
		timestamp: "2026-01-02T03:04:05Z",
		message: { role: "user", content: [{ type: "text", text: `<session_context>\nUsers:\nU123\t@alex\tAlex\nU456\t@batman\tBatman\nSkills:\n(none)\n</session_context>\n\n[2026-01-02 03:04:05+00:00] [biz] [unknown]: ${ambientPrompt}` }] },
	}));
	assert.equal(parsedAmbient?.channel, "slack:#biz");
	assert.equal(parsedAmbient?.parentId, "ambient-parent");
	assert.equal(parsedAmbient?.userName, "ambient");
	assert.equal(parsedAmbient?.text, "Alex: ship the fix @batman\nBatman: on it");
	assert.equal(parsedAmbient?.isAmbient, true);
	assert.equal(normalizeChannelLabel("123456"), "telegram:123456");
	assert.equal(safeToolLabel({
		type: "toolCall",
		id: "tool-1",
		name: "bash",
		label: "Checking the workspace",
		arguments: { command: "sensitive raw arguments" },
	}), "Checking the workspace");
	const baselineContent = [
		{ type: "thinking" as const, thinking: "private thought" },
		{ type: "toolCall" as const, id: "tool-1", name: "bash", label: "Checking", arguments: { command: "private" } },
		{ type: "toolOutput" as const, toolCallId: "tool-1", stream: "stdout" as const, text: "private partial output" },
		{ type: "text" as const, text: "Before" },
	];
	assert.deepEqual(assistantContentDelta([
		{ type: "thinking", thinking: "more private thought" },
		{ type: "toolCall", id: "tool-1", name: "bash", label: "Checking", arguments: { command: "private" } },
		{ type: "toolOutput", toolCallId: "tool-1", stream: "stdout", text: "private completed output" },
		{ type: "toolResult", toolCallId: "tool-1", result: "private result", isError: false },
		{ type: "text", text: "Before and after" },
		{ type: "toolCall", id: "tool-2", name: "bash", label: "Following up", arguments: { command: "also private" } },
		{ type: "text", text: "New block" },
	], baselineContent), [
		{ type: "toolCall", id: "tool-1", name: "bash", label: "Checking", arguments: { command: "private" } },
		{ type: "toolResult", toolCallId: "tool-1", result: "private result", isError: false },
		{ type: "text", text: " and after" },
		{ type: "toolCall", id: "tool-2", name: "bash", label: "Following up", arguments: { command: "also private" } },
		{ type: "text", text: "New block" },
	]);
	assert.deepEqual(assistantContentDelta([
		{ type: "toolCall", id: "done", name: "bash", label: "Already done", arguments: {} },
		{ type: "toolResult", toolCallId: "done", result: "same", isError: false },
	], [
		{ type: "toolCall", id: "done", name: "bash", label: "Already done", arguments: {} },
		{ type: "toolResult", toolCallId: "done", result: "same" },
	]), []);
	const finalSseEvents = [];
	for await (const event of readRuntimeSse(new Response('data: {"type":"status","status":"accepted"}'))) {
		finalSseEvents.push(event.type);
	}
	assert.deepEqual(finalSseEvents, ["status"]);

	let receivedMessage: Record<string, unknown> | undefined;
	let receivedStop: Record<string, unknown> | undefined;
	const server = createServer(async (req, res) => {
		if (req.url === "/health") {
			res.writeHead(200);
			res.end("ok");
			return;
		}
		if (req.url === "/api/v2/agents/current/status") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ agent_name: "Example Agent", runtime: "troublemaker", mode: "standalone", workspace_ready: true }));
			return;
		}
		if (req.url?.startsWith("/api/v2/agents/current/events")) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ lines: [historyLine], total: 1, offset: 0 }));
			return;
		}
		if (req.url === "/awareness/stream") {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(`id: message-1\ndata: ${historyLine}\n\n`);
			return;
		}
		if (req.url === "/api/v2/agents/current/messages") {
			receivedMessage = await readJson(req);
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write("data: {\"type\":\"status\",\"status\":\"accepted\"}\n\n");
			res.write("data: {\"type\":\"assistant_snapshot\",\"entry\":{\"id\":\"live\",\"type\":\"message\",\"timestamp\":\"2026-01-02T03:04:06Z\",\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"tool-1\",\"name\":\"bash\",\"label\":\"Checking the workspace\",\"arguments\":{\"command\":\"private\"}},{\"type\":\"text\",\"text\":\"Done.\"}],\"isStreaming\":false}}\n\n");
			res.end("data: [DONE]\n\n");
			return;
		}
		if (req.url === "/api/v2/agents/current/messages/stop") {
			receivedStop = await readJson(req);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address !== "string");
	const client = new TroublemakerTuiClient({
		command: "example-agent",
		name: "Example Agent",
		baseUrl: `http://127.0.0.1:${address.port}`,
		channelId: "terminal:example-agent",
	});
	try {
		const statusResponse = await client.getStatus();
		assert.equal(statusResponse.agentName, "Example Agent");
		assert.equal(statusResponse.workspaceReady, true);
		assert.equal((await client.getBacklog()).lines.length, 1);
		let awarenessConnected = false;
		const awarenessLines: string[] = [];
		await client.streamAwareness(
			(line) => awarenessLines.push(line),
			undefined,
			() => { awarenessConnected = true; },
		);
		assert.equal(awarenessConnected, true);
		assert.deepEqual(awarenessLines, [historyLine]);

		const events: string[] = [];
		await client.streamMessage("hello", (event) => events.push(event.type));
		assert.deepEqual(events, ["status", "assistant_snapshot"]);
		assert.equal(receivedMessage?.message, "hello");
		assert.equal(receivedMessage?.channelId, "terminal:example-agent");
		assert.equal(receivedMessage?.sourceEventType, "terminal_tui");

		await client.stop();
		assert.equal(receivedStop?.channelId, "terminal:example-agent");
	} finally {
		await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
	}

	console.log("troublemaker TUI tests passed");
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	let body = "";
	for await (const chunk of req) body += Buffer.from(chunk).toString("utf8");
	return JSON.parse(body) as Record<string, unknown>;
}
