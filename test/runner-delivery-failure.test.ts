import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlatformAdapter } from "../src/adapters/types.js";
import { withHostReceipt } from "../src/adapters/host-receipt.js";
import { createSendMessageTool } from "../src/tools/send-message.js";
import {
	resetYield,
	wasYielded,
	createYieldNoActionTool,
} from "../src/tools/yield-no-action.js";
import {
	finalizeUserVisibleDeliveryFailure,
	resetUserVisibleDeliveryState,
	USER_VISIBLE_DELIVERY_FAILURE_MESSAGE,
} from "../src/tools/user-visible-delivery-state.js";
import { EventScheduler } from "../hostd/src/scheduler.mjs";
import { HostStore } from "../hostd/src/store.mjs";

function adapter(name: string, postInThread: PlatformAdapter["postInThread"]): PlatformAdapter {
	return {
		name,
		maxMessageLength: 1000,
		formatInstructions: "",
		start: async () => {},
		stop: async () => {},
		postMessage: async () => `${name}-message`,
		postInThread,
		updateMessage: async () => {},
		deleteMessage: async () => {},
		uploadFile: async () => {},
		logToFile: () => {},
		logBotResponse: () => {},
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllUsers: () => [],
		getAllChannels: () => [],
		createContext: () => { throw new Error("unused"); },
		enqueueEvent: () => false,
	} as unknown as PlatformAdapter;
}

resetYield();
resetUserVisibleDeliveryState();
let providerCalls = 0;
const zulip = adapter("zulip", async () => {
	throw new Error("zulip_channel_scope_denied");
});
const phone = adapter("phone", async () => {
	providerCalls++;
	return "provider-message-example";
});
const sendMessage = createSendMessageTool([zulip, phone]);
const failed = await sendMessage.execute("call-send", {
	label: "reply in the originating topic",
	target: "zulip:7:topic:Customer%20question",
	text: "The requested result is ready.",
});
assert.equal(failed.details?.delivered, false, "the failed adapter call is retained as undelivered");
assert.equal(providerCalls, 0, "a failed source-channel reply never invokes the phone provider");

const yieldNoAction = createYieldNoActionTool();
const yielded = await yieldNoAction.execute("call-yield", {
	reason: "stop after delivery refusal",
});
assert.equal(yielded.terminate, true);
assert.equal(wasYielded(), true, "the model's attempted quiet completion is recorded");

const directory = mkdtempSync(join(tmpdir(), "troublemaker-runner-delivery-failure-"));
const store = new HostStore(join(directory, "state.sqlite"));
const contextId = "front-desk:1234567890abcdef12345678:relationship-operator";
const eventId = "zulip:101";
const receiptToken = "synthetic-receipt-token";
const receiptStatuses: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
try {
	store.createContext({
		id: contextId,
		targetId: "front-desk",
		driver: "oci",
		runtimeName: "runtime-runner-delivery-example",
		port: 32124,
	});
	store.upsertEvent({
		id: eventId,
		source: "zulip",
		providerMessageId: "101",
		providerThreadId: "channel:7",
		principalHash: "1234567890abcdef12345678",
		targetId: "front-desk",
		contextId,
		payload: { message: { type: "stream", subject: "Customer question" } },
	});
	const leased = store.claimNextEvent({ maximumActiveContexts: 1 });
	assert.equal(leased.id, eventId);
	store.acceptEvent(leased.id, leased.leaseToken);
	const scheduler = new EventScheduler({
		config: { scheduler: { maximumAttempts: 5, turnLeaseSeconds: 900 } },
		store,
		runtime: {},
	});
	server = createServer(async (request, response) => {
		assert.equal(request.headers.authorization, `Bearer ${receiptToken}`);
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		receiptStatuses.push(body.status);
		scheduler.receipt(eventId, leased.leaseToken, body.status, body.error);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true }));
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("receipt server did not bind");

	const forcedSourceErrors: Array<{ text: string; force: boolean }> = [];
	const completion = await withHostReceipt({
		url: `http://127.0.0.1:${address.port}/receipt`,
		token: receiptToken,
		leaseToken: leased.leaseToken,
	}, async () => await finalizeUserVisibleDeliveryFailure({
		completion: { stopReason: "stop", errorMessage: undefined },
		directlyAddressed: true,
		yielded: wasYielded(),
		sendFinalResponse: async (text, options) => {
			forcedSourceErrors.push({ text, force: options.force });
		},
		clearYield: resetYield,
	}));

	assert.equal(completion.stopReason, "stop", "the production finalizer preserves successful runner completion");
	assert.equal(completion.errorMessage, undefined, "the production finalizer does not reopen the inbound event");
	assert.equal(completion.failure?.target, "zulip:7:topic:Customer%20question");
	assert.deepEqual(forcedSourceErrors, [{
		text: `_${USER_VISIBLE_DELIVERY_FAILURE_MESSAGE}_`,
		force: true,
	}], "the runner finalizer emits exactly one forced error to the source conversation");
	assert.equal(wasYielded(), false, "the production finalizer clears the attempted quiet completion");
	assert.deepEqual(receiptStatuses, ["running", "completed"], "the runtime reports successful completion after surfacing the error");
	assert.equal(store.getEvent(eventId).status, "completed", "Hostd durably completes the inbound event");
	assert.equal(store.getEvent(eventId).attempts, 1, "Hostd does not schedule a retry attempt");
	assert.equal(store.claimNextEvent({ maximumActiveContexts: 1 }), null, "the completed inbound event cannot replay");
	assert.equal(providerCalls, 0, "the composite failure path performs no SMS send or replay");
} finally {
	if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
	store.close();
	rmSync(directory, { recursive: true, force: true });
	resetYield();
	resetUserVisibleDeliveryState();
}

console.log("runner delivery failure regression passed");
