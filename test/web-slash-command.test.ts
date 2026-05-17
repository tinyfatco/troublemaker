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
		const res = createMockResponse(() => resolve(res));
		adapter.dispatch(req, res as any);
		req.emit("data", Buffer.from(JSON.stringify(payload)));
		req.emit("end");
	});
}

async function run() {
	const workingDir = mkdtempSync(join(tmpdir(), "web-slash-command-"));
	try {
		let running = true;
		let slashCount = 0;
		let eventCount = 0;

		const handler: MomHandler = {
			isRunning: () => running,
			handleEvent: async () => {
				eventCount++;
			},
			handleSlashCommand: async (event: MomEvent, adapter: PlatformAdapter) => {
				slashCount++;
				await adapter.postMessage(event.channel, "slash-ok");
				return true;
			},
			handleSteer: () => {},
			handleStop: async () => {},
			resolvePendingInput: () => false,
		};

		const adapter = new WebAdapter({ workingDir });
		adapter.setHandler(handler);

		const slashResponse = await dispatch(adapter, { message: "/context" });
		assert(slashResponse.statusCode === 200, "slash command returns an SSE response");
		assert(slashResponse.body.includes('"type":"text"'), "slash command emits a text event");
		assert(slashResponse.body.includes("slash-ok"), "slash command response is visible in SSE");
		assert(!slashResponse.body.includes("Already processing"), "slash command bypasses busy rejection");
		assert(slashCount === 1, "slash command handler is called");
		assert(eventCount === 0, "slash command does not start an agent run");

		const busyResponse = await dispatch(adapter, { message: "hello" });
		assert(busyResponse.body.includes('"type":"error"'), "normal busy message emits an error");
		assert(busyResponse.body.includes("Already processing"), "normal busy message is rejected");
		assert(eventCount === 0, "normal busy message does not start an agent run");

		running = false;
		await dispatch(adapter, { message: "hello again" });
		assert(eventCount === 1, "normal idle message starts an agent run");

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
