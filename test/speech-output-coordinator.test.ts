import assert from "node:assert/strict";
import {
	SpeechOutputCoordinator,
	assertMonotonicSpeechReceipts,
	type SpeechOutputExecution,
} from "../src/speech-output-coordinator.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

interface FakeOutput {
	execution: SpeechOutputExecution<string>;
	complete: () => void;
	fail: (error: Error) => void;
	cancelReasons: string[];
}

function fakeOutput(id: string, running: Set<string>, events: string[]): FakeOutput {
	const done = deferred<void>();
	void done.promise.catch(() => {});
	let inactive = false;
	const markInactive = () => {
		if (inactive) return;
		inactive = true;
		running.delete(id);
	};
	running.add(id);
	events.push(`active:${id}`);
	const cancelReasons: string[] = [];
	return {
		execution: {
			value: `started:${id}`,
			completed: done.promise.finally(markInactive),
			cancel: async (reason) => {
				cancelReasons.push(reason);
				events.push(`cancel:${id}`);
				markInactive();
				done.resolve();
				await done.promise;
			},
		},
		complete: () => {
			events.push(`complete:${id}`);
			done.resolve();
		},
		fail: (error) => {
			events.push(`fail:${id}`);
			done.reject(error);
		},
		cancelReasons,
	};
}

// Rapid back-to-back output is FIFO and never exceeds one active execution.
{
	const coordinator = new SpeechOutputCoordinator("agent-a:local");
	const events: string[] = [];
	const running = new Set<string>();
	let maxRunning = 0;
	const outputs = new Map<string, FakeOutput>();
	const enqueue = (id: string) => coordinator.enqueue({
		speechId: id,
		requestDigest: id,
		cancelStart: async () => {},
		start: async () => {
			events.push(`start:${id}`);
			const output = fakeOutput(id, running, events);
			outputs.set(id, output);
			maxRunning = Math.max(maxRunning, running.size);
			return output.execution;
		},
	});

	const first = enqueue("first");
	await first.started;
	const second = enqueue("second");
	const third = enqueue("third");
	await tick();
	assert.deepEqual(events.filter((event) => event.startsWith("start:")), ["start:first"]);
	assert.deepEqual(coordinator.queuedSpeechIds, ["second", "third"]);

	outputs.get("first")?.complete();
	await first.settled;
	await second.started;
	assert.deepEqual(events.filter((event) => event.startsWith("start:")), ["start:first", "start:second"]);
	outputs.get("second")?.complete();
	await second.settled;
	await third.started;
	outputs.get("third")?.complete();
	await third.settled;

	assert.equal(maxRunning, 1);
	assert.deepEqual([...running], []);
	assert.deepEqual(
		coordinator.getReceipts().map(({ speechId, status }) => `${speechId}:${status}`),
		[
			"first:queued", "first:started", "second:queued", "third:queued",
			"first:completed", "second:started", "second:completed", "third:started", "third:completed",
		],
	);
	assertMonotonicSpeechReceipts(coordinator.getReceipts());
}

// One speech id is idempotent while queued, active, and after terminal settlement.
{
	const coordinator = new SpeechOutputCoordinator("agent-b:local");
	const running = new Set<string>();
	const events: string[] = [];
	let starts = 0;
	let output!: FakeOutput;
	const request = {
		speechId: "same-speech-id",
		requestDigest: "same-speech-id",
		cancelStart: async () => {},
		start: async () => {
			starts += 1;
			output = fakeOutput("same-speech-id", running, events);
			return output.execution;
		},
	};
	const original = coordinator.enqueue(request);
	const duplicateWhileActive = coordinator.enqueue(request);
	assert.equal(duplicateWhileActive.duplicate, true);
	assert.equal((await duplicateWhileActive.started).duplicate, true);
	assert.throws(
		() => coordinator.enqueue({ ...request, requestDigest: "changed-text-or-backend" }),
		/different request content/,
	);
	output.complete();
	await original.settled;
	const duplicateAfterCompletion = coordinator.enqueue(request);
	assert.equal(duplicateAfterCompletion.duplicate, true);
	assert.equal((await duplicateAfterCompletion.started).duplicate, true);
	assert.equal((await duplicateAfterCompletion.settled).status, "completed");
	assert.equal(starts, 1);
	assert.deepEqual(coordinator.getReceipts().map(({ status }) => status), ["queued", "started", "completed"]);
}

