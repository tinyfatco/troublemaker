import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	createOwnedWorkCanaryBarrier,
	validateOwnedWorkCanaryAuthorization,
	type OwnedWorkCanaryAuthorization,
} from "../src/adapters/owned-work-canary.js";
import { routeWorkspaceChannelEvent, WorkspaceChannelQueue } from "../src/adapters/workspace-channel-runtime.js";

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(now = Date.now()): { authorization: OwnedWorkCanaryAuthorization; binding: Parameters<typeof validateOwnedWorkCanaryAuthorization>[1] } {
	const body = "@**Resident** neutral diagnostic request";
	const authorization: OwnedWorkCanaryAuthorization = {
		version: 1,
		nonce: "neutral-nonce",
		contextId: "context-neutral",
		deliveryId: "delivery-neutral",
		source: "zulip",
		senderId: 42,
		channelId: "7",
		topic: "diagnostic topic",
		bodySha256: "dc71dc316bd77a684fbaac5ceb7a337ee392a18a7c7c9e6489c9b5576f9298c3",
		expiresAt: new Date(now + 60_000).toISOString(),
		candidateSha: "a".repeat(40),
		leaseSeconds: 5,
		deadlineMs: 30_000,
	};
	return {
		authorization,
		binding: {
			contextId: authorization.contextId,
			deliveryId: authorization.deliveryId,
			senderId: authorization.senderId,
			channelId: authorization.channelId,
			topic: authorization.topic,
			body,
			runtimeVersion: `${authorization.candidateSha}-diagnostic`,
		},
	};
}

test("owned-work authorization is exact, scoped, expiring, and non-control", () => {
	const now = Date.now();
	const { authorization, binding } = fixture(now);
	assert.deepEqual(validateOwnedWorkCanaryAuthorization(authorization, binding, now), authorization);
	for (const [name, mutate] of [
		["context", (value: typeof authorization) => { value.contextId += "-wrong"; }],
		["delivery", (value: typeof authorization) => { value.deliveryId += "-wrong"; }],
		["sender", (value: typeof authorization) => { value.senderId += 1; }],
		["channel", (value: typeof authorization) => { value.channelId = "8"; }],
		["topic", (value: typeof authorization) => { value.topic += " wrong"; }],
		["body", (value: typeof authorization) => { value.bodySha256 = "b".repeat(64); }],
		["candidate", (value: typeof authorization) => { value.candidateSha = "b".repeat(40); }],
	] as const) {
		const changed = structuredClone(authorization);
		mutate(changed);
		assert.throws(
			() => validateOwnedWorkCanaryAuthorization(changed, binding, now),
			/owned_work_canary_binding_mismatch/,
			name,
		);
	}
	assert.throws(
		() => validateOwnedWorkCanaryAuthorization(
			{ ...authorization, expiresAt: new Date(now - 1).toISOString() },
			binding,
			now,
		),
		/owned_work_canary_expired/,
	);
	assert.throws(
		() => validateOwnedWorkCanaryAuthorization(authorization, { ...binding, body: "/status" }, now),
		/owned_work_canary_control_body_denied/,
	);
});

