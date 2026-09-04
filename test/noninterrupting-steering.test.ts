import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { MomEvent, PlatformAdapter } from "../src/adapters/types.js";
import {
	formatBusyMessageSteer,
	formatLocalTimestamp,
	routeBusyMessageWithoutInterrupt,
} from "../src/noninterrupting-steering.js";

const event: MomEvent = {
	type: "mention",
	channel: "C1111111111",
	ts: "1780000000.000100",
	user: "U2222222222",
	text: "fold this into what you are doing",
	rawText: "<@U3333333333> fold this into what you are doing",
	sourceEventType: "slack_app_mention",
	deliveryId: "delivery-steer-one",
	directlyAddressed: true,
	threadTs: "1780000000.000100",
	replyTarget: "slack:C1111111111:1780000000.000100",
	replyTargetDescription: "Slack thread under this direct mention",
	attachments: [{ original: "example.txt", local: "uploads/example.txt" }],
};
const adapter = {
	getUser: () => ({ id: event.user, userName: "sample-user", displayName: "Sample User" }),
} as unknown as PlatformAdapter;
const receivedAt = Date.parse("2026-07-19T17:00:00.000Z");
const prompt = formatBusyMessageSteer(event, adapter, "slack:#agents", receivedAt);

assert.match(prompt, /Source event: slack_app_mention/);
assert.match(prompt, /Delivery ID: delivery-steer-one/);
assert.match(prompt, /Message type: mention/);
assert.match(prompt, /Directly addressed: yes/);
assert.match(prompt, /Suggested reply target: slack:C1111111111:1780000000\.000100/);
assert.match(prompt, /Use send_message with this exact target/);
assert.match(prompt, new RegExp(`\\[${formatLocalTimestamp(receivedAt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\] \\[slack:#agents\\] \\[sample-user\\]`));
assert.match(prompt, /fold this into what you are doing/);
assert.match(prompt, /<attachments>\nuploads\/example\.txt\n<\/attachments>/);

const actions: string[] = [];
assert.equal(routeBusyMessageWithoutInterrupt({
	prompt: "first",
	canSteer: true,
	steer: (value) => { actions.push(`steer:${value}`); return true; },
	enqueue: () => { actions.push("queue:first"); },
}), "steered");
assert.deepEqual(actions, ["steer:first"], "an accepting active model receives a soft steer only");

assert.equal(routeBusyMessageWithoutInterrupt({
	prompt: "second",
	canSteer: true,
	steer: (value) => { actions.push(`decline:${value}`); return false; },
	enqueue: () => { actions.push("queue:second"); },
}), "queued");
assert.deepEqual(actions.slice(1), ["decline:second", "queue:second"], "a temporarily closed steering boundary falls back to a fresh turn");

assert.equal(routeBusyMessageWithoutInterrupt({
	prompt: "third",
	canSteer: false,
	steer: () => { throw new Error("idle or queued work must not receive a steer call"); },
	enqueue: () => { actions.push("queue:third"); },
}), "queued");
assert.equal(actions.at(-1), "queue:third");

const cli = readFileSync("src/host/node/cli.ts", "utf8");
const busyRouter = cli.slice(
	cli.indexOf("function steerOrQueueBusyMessage"),
	cli.indexOf("// Handler (shared across all adapters)"),
);
assert.match(busyRouter, /formatBusyMessageSteer/);
assert.match(busyRouter, /routeBusyMessageWithoutInterrupt/);
assert.match(busyRouter, /withGlobalRunSlot/);
assert.doesNotMatch(busyRouter, /abort|enqueueHardInterrupt/, "ordinary steering has no active-run cancellation path");

const handleSteer = cli.slice(
	cli.indexOf("\thandleSteer(event:"),
	cli.indexOf("\thandleVoiceEvent(event:"),
);
assert.match(handleSteer, /steerOrQueueBusyMessage\(event, adapter\)/, "ordinary busy messages use non-interrupting steering");
assert.match(handleSteer, /isConfigurableVoiceWebhook[\s\S]*?enqueueHardInterrupt\(event, adapter\)/, "explicit legacy voice interrupt mode remains available");

console.log("non-interrupting steering ok");