// Explicit interruption cancels only the active item, runs the superseding item
// next, and leaves older queued work in its original relative order.
{
	const coordinator = new SpeechOutputCoordinator("agent-c:local");
	const running = new Set<string>();
	const events: string[] = [];
	const outputs = new Map<string, FakeOutput>();
	const request = (id: string, interrupt = false) => coordinator.enqueue({
		speechId: id,
		requestDigest: id,
		interrupt,
		cancelStart: async () => {},
		start: async () => {
			const output = fakeOutput(id, running, events);
			outputs.set(id, output);
			return output.execution;
		},
	});

	const active = request("active");
	await active.started;
	const queued = request("queued");
	const superseding = request("superseding", true);
	const secondSuperseding = request("superseding-2", true);
	assert.deepEqual(coordinator.queuedSpeechIds, ["superseding", "superseding-2", "queued"]);
	assert.equal((await active.settled).status, "canceled");
	await superseding.started;
	assert.deepEqual(outputs.get("active")?.cancelReasons, ["superseded_by:superseding"]);
	assert.deepEqual([...running], ["superseding"]);
	outputs.get("superseding")?.complete();
	await superseding.settled;
	await secondSuperseding.started;
	outputs.get("superseding-2")?.complete();
	await secondSuperseding.settled;
	await queued.started;
	outputs.get("queued")?.complete();
	await queued.settled;
	assert.equal(running.size, 0);
	assert.deepEqual(
		coordinator.getReceipts().filter(({ speechId }) => speechId === "active").map(({ status }) => status),
		["queued", "started", "canceled"],
	);
	assertMonotonicSpeechReceipts(coordinator.getReceipts());
}

// A late start cannot escape cancellation or emit a stale started/completed receipt.
{
	const coordinator = new SpeechOutputCoordinator("agent-d:local");
	const startGate = deferred<void>();
	const running = new Set<string>();
	const events: string[] = [];
	let lateOutput!: FakeOutput;
	const late = coordinator.enqueue({
		speechId: "late",
		requestDigest: "late",
		cancelStart: async () => {},
		start: async () => {
			await startGate.promise;
			lateOutput = fakeOutput("late", running, events);
			return lateOutput.execution;
		},
	});
	const next = coordinator.enqueue({
		speechId: "next",
		requestDigest: "next",
		interrupt: true,
		cancelStart: async () => {},
		start: async () => fakeOutput("next", running, events).execution,
	});
	startGate.resolve();
	assert.equal((await late.settled).status, "canceled");
	await assert.rejects(late.started, /canceled/i);
	const nextStarted = await next.started;
	assert.equal(nextStarted.value, "started:next");
	assert.deepEqual([...running], ["next"]);
	assert.deepEqual(lateOutput.cancelReasons, ["superseded_by:next"]);
	assert.deepEqual(
		coordinator.getReceipts().filter(({ speechId }) => speechId === "late").map(({ status }) => status),
		["queued", "canceled"],
	);
	const receiptsAfterCancellation = coordinator.getReceipts().length;
	lateOutput.complete();
	await tick();
	assert.equal(coordinator.getReceipts().length, receiptsAfterCancellation, "late completion cannot append a stale terminal receipt");
	next.cancel("test_complete");
	await next.settled;
}

// Start failure releases the lane; queued output still advances.
{
	const coordinator = new SpeechOutputCoordinator("agent-e:local");
	const failed = coordinator.enqueue({
		speechId: "failed",
		requestDigest: "failed",
		cancelStart: async () => {},
		start: async () => { throw new Error("backend start exploded"); },
	});
	const running = new Set<string>();
	const events: string[] = [];
	let recoveryOutput!: FakeOutput;
	const recovery = coordinator.enqueue({
		speechId: "recovery",
		requestDigest: "recovery",
		cancelStart: async () => {},
		start: async () => {
			recoveryOutput = fakeOutput("recovery", running, events);
			return recoveryOutput.execution;
		},
	});
	assert.equal((await failed.settled).status, "failed");
	await assert.rejects(failed.started, /backend start exploded/);
	await recovery.started;
	recoveryOutput.complete();
	await recovery.settled;
	assert.deepEqual(
		coordinator.getReceipts().filter(({ speechId }) => speechId === "failed").map(({ status }) => status),
		["queued", "failed"],
	);
}

// Caller abort removes queued work without disturbing the active utterance.
{
	const coordinator = new SpeechOutputCoordinator("agent-f:local");
	const running = new Set<string>();
	const events: string[] = [];
	const activeOutput = fakeOutput("active", running, events);
	const active = coordinator.enqueue({
		speechId: "active",
		requestDigest: "active",
		start: async () => activeOutput.execution,
		cancelStart: async () => {},
	});
	await active.started;
	const controller = new AbortController();
	let queuedStarts = 0;
	const queued = coordinator.enqueue({
		speechId: "aborted-queued",
		requestDigest: "aborted-queued",
		signal: controller.signal,
		cancelStart: async () => {},
		start: async () => {
			queuedStarts += 1;
			return fakeOutput("aborted-queued", running, events).execution;
		},
	});
	controller.abort();
	assert.equal((await queued.settled).status, "canceled");
	await assert.rejects(queued.started, /caller_aborted/);
	assert.equal(queuedStarts, 0);
	assert.equal(coordinator.activeSpeechId, "active");
	activeOutput.complete();
	await active.settled;
}

