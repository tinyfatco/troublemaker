import assert from "node:assert/strict";
import { handoffContinuationMessage, HANDOFF_RESUME_INSTRUCTION, runHandoffSegments } from "../src/handoff-continuation.js";

const input = { text: "Original authorized task", rawText: "Original attachment text", user: "example-user",
	channel: "example-channel", ts: "1", userName: "Example", freshContext: true, deliveryId: "example-delivery",
	attachments: [{ local: "example.txt", original: "example.txt" }] };
const before = structuredClone(input);
const resumed = handoffContinuationMessage(input);
assert.equal(resumed.text, HANDOFF_RESUME_INSTRUCTION);
assert.equal(resumed.rawText, HANDOFF_RESUME_INSTRUCTION);
assert.equal(resumed.channel, input.channel);
assert.equal(resumed.deliveryId, undefined);
assert.equal(resumed.freshContext, false);
assert.deepEqual(resumed.attachments, []);
assert.deepEqual(input, before, "continuation must not mutate the accepted input or replay its reset and attachments");

const calls: boolean[] = [];
const result = await runHandoffSegments(async (continuation) => {
	calls.push(continuation);
	return { result: { stopReason: "stop" }, resume: calls.length < 3 };
}, () => false);
assert.deepEqual(calls, [false, true, true], "original ingress runs once; subsequent rotations only continue the checkpoint");
assert.equal(result.stopReason, "stop");
for (const reason of ["error", "aborted"]) {
	let count = 0;
	const failed = await runHandoffSegments(async () => {
		count++;
		return { result: { stopReason: reason }, resume: true };
	}, () => false);
	assert.equal(count, 1, "failed checkpoint must not retry or redeliver input");
	assert.equal(failed.stopReason, reason);
}
let aborted = false;
let count = 0;
assert.equal((await runHandoffSegments(async () => {
	count++;
	aborted = true;
	return { result: { stopReason: "stop" }, resume: true };
}, () => aborted)).stopReason, "aborted");
assert.equal(count, 1, "stop at a rotation boundary prevents the continuation");
console.log("handoff continuation: ok");
