import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAdapter } from "../src/adapters/web.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "../src/adapters/types.js";

interface MockResponse {
	statusCode?: number;
	headers?: Record<string, string>;
	body: string;
	ended: boolean;
	writeHead(statusCode: number, headers?: Record<string, string>): void;
	write(chunk: string): void;
	end(chunk?: string): void;
	flushHeaders?: () => void;
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
		flushHeaders() {},
	};
}

function startDispatch(adapter: WebAdapter, payload: Record<string, unknown>): { res: MockResponse; done: Promise<MockResponse> } {
	let resolveDone!: (res: MockResponse) => void;
	const done = new Promise<MockResponse>((resolve) => {
		resolveDone = resolve;
	});
	const req = new EventEmitter() as any;
	const res = createMockResponse(() => resolveDone(res));
	adapter.dispatch(req, res as any);
	req.emit("data", Buffer.from(JSON.stringify(payload)));
	req.emit("end");
	return { res, done };
}

async function dispatch(adapter: WebAdapter, payload: Record<string, unknown>): Promise<MockResponse> {
	return startDispatch(adapter, payload).done;
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

function createLoginAdapter(): WebAdapter {
	const workingDir = mkdtempSync(join(tmpdir(), "web-login-command-"));
	let resolveInput: ((text: string) => void) | undefined;
	let rejectInput: ((err: Error) => void) | undefined;

	const handler: MomHandler = {
		isRunning: () => false,
		handleEvent: async () => {
			throw new Error("login test should not start an agent run");
		},
		handleSlashCommand: async (event: MomEvent, adapter: PlatformAdapter) => {
			if (event.text !== "/login openai-codex") return false;
			const inputPromise = new Promise<string>((resolve, reject) => {
				resolveInput = resolve;
				rejectInput = reject;
			});
			const pending = (async () => {
				try {
					await adapter.postMessage(event.channel, "AUTH_URL");
					const input = await inputPromise;
					await adapter.postMessage(event.channel, `LOGIN_OK ${input}`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					await adapter.postMessage(event.channel, `LOGIN_CANCELLED ${msg}`);
				}
			})();
			return { handled: true, pending };
		},
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: (_channelId, text) => {
			if (!resolveInput && !rejectInput) return false;
			if (text.trim().toLowerCase() === "/cancel") {
				rejectInput?.(new Error("Cancelled"));
			} else {
				resolveInput?.(text);
			}
			resolveInput = undefined;
			rejectInput = undefined;
			return true;
		},
	};

	const adapter = new WebAdapter({ workingDir });
	adapter.setHandler(handler);

	const cleanup = adapter.stop.bind(adapter);
	(adapter as any).stop = async () => {
		await cleanup();
		rmSync(workingDir, { recursive: true, force: true });
	};

	return adapter;
}

async function run() {
	const adapter = createLoginAdapter();
	try {
		const login = startDispatch(adapter, { message: "/login openai-codex" });
		await waitFor(() => login.res.body.includes("AUTH_URL"));
		assert.equal(login.res.ended, false, "login SSE should stay open while waiting for callback input");

		const callback = await dispatch(adapter, { message: "http://localhost:1455/auth/callback?code=abc&state=xyz" });
		assert.equal(callback.ended, true, "callback input request should finish immediately");

		const loginResponse = await login.done;
		assert(loginResponse.body.includes("LOGIN_OK http://localhost:1455/auth/callback?code=abc&state=xyz"));
		assert(loginResponse.body.includes("data: [DONE]"));

		const cancelLogin = startDispatch(adapter, { message: "/login openai-codex" });
		await waitFor(() => cancelLogin.res.body.includes("AUTH_URL"));
		await dispatch(adapter, { message: "/cancel" });

		const cancelResponse = await cancelLogin.done;
		assert(cancelResponse.body.includes("LOGIN_CANCELLED Cancelled"));
		assert(cancelResponse.body.includes("data: [DONE]"));

		console.log("web login command stays attached through callback and cancel");
	} finally {
		await adapter.stop();
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