test("controller enforces response, stale receipt, work, and settlement order", async () => {
	const directory = mkdtempSync(join(tmpdir(), "owned-work-canary-"));
	temporary.push(directory);
	const socketPath = join(directory, "control.sock");
	const { authorization } = fixture();
	const phases: string[] = [];
	let client: Socket | undefined;
	let buffer = "";
	const serverClosed = Promise.withResolvers<void>();
	const server = createServer((socket) => {
		client = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				const frame = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
				buffer = buffer.slice(index + 1);
				if (frame.type === "consume") {
					socket.write(`${JSON.stringify({ v: 1, type: "armed", nonce: authorization.nonce })}\n`);
					continue;
				}
				const phase = String(frame.phase);
				phases.push(phase);
				const waiting = new Set(phases.filter((value) => value.endsWith("_waiting")));
				if (waiting.size === 3 && !phases.includes("release_response_sent")) {
					phases.push("release_response_sent");
					socket.write(`${JSON.stringify({ v: 1, type: "release_response", nonce: authorization.nonce })}\n`);
				} else if (phase === "response_released") {
					socket.write(`${JSON.stringify({ v: 1, type: "release_receipt", nonce: authorization.nonce })}\n`);
				} else if (phase === "receipt_rejected") {
					socket.write(`${JSON.stringify({ v: 1, type: "release_work", nonce: authorization.nonce })}\n`);
				}
			}
		});
		socket.on("close", () => serverClosed.resolve());
	});
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	chmodSync(socketPath, 0o660);
	const barrier = await createOwnedWorkCanaryBarrier(authorization, { socketPath });
	const response = barrier.holdResponse();
	const receipt = barrier.holdReceipt();
	const work = barrier.holdWork();
	await response;
	await receipt;
	await barrier.receiptRejected(new Error("host receipt returned HTTP 409"));
	await work;
	await barrier.workSettled();
	await barrier.dispose();
	await serverClosed.promise;
	server.close();
	client?.destroy();
	assert.deepEqual(phases.filter((value) => !value.endsWith("_waiting") && !value.endsWith("_sent")), [
		"response_released",
		"receipt_released",
		"receipt_rejected",
		"work_released",
		"work_settled",
		"route_settled",
	]);
});

test("controller aborts closed on a premature command and cannot be reused", async () => {
	const directory = mkdtempSync(join(tmpdir(), "owned-work-canary-"));
	temporary.push(directory);
	const socketPath = join(directory, "control.sock");
	const { authorization } = fixture();
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			socket.write(`${JSON.stringify({ v: 1, type: "armed", nonce: authorization.nonce })}\n`);
			socket.write(`${JSON.stringify({ v: 1, type: "release_work", nonce: authorization.nonce })}\n`);
		});
	});
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	chmodSync(socketPath, 0o660);
	const barrier = await createOwnedWorkCanaryBarrier(authorization, { socketPath });
	await assert.rejects(barrier.holdWork(), /owned_work_canary_protocol_order/);
	await assert.rejects(barrier.holdWork(), /owned_work_canary_work_reused/);
	await barrier.dispose();
	server.close();
});


