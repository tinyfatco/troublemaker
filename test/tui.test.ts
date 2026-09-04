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
import {
	assistantContentDelta,
	getAmbientDisplayLines,
	isAssistantContentCoveredBySnapshot,
	normalizeChannelLabel,
	parseContextLine,
	parseInterruptBatchMessages,
	readRuntimeSse,
	safeToolLabel,
} from "../src/tui/protocol.js";
import {
	compactFollowUpCheckpoint,
	isCompactFollowUpInput,
	parseVisibleUserInputs,
	sanitizeGeneratedFollowUpSessionLine,
} from "../src/user-input-display.js";

const tempRoot = await mkdtemp(join(tmpdir(), "troublemaker-tui-test-"));

try {
	const appSource = await readFile(new URL("../src/tui/app.ts", import.meta.url), "utf8");
	assert.doesNotMatch(appSource, /command === "\/clear"/, "TUI forwards /clear to the resident instead of clearing only its display");
	assert.match(appSource, /\/clear  archive and reset agent context/, "TUI help describes the resident-side clear behavior");

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
	assert.deepEqual(parseVisibleUserInputs(JSON.parse(historyLine).message.content[0].text), [{
		channel: "#general",
		userName: "Taylor",
		text: "hello there",
	}], "live input projection strips private session and delivery scaffolding");
	assert.deepEqual(parseVisibleUserInputs("<delivery_context>private route</delivery_context>\n\n[2026-07-25 20:03:46-05:00] [zulip:10:topic:general%20chat] [Alex]: @**Batman** report exact source state"), [{
		channel: "zulip:10:topic:general%20chat",
		userName: "Alex",
		text: "@**Batman** report exact source state",
	}], "Zulip mention inputs are projected before their assistant output");
	assert.deepEqual(parseVisibleUserInputs("<session_context>private runtime context</session_context>\n\n[2026-07-25 19:47:18-05:00] [terminal:ghost] [goal]: [GOAL CONTINUATION]\nThe previous turn became idle while this goal remained active.\n\nAutomatic goal turn: 1"), [{
		channel: "terminal:ghost",
		userName: "goal",
		text: "[GOAL CONTINUATION]\nThe previous turn became idle while this goal remained active.\n\nAutomatic goal turn: 1",
	}], "automatic goal continuation is projected as ordered visible input");
	const followUpPrompt = "[ATTENTION:follow-up-agent-global-00000000-0000-0000-0000-000000000000-1.json:one-shot:2040-01-01T00:01:00.000Z] [FOLLOW_UP 1/4 after 1 minute since the latest completed wake]\nThis is an agent-global internal checkpoint. It does not belong to any conversation and carries no assumed reply target.\nReview open loops across the agent. Use list_channels and read_thread when useful to recover the current context before acting.\nIf one concise, natural follow-up is still useful, call send_message exactly once with the appropriate explicit target. Otherwise call yield_no_action.\nDo not emit ordinary assistant text.";
	assert.deepEqual(parseVisibleUserInputs(`[2026-01-02 03:04:05+00:00] [follow-up] [follow-up]: ${followUpPrompt}`), [{
		channel: "follow-up",
		userName: "follow-up",
		text: "Follow-up 1/4 · 1m",
	}], "generated follow-up prompts collapse to one terminal line");
	assert.equal(
		compactFollowUpCheckpoint("[FOLLOW_UP 1/4 after 1 minute since the latest completed wake] user-authored text"),
		"[FOLLOW_UP 1/4 after 1 minute since the latest completed wake] user-authored text",
		"ordinary text that resembles a follow-up marker is preserved",
	);
	assert.equal(
		parseVisibleUserInputs(`[2026-01-02 03:04:05+00:00] [terminal:example-agent] [Casey]: ${followUpPrompt}`)[0]?.text,
		followUpPrompt,
		"a user pasting the complete marker outside the internal follow-up lane is preserved",
	);
	const parsedFollowUpHistory = parseContextLine(JSON.stringify({
		type: "message",
		id: "follow-up-history",
		timestamp: "2026-01-02T03:04:05Z",
		message: { role: "user", content: [{ type: "text", text: `[2026-01-02 03:04:05+00:00] [follow-up] [follow-up]: ${followUpPrompt}` }] },
	}));
	assert.equal(parsedFollowUpHistory?.text, "Follow-up 1/4 · 1m", "durable follow-up history uses the same compact display");
	const persistedFollowUpLine = JSON.stringify({
		type: "message",
		id: "follow-up-history",
		timestamp: "2026-01-02T03:04:05Z",
		message: {
			role: "user",
			content: [{
				type: "text",
				text: `<session_context>private current state</session_context>\n\n<delivery_context>private route</delivery_context>\n\n[2026-01-02 03:04:05+00:00] [follow-up] [follow-up]: ${followUpPrompt}`,
			}],
		},
	});
	const projectedFollowUpLine = sanitizeGeneratedFollowUpSessionLine(persistedFollowUpLine);
	assert.equal(
		JSON.parse(projectedFollowUpLine).message.content[0].text,
		"[2026-01-02 03:04:05+00:00] [follow-up] [follow-up]: Follow-up 1/4 · 1m",
		"server-side awareness projection protects stale terminal clients from the full generated prompt",
	);
	assert.equal(
		sanitizeGeneratedFollowUpSessionLine(historyLine),
		historyLine,
		"ordinary user history remains byte-identical",
	);
	assert.equal(
		sanitizeGeneratedFollowUpSessionLine(JSON.stringify({
			type: "message",
			message: { role: "user", content: `[2026-01-02 03:04:05+00:00] [terminal:example-agent] [Casey]: ${followUpPrompt}` },
		})),
		JSON.stringify({
			type: "message",
			message: { role: "user", content: `[2026-01-02 03:04:05+00:00] [terminal:example-agent] [Casey]: ${followUpPrompt}` },
		}),
		"user-authored lookalikes outside the internal follow-up lane remain byte-identical",
	);
	assert.equal(sanitizeGeneratedFollowUpSessionLine("not json"), "not json", "unrelated malformed lines remain unchanged");
	assert.equal(
		sanitizeGeneratedFollowUpSessionLine(`not json ${followUpPrompt}`),
		JSON.stringify({ type: "custom", customType: "troublemaker.generated-follow-up-redacted", display: false }),
		"malformed generated follow-up candidates fail closed without exposing the harness",
	);
	const multiBlockFollowUp = JSON.parse(persistedFollowUpLine);
	multiBlockFollowUp.message.content.push({ type: "text", text: "PRIVATE EXTRA BLOCK" });
	assert.deepEqual(
		JSON.parse(sanitizeGeneratedFollowUpSessionLine(JSON.stringify(multiBlockFollowUp))).message.content,
		[{ type: "text", text: "[2026-01-02 03:04:05+00:00] [follow-up] [follow-up]: Follow-up 1/4 · 1m" }],
		"recognized generated follow-ups project one bounded text block only",
	);
	assert.equal(isCompactFollowUpInput({ channel: "follow-up", userName: "follow-up", text: "Follow-up 1/4 · 1m" }), true);
	assert.equal(isCompactFollowUpInput({ channel: "terminal:example-agent", userName: "Casey", text: "Follow-up 1/4 · 1m" }), false);
	assert.match(
		appSource,
		/if \(isCompactFollowUpInput\(\{ channel, userName: user, text \}\)\) \{[\s\S]*?new Text\(chalk\.dim\(text\)/,
		"generated follow-ups render as one dim terminal line without a repeated channel/user header",
	);
	assert.match(appSource, /liveView\?\.generatedFollowUps\.has\(entry\.text\)/, "one live run cannot repaint the same generated follow-up");
	const ambientPrompt = `[AMBIENT] A conversation is happening in slack:#biz. New unseen, complete messages since your last ambient wake:\n\n<ambient_messages>\nCasey (U123) [Reply target: slack:C123:1; message_ts: 2; thread_ts: 1]: ship the fix <@U456>\nObserver (U456): on it\n</ambient_messages>\n\nChannel pulse: 2 messages in last 15min.\n\nYou're observing this conversation naturally.`;
	assert.deepEqual(parseVisibleUserInputs(`[2026-01-02 03:04:05+00:00] [#general] [ambient]: ${ambientPrompt}`), [], "ambient evaluation scaffolding never enters the live input feed");
	assert.deepEqual(getAmbientDisplayLines(ambientPrompt), ["Casey: ship the fix <@U456>", "Observer: on it"]);
	const parsedAmbient = parseContextLine(JSON.stringify({
		type: "message",
		id: "ambient-current",
		parentId: "ambient-parent",
		timestamp: "2026-01-02T03:04:05Z",
		message: { role: "user", content: [{ type: "text", text: `<session_context>\nUsers:\nU123\t@casey\tCasey\nU456\t@observer\tObserver\nSkills:\n(none)\n</session_context>\n\n[2026-01-02 03:04:05+00:00] [biz] [unknown]: ${ambientPrompt}` }] },
	}));
	assert.equal(parsedAmbient?.channel, "slack:#biz");
	assert.equal(parsedAmbient?.parentId, "ambient-parent");
	assert.equal(parsedAmbient?.userName, "ambient");
	assert.equal(parsedAmbient?.text, "Casey: ship the fix @observer\nObserver: on it");
	assert.equal(parsedAmbient?.isAmbient, true);
	const parsedBareSteeredAmbient = parseContextLine(JSON.stringify({
		type: "message",
		id: "ambient-bare-steer",
		parentId: "ambient-parent",
		timestamp: "2026-01-02T03:04:06Z",
		message: { role: "user", content: [{ type: "text", text: `<session_context>\nUsers:\nU123\t@casey\tCasey\nU456\t@observer\tObserver\nSkills:\n(none)\n</session_context>\n\n${ambientPrompt}` }] },
	}));
	assert.equal(parsedBareSteeredAmbient?.channel, "slack:#biz");
	assert.equal(parsedBareSteeredAmbient?.userName, "ambient");
	assert.equal(parsedBareSteeredAmbient?.text, "Casey: ship the fix @observer\nObserver: on it");
	assert.equal(parsedBareSteeredAmbient?.isAmbient, true);
	assert(!parsedBareSteeredAmbient?.text?.includes("Channel pulse:"), "bare steered ambient prompts hide pulse and control scaffolding");
	assert(!parsedBareSteeredAmbient?.text?.includes("Reply target:"), "bare steered ambient prompts hide routing metadata");
	const interruptBatch = `Recent messages:\n[2026-07-17 16:10:59-05:00] [terminal:local-agent] [terminal-user]: Sent\n[2026-07-17 16:12:32-05:00] [terminal:local-agent] [terminal-user]: Local Agent please open Mattermost\nand keep working`;
	assert.deepEqual(parseInterruptBatchMessages(interruptBatch), [
		{ channel: "terminal:local-agent", userName: "terminal-user", text: "Sent" },
		{ channel: "terminal:local-agent", userName: "terminal-user", text: "Local Agent please open Mattermost\nand keep working" },
	]);
	const parsedInterruptBatch = parseContextLine(JSON.stringify({
		type: "message",
		id: "compaction-delayed-interrupt-batch",
		timestamp: "2026-07-17T21:14:40Z",
		message: { role: "user", content: [{ type: "text", text: `[2026-07-17 16:14:40-05:00] [terminal:local-agent] [terminal-user]: ${interruptBatch}` }] },
	}));
	assert.equal(parsedInterruptBatch?.text, undefined, "synthetic interrupt batches do not render as one raw user block");
	assert.equal(parsedInterruptBatch?.batchedUserEntries?.length, 2, "synthetic interrupt batches retain individual messages for echo filtering");
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
	const cumulativeSnapshot = [
		{ type: "toolCall" as const, id: "tool-1", name: "read", label: "First check", arguments: {} },
		{ type: "toolResult" as const, toolCallId: "tool-1", result: "", isError: false },
		{ type: "toolCall" as const, id: "tool-2", name: "edit", label: "Second check", arguments: {} },
		{ type: "text" as const, text: "Visible update" },
	];
	assert.equal(isAssistantContentCoveredBySnapshot([
		{ type: "toolCall", id: "tool-2", name: "edit", label: "Second check", arguments: {} },
	], cumulativeSnapshot), true, "a durable tool turn matches its identity inside a cumulative live snapshot");
	assert.equal(isAssistantContentCoveredBySnapshot([
		{ type: "text", text: "Visible update" },
	], cumulativeSnapshot), true, "a durable text turn matches its exact visible block inside a cumulative live snapshot");
	assert.equal(isAssistantContentCoveredBySnapshot([
		{ type: "toolCall", id: "different-tool", name: "edit", label: "Second check", arguments: {} },
	], cumulativeSnapshot), false, "matching labels cannot hide a distinct tool call");
	assert.equal(isAssistantContentCoveredBySnapshot([
		{ type: "toolCall", id: "", name: "edit", label: "Second check", arguments: {} },
	], cumulativeSnapshot), false, "a durable tool without a stable identity is never hidden");
	assert.equal(isAssistantContentCoveredBySnapshot([
		{ type: "text", text: "Different update" },
	], cumulativeSnapshot), false, "different assistant text remains visible");
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
		if (req.url === "/status") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ running: ["awareness"], idle: false, activeRun: "external run" }));
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
		assert.equal((await client.getRunStatus()).idle, false);
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
