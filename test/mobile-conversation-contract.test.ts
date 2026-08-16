import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAdapter } from "../src/adapters/web.js";
import type { MomHandler } from "../src/adapters/types.js";
import {
	projectConversationBacklog,
	projectConversationLine,
	projectConversationLiveEvent,
	projectConversationTurnEvent,
} from "../src/console/conversation-projection.js";
import { Gateway } from "../src/gateway.js";

const privateUserLine = JSON.stringify({
	type: "message",
	id: "user-one",
	timestamp: "2026-01-01T00:00:00Z",
	message: {
		role: "user",
		content: [{
			type: "text",
			text: "<session_context>PRIVATE_SESSION</session_context>\n[2026-01-01] [voice] [Casey]: Exact human text",
		}],
	},
});
const privateAssistantLine = JSON.stringify({
	type: "message",
	id: "assistant-one",
	timestamp: "2026-01-01T00:01:00Z",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "PRIVATE_THINKING" },
			{ type: "toolCall", id: "tool-one", name: "bash", arguments: { command: "PRIVATE_ARGUMENT" } },
			{ type: "toolResult", toolCallId: "tool-one", result: "PRIVATE_RESULT" },
			{ type: "text", text: "Exact assistant text" },
		],
	},
});
const exactErrorLine = JSON.stringify({
	type: "message",
	id: "assistant-error",
	timestamp: "2026-01-01T00:02:00Z",
	message: {
		role: "assistant",
		stopReason: "error",
		content: [{ type: "text", text: "Proxy returned HTTP 500: exact body" }],
	},
});

const projectedUser = projectConversationLine(privateUserLine);
assert.equal(projectedUser?.text, "Exact human text");
assert.equal(projectedUser?.channel, "voice");
assert.equal(projectedUser?.userName, "Casey");
assert.equal(JSON.stringify(projectedUser).includes("PRIVATE_SESSION"), false);

const projectedAssistant = projectConversationLine(privateAssistantLine);
assert.equal(projectedAssistant?.text, "Exact assistant text");
assert.equal(projectedAssistant?.speechEligible, true);
assert.doesNotMatch(JSON.stringify(projectedAssistant), /PRIVATE_(THINKING|ARGUMENT|RESULT)/);

const projectedError = projectConversationLine(exactErrorLine);
assert.equal(projectedError?.text, "Proxy returned HTTP 500: exact body");
assert.equal(projectedError?.isError, true);
assert.equal(projectedError?.speechEligible, false);

const backlog = projectConversationBacklog({
	lines: [privateUserLine, privateAssistantLine, exactErrorLine, JSON.stringify({ type: "session", id: "session-one" })],
	total: 4,
	offset: 0,
});
assert.equal(backlog.messages.length, 3);
assert.equal(backlog.total, 4);

const projectedLive = projectConversationLiveEvent({
	kind: "runtime",
	sequence: 7,
	streamId: "stream-one",
	id: "event-one",
	timestamp: "2026-01-01T00:03:00Z",
	runId: "run-one",
	channelId: "ios",
	event: {
		type: "assistant_snapshot",
		entry: {
			id: "live-assistant",
			type: "message",
			timestamp: "2026-01-01T00:03:00Z",
			role: "assistant",
			isStreaming: false,
			content: [
				{ type: "thinking", thinking: "PRIVATE_LIVE_THINKING" },
				{ type: "toolCall", id: "tool-two", name: "bash", arguments: { command: "PRIVATE_LIVE_ARGUMENT" } },
				{ type: "text", text: "Exact live assistant text" },
			],
		},
	},
});
assert.equal(projectedLive.kind, "assistant");
assert.match(JSON.stringify(projectedLive), /Exact live assistant text/);
assert.doesNotMatch(JSON.stringify(projectedLive), /PRIVATE_LIVE/);

const projectedToolTurn = projectConversationTurnEvent({
	type: "toolCall",
	name: "bash",
	arguments: { command: "PRIVATE_TURN_ARGUMENT" },
});
assert.deepEqual(projectedToolTurn, { type: "state", state: "thinking" });