// An already-aborted request is terminal before it can enter the lane or invoke
// the backend startup callback.
{
	const coordinator = new SpeechOutputCoordinator("agent-f-preaborted:local");
	const controller = new AbortController();
	controller.abort();
	let starts = 0;
	const ticket = coordinator.enqueue({
		speechId: "preaborted",
		requestDigest: "preaborted:v1",
		signal: controller.signal,
		cancelStart: async () => {},
		start: async () => {
			starts += 1;
			return {
				value: "must-not-start",
				completed: Promise.resolve(),
				cancel: async () => {},
			};
		},
	});
	assert.equal((await ticket.settled).status, "canceled");
	await assert.rejects(ticket.started, /caller_aborted/);
	assert.equal(starts, 0);
	assert.equal(coordinator.activeSpeechId, null);
}

// Teardown cancels active and queued work. A fresh coordinator after restart has
// no replay queue or stale duplicate registry.
{
	const coordinator = new SpeechOutputCoordinator("agent-g:local");
	const running = new Set<string>();
	const events: string[] = [];
	const activeOutput = fakeOutput("restart-id", running, events);
	const active = coordinator.enqueue({
		speechId: "restart-id",
		requestDigest: "restart-id",
		start: async () => activeOutput.execution,
		cancelStart: async () => {},
	});
	await active.started;
	const queued = coordinator.enqueue({
		speechId: "never-start",
		requestDigest: "never-start",
		cancelStart: async () => {},
		start: async () => fakeOutput("never-start", running, events).execution,
	});
	await coordinator.shutdown();
	assert.equal((await active.settled).status, "canceled");
	assert.equal((await queued.settled).status, "canceled");
	await assert.rejects(queued.started, /lane_shutdown/);
	assert.throws(
		() => coordinator.enqueue({
			speechId: "after-shutdown",
			requestDigest: "after-shutdown",
			start: async () => fakeOutput("after", running, events).execution,
			cancelStart: async () => {},
		}),
		/shut down/,
	);
	assert.equal(running.size, 0);

	const restarted = new SpeechOutputCoordinator("agent-g:local");
	const restartedOutput = fakeOutput("restart-id", running, events);
	const replaySafe = restarted.enqueue({
		speechId: "restart-id",
		requestDigest: "restart-id",
		start: async () => restartedOutput.execution,
		cancelStart: async () => {},
	});
	assert.equal((await replaySafe.started).duplicate, false);
	restartedOutput.complete();
	assert.equal((await replaySafe.settled).status, "completed");
	assert.equal(running.size, 0);
}

// A never-settling backend startup can still be canceled and shut down when its
// startup-cancel contract acknowledges that no output can appear later.
{
	const cancelCoordinator = new SpeechOutputCoordinator("agent-h:local");
	const cancelReasons: string[] = [];
	const hung = cancelCoordinator.enqueue({
		speechId: "hung-start",
		requestDigest: "hung-start:v1",
		start: async () => new Promise<SpeechOutputExecution<string>>(() => {}),
		cancelStart: async (reason) => { cancelReasons.push(reason); },
	});
	await tick();
	hung.cancel("stop-hung-start");
	assert.equal((await hung.settled).status, "canceled");
	await assert.rejects(hung.started, /stop-hung-start/);
	assert.deepEqual(cancelReasons, ["stop-hung-start"]);

	const shutdownCoordinator = new SpeechOutputCoordinator("agent-i:local");
	const shutdownReasons: string[] = [];
	const hungDuringShutdown = shutdownCoordinator.enqueue({
		speechId: "hung-shutdown",
		requestDigest: "hung-shutdown:v1",
		start: async () => new Promise<SpeechOutputExecution<string>>(() => {}),
		cancelStart: async (reason) => { shutdownReasons.push(reason); },
	});
	await tick();
	await shutdownCoordinator.shutdown();
	assert.equal((await hungDuringShutdown.settled).status, "canceled");
	await assert.rejects(hungDuringShutdown.started, /lane_shutdown/);
	assert.deepEqual(shutdownReasons, ["lane_shutdown"]);
}

// Terminal idempotency entries are bounded. Eviction is oldest-first and never
// removes active work; an evicted id may execute again within the same process.
{
	const coordinator = new SpeechOutputCoordinator("agent-j:local", { maxJobs: 2 });
	let starts = 0;
	const execute = async (speechId: string) => {
		const ticket = coordinator.enqueue({
			speechId,
			requestDigest: `${speechId}:v1`,
			start: async () => {
				starts += 1;
				return {
					value: speechId,
					completed: Promise.resolve(),
					cancel: async () => {},
				};
			},
			cancelStart: async () => {},
		});
		await ticket.started;
		await ticket.settled;
		return ticket;
	};
	await execute("bounded-1");
	await execute("bounded-2");
	await execute("bounded-3");
	assert.equal((await execute("bounded-2")).duplicate, true);
	assert.equal((await execute("bounded-1")).duplicate, false);
	assert.equal(starts, 4);
}

console.log("speech output coordinator tests passed");
