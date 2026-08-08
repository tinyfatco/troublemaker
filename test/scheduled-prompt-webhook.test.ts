import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ScheduledPromptWebhookIngress,
} from "../src/adapters/scheduled-prompt-webhook.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "../src/adapters/types.js";

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

function adapter(onRun: (event: MomEvent) => Promise<void>): PlatformAdapter & { runScheduledEvent(event: MomEvent): Promise<void> } {
	return {
		name: "heartbeat",
		maxMessageLength: 100000,
		formatInstructions: "headless",
		start: async () => {},
		stop: async () => {},
		postMessage: async () => "1",
		updateMessage: async () => {},
		deleteMessage: async () => {},
		postInThread: async () => "1",
		uploadFile: async () => {},
		logToFile: () => {},
		logBotResponse: () => {},
		getUser: () => undefined,
		getChannel: (channelId) => channelId === "heartbeat" ? { id: "heartbeat", name: "heartbeat" } : undefined,
		getAllUsers: () => [],
		getAllChannels: () => [{ id: "heartbeat", name: "heartbeat" }],
		enqueueEvent: () => false,
		createContext: () => { throw new Error("not used"); },
		runScheduledEvent: onRun,
	};
}

function payload(idCharacter: string, overrides: Record<string, unknown> = {}) {
	return {
		deliveryId: `scheduled:${idCharacter.repeat(64)}`,
		hostContextId: "front-desk:example:intake",
		schedule: {
			filename: "example.json",
			generation: 1,
			canonicalSlotAt: "2026-06-01T00:00:00.000Z",
			fireAt: "2026-06-01T00:00:00.000Z",
		},
		event: {
			type: "one-shot",
			at: "2026-06-01T00:00:00.000Z",
			text: "review the exact scheduled task",
			channelId: "heartbeat",
		},
		...overrides,
	};
}

async function withServer(ingress: ScheduledPromptWebhookIngress, work: (base: string) => Promise<void>) {
	const server = createServer((req, res) => ingress.dispatch(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address === "object");
	try {
		await work(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

const directory = await mkdtemp(join(tmpdir(), "scheduled-prompt-ingress-"));
let runs = 0;
let compactions = 0;
const heartbeat = adapter(async (event) => {
	runs++;
	assert.match(event.text, /^\[ATTENTION:example\.json:one-shot:/);
});
const handler = {
	isRunning: () => false,
	handleSlashCommand: async () => false,
	handleSteer: async () => {},
	handleStop: async () => {},
	resolvePendingInput: () => false,
	handleEvent: async () => {},
} satisfies MomHandler;

function makeIngress() {
	const ingress = new ScheduledPromptWebhookIngress({
		workingDir: directory,
		inboundToken: "exact-scheduled-token",
		hostContextId: "front-desk:example:intake",
		adapters: [heartbeat],
		onCompact: async () => { compactions++; },
	});
	ingress.setHandler(handler);
	return ingress;
}

try {
	await withServer(makeIngress(), async (base) => {
		const unauthorized = await fetch(base, {
			method: "POST",
			headers: { authorization: "Bearer broad-token", "content-type": "application/json" },
			body: JSON.stringify(payload("a")),
		});
		assert.equal(unauthorized.status, 401);

		const wrongContext = await fetch(base, {
			method: "POST",
			headers: { authorization: "Bearer exact-scheduled-token", "content-type": "application/json" },
			body: JSON.stringify(payload("b", { hostContextId: "front-desk:other:intake" })),
		});
		assert.equal(wrongContext.status, 400);

		const accepted = await fetch(base, {
			method: "POST",
			headers: { authorization: "Bearer exact-scheduled-token", "content-type": "application/json" },
			body: JSON.stringify(payload("c")),
		});
		assert.equal(accepted.status, 202);
		await waitFor(() => runs === 1, "scheduled run was not awaited");
	});

	await withServer(makeIngress(), async (base) => {
		const duplicate = await fetch(base, {
			method: "POST",
			headers: { authorization: "Bearer exact-scheduled-token", "content-type": "application/json" },
			body: JSON.stringify(payload("c")),
		});
		assert.equal(duplicate.status, 202);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(runs, 1, "restart-persistent delivery ledger suppresses duplicate work");

		const noOp = await fetch(base, {
			method: "POST",
			headers: { authorization: "Bearer exact-scheduled-token", "content-type": "application/json" },
			body: JSON.stringify(payload("d", {
				event: { type: "one-shot", at: "2026-06-01T00:00:00.000Z", text: "no side effect", action: "noop" },
			})),
		});
		assert.equal(noOp.status, 202);

		const compact = await fetch(base, {
			method: "POST",
			headers: { authorization: "Bearer exact-scheduled-token", "content-type": "application/json" },
			body: JSON.stringify(payload("e", {
				event: { type: "periodic", schedule: "0 10 * * *", timezone: "UTC", text: "compact", action: "compact" },
			})),
		});
		assert.equal(compact.status, 202);
		await waitFor(async () => {
			try {
				const lines = (await readFile(join(directory, "scheduled-inbound-deliveries.jsonl"), "utf8")).trim().split("\n");
				return lines.length === 3;
			} catch { return false; }
		}, "durable scheduled delivery receipts were not recorded");
		assert.equal(compactions, 1);
		assert.equal(runs, 1, "no-op and compaction do not invoke a model run");
	});
} finally {
	await rm(directory, { recursive: true, force: true });
}

console.log("scheduled prompt webhook ok");
