import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebAdapter } from "../src/adapters/web.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "../src/adapters/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

interface MockResponse {
	statusCode?: number;
	headers?: Record<string, string>;
	body: string;
	ended: boolean;
	writeHead(statusCode: number, headers?: Record<string, string>): void;
	write(chunk: string): void;
	end(chunk?: string): void;
}

function createMockResponse(onEnd: () => void): MockResponse {
	return {
		body: "",
		ended: false,
		writeHead(statusCode, headers) {
			this.statusCode = statusCode;
			this.headers = headers;
		},
		write(chunk) {
			this.body += chunk;
		},
		end(chunk) {
			if (chunk) this.body += chunk;
			this.ended = true;
			onEnd();
		},
	};
}

function dispatch(adapter: WebAdapter, payload: Record<string, unknown>): Promise<MockResponse> {
	return new Promise((resolve) => {
		const req = new EventEmitter() as any;
		req.headers = { "content-type": "application/json" };
		const res = createMockResponse(() => resolve(res));
		adapter.dispatch(req, res as any);
		req.emit("data", Buffer.from(JSON.stringify(payload)));
		req.emit("end");
	});
}

function dispatchStop(adapter: WebAdapter, payload: Record<string, unknown> = {}): Promise<MockResponse> {
	return new Promise((resolve) => {
		const req = new EventEmitter() as any;
		req.headers = { "content-type": "application/json" };
		const res = createMockResponse(() => resolve(res));
		(adapter as any).dispatchStop(req, res as any);
		req.emit("data", Buffer.from(JSON.stringify(payload)));
		req.emit("end");
	});
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function waitFor(predicate: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 1000;
		const tick = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error("timed out waiting for condition"));
				return;
			}
			setTimeout(tick, 0);
		};
		tick();
	});
}

async function run() {
	const workingDir = mkdtempSync(join(tmpdir(), "web-slash-command-"));
	try {
		let running = true;
		let slashCount = 0;
		let eventCount = 0;
		let steerCount = 0;
		let stopCount = 0;
		let lastEvent: MomEvent | undefined;
		const slowSlashGate = deferred();
		let slowSlashStarted = false;

		const handler: MomHandler = {
			isRunning: () => running,
			handleEvent: async (event) => {
				eventCount++;
				lastEvent = event;
			},
			handleSlashCommand: async (event: MomEvent, adapter: PlatformAdapter) => {
				slashCount++;
				if (event.text === "/slow") {
					slowSlashStarted = true;
					await slowSlashGate.promise;
					await adapter.postMessage(event.channel, "slow-ok");
					return true;
				}
				if (event.text === "/fast") {
					await adapter.postMessage(event.channel, "fast-ok");
					return true;
				}
				await adapter.postMessage(event.channel, "slash-ok");
				return true;
			},
			handleSteer: () => {
				steerCount++;
				setTimeout(() => { running = false; }, 10);
			},
			handleStop: async () => {
				stopCount++;
				running = false;
			},
			resolvePendingInput: () => false,
		};

		const adapter = new WebAdapter({ workingDir });
		adapter.setHandler(handler);

		const slashResponse = await dispatch(adapter, { message: "/context" });
		assert(slashResponse.statusCode === 200, "slash command returns an SSE response");
		assert(slashResponse.body.includes('"status":"accepted"'), "web chat emits an immediate accepted status");
		assert(slashResponse.body.includes('"type":"text"'), "slash command emits a text event");
		assert(slashResponse.body.includes("slash-ok"), "slash command response is visible in SSE");
		assert(!slashResponse.body.includes("Already processing"), "slash command bypasses busy rejection");
		assert(slashCount === 1, "slash command handler is called");
		assert(eventCount === 0, "slash command does not start an agent run");

		const slowPromise = dispatch(adapter, { message: "/slow" });
		await waitFor(() => slowSlashStarted);
		const fastResponse = await dispatch(adapter, { message: "/fast" });
		slowSlashGate.resolve();
		const slowResponse = await slowPromise;
		assert(fastResponse.body.includes("fast-ok"), "overlapping fast slash response reaches its own SSE stream");
		assert(!fastResponse.body.includes("slow-ok"), "overlapping fast slash stream does not receive slow response text");
		assert(slowResponse.body.includes("slow-ok"), "overlapping slow slash response is not dropped after fast request completes");
		assert(!slowResponse.body.includes("fast-ok"), "overlapping slow slash stream does not receive fast response text");

		const busyResponse = await dispatch(adapter, { message: "hello" });
		assert(busyResponse.body.includes('"status":"steering"'), "normal busy message emits a steering status");
		assert(steerCount === 1, "normal busy message steers the active run");
		assert(eventCount === 0, "normal busy message does not start an agent run");

		running = false;
		await dispatch(adapter, { message: "hello again" });
		assert(eventCount === 1, "normal idle message starts an agent run");

		await dispatch(adapter, {
			message: "voice turn",
			source: "web-voice",
			channelId: "web-voice",
			fresh_context: true,
			session_id: "voice-session-1",
		});
		assert(eventCount === 2, "fresh voice message starts an agent run");
		assert(lastEvent?.freshContext === true, "fresh voice message carries freshContext into handler");
		assert(lastEvent?.sessionId === "voice-session-1", "fresh voice message carries session id into handler");
		assert(lastEvent?.sourceEventType === "web_voice", "fresh voice message marks source event type");

		await dispatch(adapter, {
			text: "legacy transcript",
			source: "yappatron-mac",
			event_type: "yappatron.utterance.v1",
		});
		assert(eventCount === 3, "legacy finalized transcript starts an idle agent run");
		assert(lastEvent?.sourceEventType === "web_voice", "legacy finalized transcript is classified for configurable voice routing");

		running = true;
		const stopResponse = await dispatchStop(adapter);
		assert(stopResponse.statusCode === 200, "stop endpoint returns JSON success");
		assert(stopResponse.body.includes('"ok":true'), "stop endpoint reports ok");
		assert(stopCount === 1, "stop endpoint calls handler.handleStop");

		console.log(`\n${passed} passed, ${failed} failed`);
		process.exit(failed > 0 ? 1 : 0);
	} finally {
		rmSync(workingDir, { recursive: true, force: true });
	}
}

run().catch((err) => {
	console.error("Test error:", err);
	process.exit(1);
});
