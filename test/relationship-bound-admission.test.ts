import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	admitRelationshipBoundMessage,
	type RelationshipRunBinding,
	type StrictSteerAdmission,
} from "../src/relationship-bound-admission.js";
import { WorkspaceDeliveryLedger } from "../src/adapters/workspace-channel-runtime.js";

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
} {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const request = {
	relationshipId: "relationship-example-0001",
	pairedChannelId: "paired-channel-example",
};
const exactRun: RelationshipRunBinding = {
	runId: "run-example-0001",
	relationshipId: request.relationshipId,
	channelId: request.pairedChannelId,
};

{
	const accepted = deferred();
	const completed = deferred();
	let steered = 0;
	let started = 0;
	const result = admitRelationshipBoundMessage({
		request,
		activeRuns: [exactRun],
		strictSteer: (run): StrictSteerAdmission => {
			assert.deepEqual(run, exactRun);
			steered++;
			return { accepted: accepted.promise, completed: completed.promise };
		},
		admitIdle: () => {
			started++;
			return Promise.resolve();
		},
	});
	assert.equal(result.disposition, "steered");
	assert.equal(steered, 1);
	assert.equal(started, 0);
	if (result.disposition !== "steered") assert.fail("expected strict steering admission");
	let acceptedSettled = false;
	void result.accepted.then(() => { acceptedSettled = true; });
	await Promise.resolve();
	assert.equal(acceptedSettled, false, "routing does not imply authoritative steer acceptance");
	accepted.resolve();
	await result.accepted;
	let completedSettled = false;
	void result.completed.then(() => { completedSettled = true; });
	await Promise.resolve();
	assert.equal(completedSettled, false, "steer acceptance does not imply durable completion");
	completed.resolve();
	await result.completed;
}

{
	let started = 0;
	const execution = deferred();
	const result = admitRelationshipBoundMessage({
		request,
		activeRuns: [],
		strictSteer: () => assert.fail("idle admission must not call strict steer"),
		admitIdle: () => {
			started++;
			return execution.promise;
		},
	});
	assert.equal(result.disposition, "new_turn");
	assert.equal(started, 1);
	if (result.disposition !== "new_turn") assert.fail("expected an idle new turn");
	await result.accepted;
	let completedSettled = false;
	void result.completed.then(() => { completedSettled = true; });
	await Promise.resolve();
	assert.equal(completedSettled, false);
	execution.resolve();
	await result.completed;
}

{
	const mismatchedRun: RelationshipRunBinding = {
		runId: "run-example-0002",
		relationshipId: "relationship-example-0002",
		channelId: request.pairedChannelId,
	};
	let routed = false;
	const result = admitRelationshipBoundMessage({
		request,
		activeRuns: [mismatchedRun],
		strictSteer: () => {
			routed = true;
			return null;
		},
		admitIdle: () => {
			routed = true;
			return Promise.resolve();
		},
	});
	assert.deepEqual(result, { disposition: "rejected", reason: "relationship_mismatch" });
	assert.equal(routed, false, "a mismatched relationship cannot steer or become queued work");
}

{
	for (const [activeRun, reason] of [
		[{ runId: "run-example-0005", channelId: request.pairedChannelId }, "missing_active_binding"],
		[{ runId: "run-example-0006", relationshipId: request.relationshipId }, "missing_active_binding"],
		[{ ...exactRun, channelId: "other-channel-example" }, "channel_mismatch"],
	] as const) {
		const result = admitRelationshipBoundMessage({
			request,
			activeRuns: [activeRun],
			strictSteer: () => assert.fail("an absent or mismatched binding must not steer"),
			admitIdle: () => assert.fail("an absent or mismatched binding must not create work"),
		});
		assert.deepEqual(result, { disposition: "rejected", reason });
	}
}

{
	for (const activeRuns of [
		[
			exactRun,
			{ ...exactRun, runId: "run-example-0003" },
		],
		[
			exactRun,
			{
				runId: "run-example-0004",
				relationshipId: "relationship-example-0004",
				channelId: "other-channel-example",
			},
		],
	]) {
		const result = admitRelationshipBoundMessage({
			request,
			activeRuns,
			strictSteer: () => assert.fail("ambiguous active bindings must fail closed"),
			admitIdle: () => assert.fail("ambiguous active bindings must not create work"),
		});
		assert.deepEqual(result, { disposition: "rejected", reason: "ambiguous_active_run" });
	}
}

{
	const result = admitRelationshipBoundMessage({
		request,
		activeRuns: [exactRun],
		strictSteer: () => null,
		admitIdle: () => assert.fail("a stale exact run must not fall back to a new turn"),
	});
	assert.deepEqual(result, { disposition: "rejected", reason: "steer_unavailable" });
}

{
	const result = admitRelationshipBoundMessage({
		request,
		activeRuns: [],
		strictSteer: () => assert.fail("stale idle admission must not steer"),
		admitIdle: () => null,
	});
	assert.deepEqual(result, { disposition: "rejected", reason: "idle_admission_stale" });
}

{
	const directory = mkdtempSync(join(tmpdir(), "relationship-delivery-ledger-"));
	const path = join(directory, "deliveries.jsonl");
	const deliveryId = "delivery-example-0001";
	const ledger = new WorkspaceDeliveryLedger(path, "example ledger unreadable");
	assert.equal(ledger.reserve(deliveryId), true);
	assert.equal(ledger.receipt(deliveryId)?.state, "pending");
	assert.equal(ledger.reserve(deliveryId), false, "a pending reservation deduplicates immediately");
	ledger.complete(deliveryId);
	assert.equal(ledger.receipt(deliveryId)?.state, "pending", "pending is not execution success");

	const restartedPending = new WorkspaceDeliveryLedger(path, "example ledger unreadable");
	assert.equal(restartedPending.receipt(deliveryId)?.state, "pending");
	assert.equal(restartedPending.claim(deliveryId), false, "restart cannot promote pending to accepted");
	const receiptReader = new WorkspaceDeliveryLedger(path, "example ledger unreadable");
	assert.equal(receiptReader.receipt(deliveryId)?.state, "pending");
	assert.equal(restartedPending.accept(deliveryId), true);
	assert.equal(restartedPending.receipt(deliveryId)?.state, "accepted");
	assert.equal(
		receiptReader.receipts([deliveryId])[0]?.state,
		"accepted",
		"receipt reconciliation refreshes another resident-owned ledger reader",
	);
	restartedPending.complete(deliveryId);
	assert.equal(restartedPending.receipt(deliveryId)?.state, "completed");
	assert.equal(restartedPending.reject(deliveryId, "route_rejected"), false);

	const restartedCompleted = new WorkspaceDeliveryLedger(path, "example ledger unreadable");
	assert.equal(restartedCompleted.receipt(deliveryId)?.state, "completed");
	assert.equal(restartedCompleted.reserve(deliveryId), false);
	assert.equal(restartedCompleted.accept(deliveryId), false);
}

{
	const directory = mkdtempSync(join(tmpdir(), "relationship-delivery-rejection-"));
	const path = join(directory, "deliveries.jsonl");
	const deliveryId = "delivery-example-0002";
	const ledger = new WorkspaceDeliveryLedger(path, "example ledger unreadable");
	assert.equal(ledger.reserve(deliveryId), true);
	assert.equal(ledger.reject(deliveryId, "relationship_mismatch"), true);
	assert.deepEqual(ledger.receipt(deliveryId), {
		deliveryId,
		state: "rejected",
		rejectionReason: "relationship_mismatch",
		reservedAt: ledger.receipt(deliveryId)?.reservedAt,
		rejectedAt: ledger.receipt(deliveryId)?.rejectedAt,
	});
	assert.equal(ledger.accept(deliveryId), false, "rejection is terminal for the exact delivery identity");
	ledger.complete(deliveryId);
	assert.equal(ledger.receipt(deliveryId)?.state, "rejected");
	assert.equal(ledger.reserve(deliveryId), false);

	const restarted = new WorkspaceDeliveryLedger(path, "example ledger unreadable");
	assert.equal(restarted.receipt(deliveryId)?.state, "rejected");
	assert.equal(restarted.reserve(deliveryId), false, "terminal rejection survives restart");
	assert.equal(restarted.claim(deliveryId), false);
}

console.log("relationship-bound admission tests passed");