test("route keeps owned work observed and settles it before outer receipt reporting", async () => {
	const receiptGate = Promise.withResolvers<void>();
	const workGate = Promise.withResolvers<void>();
	const phases: string[] = [];
	const unhandled: unknown[] = [];
	const handled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	const onHandled = (error: unknown) => handled.push(error);
	process.on("unhandledRejection", onUnhandled);
	process.on("rejectionHandled", onHandled);
	try {
		const queue = new WorkspaceChannelQueue((error) => phases.push(`queue:${String(error)}`));
		const barrier = {
			async holdResponse() {},
			async holdReceipt() { phases.push("receipt_waiting"); await receiptGate.promise; },
			async holdWork() { phases.push("work_waiting"); await workGate.promise; phases.push("work_released"); },
			async receiptRejected(error: unknown) {
				assert.equal((error as Error).message, "host receipt returned HTTP 409");
				phases.push("receipt_rejected");
			},
			async workSettled() { phases.push("work_settled"); },
			async dispose() {},
		};
		const route = routeWorkspaceChannelEvent({
			handler: {
				resolvePendingInput() { return false; },
				async handleSlashCommand() { return false; },
				isRunning() { return false; },
				async handleEvent() { phases.push("model_work"); },
			} as never,
			adapter: {} as never,
			event: { type: "mention", channel: "7", ts: "1", user: "42", text: "neutral request", attachments: [] } as never,
			queue,
			awaitCompletion: true,
			onAccepted: async () => { throw new Error("host receipt returned HTTP 409"); },
			ownedWorkCanary: barrier,
		}, true).then(
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(new Set(phases), new Set(["receipt_waiting", "work_waiting"]));
		receiptGate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(phases.includes("receipt_rejected"));
		assert.equal(phases.includes("model_work"), false);
		workGate.resolve();
		const outcome = await route;
		assert.equal(outcome.status, "fulfilled");
		assert.deepEqual(phases.slice(-3), ["work_released", "model_work", "work_settled"]);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(unhandled.length, 0);
		assert.equal(handled.length, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		process.off("rejectionHandled", onHandled);
	}
});

test("controller fails closed for a missing or world-accessible socket", async () => {
	const directory = mkdtempSync(join(tmpdir(), "owned-work-canary-"));
	temporary.push(directory);
	const { authorization } = fixture();
	await assert.rejects(
		createOwnedWorkCanaryBarrier(authorization, { socketPath: join(directory, "missing.sock") }),
		/ENOENT/,
	);
	const socketPath = join(directory, "unsafe.sock");
	const server = createServer();
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	chmodSync(socketPath, 0o666);
	await assert.rejects(
		createOwnedWorkCanaryBarrier(authorization, { socketPath }),
		/owned_work_canary_socket_unsafe/,
	);
	server.close();
});

test("controller loss rejects held work instead of releasing it after restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "owned-work-canary-"));
	temporary.push(directory);
	const socketPath = join(directory, "control.sock");
	const { authorization } = fixture();
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				const frame = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
				buffer = buffer.slice(index + 1);
				if (frame.type === "consume") {
					socket.write(`${JSON.stringify({ v: 1, type: "armed", nonce: authorization.nonce })}\n`);
				} else if (frame.phase === "work_waiting") {
					socket.destroy();
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	chmodSync(socketPath, 0o660);
	const barrier = await createOwnedWorkCanaryBarrier(authorization, { socketPath });
	await assert.rejects(barrier.holdWork(), /owned_work_canary_controller_lost/);
	await barrier.dispose();
	server.close();
});

async function waitForPhase(phases: string[], phase: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (phases.includes(phase)) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.fail(`missing phase ${phase}`);
}

test("neutral harness proves duplicate completion before stale receipt, one output, settlement, and close", async () => {
	const directory = mkdtempSync(join(tmpdir(), "owned-work-canary-"));
	temporary.push(directory);
	const socketPath = join(directory, "control.sock");
	const { authorization } = fixture();
	const phases: string[] = [];
	const lifecycle: string[] = [];
	const unhandled: unknown[] = [];
	const handled: unknown[] = [];
	const onUnhandled = (error: unknown) => unhandled.push(error);
	const onHandled = (error: unknown) => handled.push(error);
	process.on("unhandledRejection", onUnhandled);
	process.on("rejectionHandled", onHandled);
	let client: Socket | undefined;
	let buffer = "";
	const closed = Promise.withResolvers<void>();
	const server = createServer((socket) => {
		client = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				const frame = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
				buffer = buffer.slice(index + 1);
				if (frame.type === "consume") {
					lifecycle.push("authorization_consumed");
					socket.write(`${JSON.stringify({ v: 1, type: "armed", nonce: authorization.nonce })}\n`);
				} else {
					phases.push(String(frame.phase));
					lifecycle.push(String(frame.phase));
				}
			}
		});
		socket.on("close", () => closed.resolve());
	});
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	chmodSync(socketPath, 0o660);
	try {
		const barrier = await createOwnedWorkCanaryBarrier(authorization, { socketPath });
		const routeBarrier = {
			...barrier,
			async holdWork() { await barrier.holdWork(); lifecycle.push("work_gate_returned"); },
		};
		const response = barrier.holdResponse().then(() => lifecycle.push("http_accepted"));
		const queue = new WorkspaceChannelQueue((error) => lifecycle.push(`queue_error:${String(error)}`));
		const route = routeWorkspaceChannelEvent({
			handler: {
				resolvePendingInput() { return false; },
				async handleSlashCommand() { return false; },
				isRunning() { return false; },
				async handleEvent() { lifecycle.push("one_exact_output"); },
			} as never,
			adapter: {} as never,
			event: { type: "mention", channel: "7", ts: "1", user: "42", text: "neutral request", attachments: [] } as never,
			queue,
			awaitCompletion: true,
			onAccepted: async () => {
				lifecycle.push("stale_receipt_called");
				throw new Error("host receipt returned HTTP 409");
			},
			ownedWorkCanary: routeBarrier,
		}, true).then(
			() => ({ status: "fulfilled" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		await Promise.all([
			waitForPhase(phases, "response_waiting"),
			waitForPhase(phases, "receipt_waiting"),
			waitForPhase(phases, "work_waiting"),
		]);
		lifecycle.push("duplicate_completed_attempt_2");
		client!.write(`${JSON.stringify({ v: 1, type: "release_response", nonce: authorization.nonce })}\n`);
		await response;
		await waitForPhase(phases, "response_released");
		client!.write(`${JSON.stringify({ v: 1, type: "release_receipt", nonce: authorization.nonce })}\n`);
		await waitForPhase(phases, "receipt_rejected");
		assert.equal(lifecycle.includes("one_exact_output"), false);
		client!.write(`${JSON.stringify({ v: 1, type: "release_work", nonce: authorization.nonce })}\n`);
		const routeOutcome = await route;
		assert.equal(routeOutcome.status, "fulfilled");
		await waitForPhase(phases, "work_settled");
		await barrier.dispose();
		await closed.promise;
		assert.equal(lifecycle.filter((phase) => phase === "one_exact_output").length, 1);
		for (const [before, after] of [
			["duplicate_completed_attempt_2", "response_released"],
			["response_released", "stale_receipt_called"],
			["stale_receipt_called", "receipt_rejected"],
			["receipt_rejected", "work_gate_returned"],
			["work_gate_returned", "one_exact_output"],
			["one_exact_output", "work_settled"],
			["work_settled", "route_settled"],
		] as const) {
			assert.ok(lifecycle.indexOf(before) < lifecycle.indexOf(after), `${before} precedes ${after}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(unhandled, []);
		assert.deepEqual(handled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		process.off("rejectionHandled", onHandled);
		client?.destroy();
		server.close();
	}
});

test("controller loss rejects response, receipt, and work gates without output", async () => {
	const directory = mkdtempSync(join(tmpdir(), "owned-work-canary-"));
	temporary.push(directory);
	const socketPath = join(directory, "control.sock");
	const { authorization } = fixture();
	let outputCount = 0;
	const waiting = new Set<string>();
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				const frame = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
				buffer = buffer.slice(index + 1);
				if (frame.type === "consume") {
					socket.write(`${JSON.stringify({ v: 1, type: "armed", nonce: authorization.nonce })}\n`);
				} else if (typeof frame.phase === "string" && frame.phase.endsWith("_waiting")) {
					waiting.add(frame.phase);
					if (waiting.size === 3) socket.destroy();
				} else {
					outputCount += 1;
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	chmodSync(socketPath, 0o660);
	const barrier = await createOwnedWorkCanaryBarrier(authorization, { socketPath });
	const outcomes = await Promise.allSettled([
		barrier.holdResponse(),
		barrier.holdReceipt(),
		barrier.holdWork(),
	]);
	assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected", "rejected"]);
	for (const outcome of outcomes) {
		assert.match(String((outcome as PromiseRejectedResult).reason), /owned_work_canary_controller_lost/);
	}
	assert.equal(outputCount, 0);
	await barrier.dispose();
	server.close();
});

test("controller deadline rejects every held gate without release", async () => {
	const directory = mkdtempSync(join(tmpdir(), "owned-work-canary-"));
	temporary.push(directory);
	const socketPath = join(directory, "control.sock");
	const { authorization } = fixture();
	authorization.deadlineMs = 1_000;
	const server = createServer((socket) => {
		let buffer = "";
		let armed = false;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (!armed && buffer.includes("\n")) {
				armed = true;
				socket.write(`${JSON.stringify({ v: 1, type: "armed", nonce: authorization.nonce })}\n`);
			}
		});
	});
	await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
	chmodSync(socketPath, 0o660);
	const barrier = await createOwnedWorkCanaryBarrier(authorization, { socketPath });
	const outcomes = await Promise.allSettled([
		barrier.holdResponse(),
		barrier.holdReceipt(),
		barrier.holdWork(),
	]);
	assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected", "rejected"]);
	for (const outcome of outcomes) {
		assert.match(String((outcome as PromiseRejectedResult).reason), /owned_work_canary_deadline/);
	}
	await barrier.dispose();
	server.close();
});
