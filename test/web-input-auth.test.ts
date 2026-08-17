import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WebAdapter } from "../src/adapters/web.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		passed++;
		console.log(`  ✓ ${message}`);
	} else {
		failed++;
		console.error(`  ✗ ${message}`);
	}
}

interface MockResponse {
	statusCode?: number;
	body: string;
	ended: boolean;
	writeHead(statusCode: number): void;
	write(chunk: string): void;
	end(chunk?: string): void;
	flushHeaders(): void;
}

function createResponse(resolve: (response: MockResponse) => void): MockResponse {
	return {
		body: "",
		ended: false,
		writeHead(statusCode) {
			this.statusCode = statusCode;
		},
		write(chunk) {
			this.body += chunk;
		},
		end(chunk) {
			if (chunk) this.body += chunk;
			this.ended = true;
			resolve(this);
		},
		flushHeaders() {},
	};
}

function request(
	adapter: WebAdapter,
	method: "dispatch" | "dispatchWebhook" | "dispatchStop",
	payload: Record<string, unknown>,
	authorization?: string,
): Promise<MockResponse> {
	return new Promise((resolve) => {
		const req = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
		req.headers = authorization ? { authorization } : {};
		const res = createResponse(resolve);
		adapter[method](req as never, res as never);
		req.emit("data", Buffer.from(JSON.stringify(payload)));
		req.emit("end");
	});
}

function handler(onEvent: (event: MomEvent) => void, onStop: () => void): MomHandler {
	return {
		isRunning: () => false,
		handleEvent: async (event) => onEvent(event),
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => onStop(),
		resolvePendingInput: () => false,
	};
}

async function run(): Promise<void> {
	const workingDir = mkdtempSync(join(tmpdir(), "web-input-auth-"));
	try {
		let openEvents = 0;
		const open = new WebAdapter({ workingDir });
		open.setHandler(handler(() => openEvents++, () => {}));
		const openResponse = await request(open, "dispatch", { message: "legacy open input" });
		assert(openResponse.statusCode === 200, "unset token preserves existing open input behavior");
		assert(openEvents === 1, "unset token still reaches the event handler");

		let protectedEvents = 0;
		let lastProtectedEvent: MomEvent | undefined;
		let protectedStops = 0;
		const token = "test-token-1234567890";
		const protectedAdapter = new WebAdapter({ workingDir, inputToken: token });
		protectedAdapter.setHandler(handler((event) => {
			protectedEvents++;
			lastProtectedEvent = event;
		}, () => protectedStops++));

		const missing = await request(protectedAdapter, "dispatch", { message: "missing" });
		assert(missing.statusCode === 401, "missing bearer token is rejected");
		assert(missing.body === '{"ok":false,"error":"Unauthorized"}', "rejection does not disclose token details");
		assert(protectedEvents === 0, "missing token never reaches the handler");

		const wrong = await request(protectedAdapter, "dispatch", { message: "wrong" }, "Bearer test-token-1234567891");
		assert(wrong.statusCode === 401, "wrong same-length bearer token is rejected");
		assert(protectedEvents === 0, "wrong token never reaches the handler");

		const malformed = await request(protectedAdapter, "dispatch", { message: "malformed" }, token);
		assert(malformed.statusCode === 401, "non-Bearer authorization is rejected");

		const accepted = await request(protectedAdapter, "dispatch", {
			message: "accepted",
			deliveryId: "delivery-example-auth",
		}, `Bearer ${token}`);
		assert(accepted.statusCode === 200, "correct bearer token reaches synchronous web input");
		assert(accepted.body.includes("[DONE]"), "authenticated synchronous input completes its SSE turn");
		assert(protectedEvents === 1, "correct bearer token reaches the event handler exactly once");
		assert(lastProtectedEvent?.deliveryId === "delivery-example-auth", "validated delivery identity reaches the generic event contract exactly");

		const invalidDelivery = await request(protectedAdapter, "dispatch", {
			message: "invalid delivery",
			deliveryId: "bad id",
		}, `Bearer ${token}`);
		assert(invalidDelivery.statusCode === 400, "malformed delivery identity fails closed");
		assert(protectedEvents === 1, "malformed delivery identity never reaches the handler");

		const webhookMissing = await request(protectedAdapter, "dispatchWebhook", { message: "missing webhook" });
		assert(webhookMissing.statusCode === 401, "asynchronous webhook also rejects a missing token");

		const webhookAccepted = await request(protectedAdapter, "dispatchWebhook", { message: "accepted webhook" }, `Bearer ${token}`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert(webhookAccepted.statusCode === 202, "correct token reaches asynchronous webhook input");
		assert(protectedEvents === 2, "authenticated webhook reaches the event handler exactly once");

		const stopMissing = await request(protectedAdapter, "dispatchStop", {});
		assert(stopMissing.statusCode === 401, "stop input rejects a missing token");
		const stopAccepted = await request(protectedAdapter, "dispatchStop", {}, `Bearer ${token}`);
		assert(stopAccepted.statusCode === 200, "stop input accepts the correct token");
		assert(protectedStops === 1, "authenticated stop reaches the stop handler exactly once");
	} finally {
		rmSync(workingDir, { recursive: true, force: true });
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

run().catch((error) => {
	console.error(error);
	process.exit(1);
});
