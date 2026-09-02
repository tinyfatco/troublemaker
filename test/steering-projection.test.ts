import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RuntimeSteeringInputEvent } from "../src/core/runtime-contract.js";
import { RuntimeLiveEventHub } from "../src/live-events.js";
import { SteeringProjectionTracker } from "../src/streaming/steering-projection.js";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

const prompt = "[2026-08-04 12:00:00+00:00] [slack:#example] [Casey]: use the updated example";
const emitted: RuntimeSteeringInputEvent[] = [];
const tracker = new SteeringProjectionTracker((event) => {
	if (event.type === "steering_input") emitted.push(event);
});
const acceptance = deferred();
const idle = deferred();
let enqueueCount = 0;

const settlement = tracker.track({
	id: "steering-example-one",
	deliveryId: "delivery-example-one",
	prompt,
	enqueue: () => {
		enqueueCount++;
		return acceptance.promise;
	},
	waitForIdle: () => idle.promise,
});
const duplicateSettlement = tracker.track({
	id: "steering-example-one",
	deliveryId: "delivery-example-one",
	prompt,
	enqueue: () => {
		throw new Error("duplicate delivery must not enqueue again");
	},
	waitForIdle: () => idle.promise,
});

assert.equal(enqueueCount, 1, "duplicate delivery shares one Pi steering enqueue");
assert.equal(duplicateSettlement, settlement, "duplicate delivery shares the original settlement receipt");
assert.equal(emitted.length, 0, "input is not projected before Pi accepts steering");

acceptance.resolve();
await flushMicrotasks();
assert.deepEqual(emitted.map((event) => event.state), ["accepted"], "accepted steering projects before the run settles");
assert.equal(emitted[0]?.entries[0]?.text, "use the updated example");
assert.equal(emitted[0]?.deliveryId, "delivery-example-one", "accepted steering preserves exact transport identity");

tracker.consume(prompt);
assert.deepEqual(emitted.map((event) => event.state), ["accepted", "consumed"], "model consumption reconciles the pending projection");
idle.resolve();
await settlement;

const rejectedAcceptance = deferred();
const rejected = tracker.track({
	id: "steering-example-rejected",
	prompt: "[2026-08-04 12:01:00+00:00] [web] [user]: rejected example",
	enqueue: () => rejectedAcceptance.promise,
	waitForIdle: async () => {},
});
rejectedAcceptance.reject(new Error("steering queue closed"));
await assert.rejects(rejected, /steering queue closed/);
assert.equal(
	emitted.some((event) => event.id === "steering-example-rejected"),
	false,
	"rejected steering is never projected as accepted",
);

const pendingAcceptance = deferred();
const pendingIdle = deferred();
const pending = tracker.track({
	id: "steering-example-dismissed",
	prompt: "[2026-08-04 12:02:00+00:00] [email:example.com] [Casey]: pending example",
	enqueue: () => pendingAcceptance.promise,
	waitForIdle: () => pendingIdle.promise,
});
pendingAcceptance.resolve();
await flushMicrotasks();
tracker.dismissAll();
assert.deepEqual(
	emitted.filter((event) => event.id === "steering-example-dismissed").map((event) => event.state),
	["accepted", "dismissed"],
	"unconsumed steering is withdrawn when its active run ends",
);
pendingIdle.resolve();
await pending;

const hub = new RuntimeLiveEventHub();
const metadata = {
	runId: "run-example",
	channelId: "slack:C1111111111",
	source: "slack",
	deliveryId: "delivery-run-example",
};
const acceptedEvent: RuntimeSteeringInputEvent = {
	type: "steering_input",
	id: "steering-example-live",
	deliveryId: "delivery-steer-example",
	state: "accepted",
	deliveryMode: "steered",
	acceptedAt: "2026-08-04T12:03:00.000Z",
	entries: [{ channel: "slack:#example", userName: "Casey", text: "refresh-safe example" }],
};
const acceptedEnvelope = hub.publishRuntime(metadata, acceptedEvent);
assert.equal(
	acceptedEnvelope.kind === "runtime" ? acceptedEnvelope.deliveryId : undefined,
	"delivery-run-example",
	"live run metadata preserves the exact creating delivery",
);
hub.publishRuntime(metadata, { type: "status", status: "streaming", message: "Working" });

const freshAttach: string[] = [];
hub.subscribe((event) => {
	if (event.kind === "runtime" && event.event.type === "steering_input") freshAttach.push(event.event.state);
});
assert.deepEqual(freshAttach, ["accepted"], "refresh receives the currently accepted steering projection");

const reconnectProjectionStates: string[] = [];
const reconnectSubscription = hub.subscribe((event) => {
	if (event.kind === "runtime" && event.event.type === "steering_input") {
		reconnectProjectionStates.push(event.event.state);
	}
}, acceptedEnvelope.sequence - 1);
reconnectSubscription.unsubscribe();
assert.deepEqual(reconnectProjectionStates, ["accepted"], "reconnect replays one missed accepted projection");

const duplicateEvents: string[] = [];
const duplicateSubscription = hub.subscribe((event) => {
	if (event.kind === "runtime" && event.event.type === "steering_input") duplicateEvents.push(event.event.state);
}, acceptedEnvelope.sequence);
const duplicateEnvelope = hub.publishRuntime(metadata, acceptedEvent);
duplicateSubscription.unsubscribe();
assert.equal(duplicateEnvelope.sequence, acceptedEnvelope.sequence, "duplicate live projection reuses the original envelope");
assert.equal(duplicateEvents.length, 0, "duplicate publish does not deliver another accepted projection");

hub.publishRuntime(metadata, { ...acceptedEvent, state: "consumed" });
hub.publishRuntime(metadata, {
	type: "user_input",
	entries: acceptedEvent.entries,
});
const afterConsumption: string[] = [];
hub.subscribe((event) => {
	if (event.kind === "runtime" && event.event.type === "steering_input") afterConsumption.push(event.event.state);
});
assert.equal(afterConsumption.includes("accepted"), false, "refresh does not resurrect consumed steering");

const cliSource = readFileSync("src/host/node/cli.ts", "utf8");
const busySteeringSource = cliSource.slice(
	cliSource.indexOf("function steerOrQueueBusyMessage"),
	cliSource.indexOf("// Handler (shared across all adapters)"),
);
assert.match(busySteeringSource, /runner\.steer\(steeringPrompt, \{[\s\S]*?projectionId,[\s\S]*?deliveryId/, "ordinary busy input carries stable projection and delivery identities into Pi");
const voiceSteeringSource = cliSource.slice(
	cliSource.indexOf("function steerOrQueueVoiceWebhook"),
	cliSource.indexOf("function steerOrQueueBusyMessage"),
);
assert.doesNotMatch(voiceSteeringSource, /projectionId/, "voice-webhook behavior remains outside the non-voice steering projection path");

const agentSource = readFileSync("src/agent.ts", "utf8");
assert(
	agentSource.indexOf("steeringProjections.consume(promptText)") < agentSource.indexOf('emitLiveEvent({ type: "user_input", entries })'),
	"consumption reconciles the projection before the canonical live user input",
);

console.log("steering projection tests passed");

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
