import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackSocketAdapter } from "../src/adapters/slack-socket.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import type { ChannelStore } from "../src/store.js";

const workingDir = mkdtempSync(join(tmpdir(), "tm-slack-dm-allowlist-"));

function handler(events: MomEvent[]): MomHandler {
	return {
		isRunning: () => false,
		handleEvent: async (event) => { events.push(event); },
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
}

function messageListener(adapter: SlackSocketAdapter): (payload: any) => Promise<void> {
	(adapter as any).setupEventHandlers();
	const listeners = (adapter as any).socketClient.listeners("message");
	assert.equal(listeners.length, 1, "socket adapter registers one message listener");
	return listeners[0];
}

function dm(user: string, channel: string, text: string) {
	return {
		event: {
			type: "message",
			channel,
			channel_type: "im",
			user,
			text,
			ts: "1710000000.000100",
		},
		body: { team_id: "T1111111111" },
	};
}

try {
	const store = { processAttachments: () => [] } as unknown as ChannelStore;
	const allowedEvents: MomEvent[] = [];
	const restricted = new SlackSocketAdapter({
		appToken: "xapp-test",
		botToken: "xoxb-test",
		workingDir,
		store,
		allowedDmUserIds: ["U_ALEX"],
	});
	restricted.setHandler(handler(allowedEvents));
	(restricted as any).botUserId = "U_BATMAN";
	const restrictedListener = messageListener(restricted);

	let deniedAck = 0;
	await restrictedListener({
		...dm("U_OTHER", "D_DENIED", "private text that must not persist"),
		ack: () => { deniedAck++; },
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(deniedAck, 1, "rejected DM is acknowledged exactly once");
	assert.equal(allowedEvents.length, 0, "non-allowlisted DM never reaches the agent handler");
	assert.equal(restricted.getChannel("D_DENIED"), undefined, "rejected DM does not enter channel metadata");
	assert.equal(existsSync(join(workingDir, "log.jsonl")), false, "rejected DM is not written to the workspace log");

	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => { unhandled.push(error); };
	process.on("unhandledRejection", onUnhandled);
	await restrictedListener({
		...dm("U_OTHER", "D_DENIED", "another denied message"),
		ack: async () => { throw new Error("socket disconnected before acknowledgement"); },
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	process.off("unhandledRejection", onUnhandled);
	assert.equal(unhandled.length, 0, "a rejected Socket Mode acknowledgement never becomes an unhandled rejection");

	let allowedAck = 0;
	await restrictedListener({
		...dm("U_ALEX", "D_ALLOWED", "hello Batman"),
		ack: () => { allowedAck++; },
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(allowedAck, 1, "allowlisted DM is acknowledged exactly once");
	assert.equal(allowedEvents.length, 1, "allowlisted DM reaches the agent handler");
	assert.equal(allowedEvents[0]?.user, "U_ALEX", "allowed sender identity is preserved");
	assert.match(readFileSync(join(workingDir, "log.jsonl"), "utf8"), /hello Batman/, "allowed DM is logged normally");

	const legacyEvents: MomEvent[] = [];
	const unrestricted = new SlackSocketAdapter({
		appToken: "xapp-test",
		botToken: "xoxb-test",
		workingDir,
		store,
	});
	unrestricted.setHandler(handler(legacyEvents));
	(unrestricted as any).botUserId = "U_BATMAN";
	const unrestrictedListener = messageListener(unrestricted);
	await unrestrictedListener({
		...dm("U_ANYONE", "D_LEGACY", "legacy access"),
		ack: () => {},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(legacyEvents.length, 1, "unset allowlist preserves legacy allow-all DM behavior");

	console.log("slack-dm-allowlist ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