const workspace = mkdtempSync(join(tmpdir(), "troublemaker-mobile-contract-"));
try {
	mkdirSync(join(workspace, "awareness"), { recursive: true });
	writeFileSync(join(workspace, "settings.json"), JSON.stringify({
		name: "Example Agent",
		localAgentId: "agent-example",
	}));
	writeFileSync(join(workspace, "awareness", "context.jsonl"), `${privateUserLine}\n${privateAssistantLine}\n`);

	const gateway = new Gateway({ workspaceDir: workspace });
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await gateway.start(port, "127.0.0.1");
	try {
		const valid = await fetch(`http://127.0.0.1:${port}/api/v2/agents/agent-example/status`);
		assert.equal(valid.status, 200, "the bound agent id is accepted");
		const alias = await fetch(`http://127.0.0.1:${port}/api/v2/agents/current/status`);
		assert.equal(alias.status, 200, "the standalone current alias remains accepted");
		const wrong = await fetch(`http://127.0.0.1:${port}/api/v2/agents/other-agent/status`);
		assert.equal(wrong.status, 404, "an unbound agent id cannot alias the resident");

		const response = await fetch(
			`http://127.0.0.1:${port}/api/v2/agents/agent-example/events?limit=20&surface=conversation`,
		);
		const body = await response.text();
		assert.equal(response.status, 200);
		assert.match(body, /Exact human text/);
		assert.match(body, /Exact assistant text/);
		assert.doesNotMatch(body, /PRIVATE_(SESSION|THINKING|ARGUMENT|RESULT)/);
	} finally {
		await gateway.stop();
	}

	let handled = 0;
	let adapter!: WebAdapter;
	const handler: MomHandler = {
		isRunning: () => false,
		handleEvent: async (event) => {
			handled++;
			const context = adapter.createContext(event, {} as never);
			context.emitContentBlock?.({ type: "thinking", thinking: "PRIVATE_TURN_THINKING" });
			context.emitContentBlock?.({ type: "toolCall", name: "bash", arguments: { command: "PRIVATE_TURN_ARGUMENT" } });
			context.emitContentBlock?.({ type: "text", text: "Exact streamed answer" });
			await context.setWorking(false);
		},
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
	adapter = new WebAdapter({ workingDir: workspace });
	adapter.setHandler(handler);

	const deliveryId = "mobile-delivery-one";
	const first = await dispatch(adapter, { message: "hello", channelId: "ios", deliveryId });
	assert.equal(first.statusCode, 200);
	assert.match(first.body, /"disposition":"accepted"/);
	assert.match(first.body, /Exact streamed answer/);
	assert.doesNotMatch(first.body, /PRIVATE_TURN/);
	assert.equal(handled, 1);

	const duplicate = await dispatch(adapter, { message: "hello", channelId: "ios", deliveryId });
	assert.match(duplicate.body, /"disposition":"duplicate"/);
	assert.equal(handled, 1, "a repeated durable delivery id never launches a second turn");
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

console.log("mobile conversation contract: ok");

interface MockResponse {
	statusCode: number;
	body: string;
	writeHead(status: number): void;
	write(chunk: string): void;
	end(chunk?: string): void;
	flushHeaders(): void;
}

function dispatch(adapter: WebAdapter, payload: Record<string, unknown>): Promise<MockResponse> {
	return new Promise((resolve) => {
		const request = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
		request.headers = { "x-troublemaker-surface": "conversation" };
		const response: MockResponse = {
			statusCode: 0,
			body: "",
			writeHead(status) { this.statusCode = status; },
			write(chunk) { this.body += chunk; },
			end(chunk) {
				if (chunk) this.body += chunk;
				resolve(this);
			},
			flushHeaders() {},
		};
		adapter.dispatch(request as never, response as never);
		request.emit("data", Buffer.from(JSON.stringify(payload)));
		request.emit("end");
	});
}
