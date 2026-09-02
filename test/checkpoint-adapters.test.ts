import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessCheckpointAdapter } from "../src/adapters/checkpoint.js";
import { FollowUpAdapter } from "../src/adapters/follow-up.js";
import { HeartbeatAdapter } from "../src/adapters/heartbeat.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function event(text: string, overrides: Partial<MomEvent> = {}): MomEvent {
	return {
		type: "mention",
		channel: "checkpoint",
		ts: "1000000000.000001",
		user: "EVENT",
		text,
		...overrides,
	};
}

async function main(): Promise<void> {
	assert(HeartbeatAdapter.prototype instanceof HeadlessCheckpointAdapter);
	assert(FollowUpAdapter.prototype instanceof HeadlessCheckpointAdapter);

	const queueDir = mkdtempSync(join(tmpdir(), "checkpoint-queue-"));
	try {
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let finishSecond!: () => void;
		const secondHandled = new Promise<void>((resolve) => { finishSecond = resolve; });
		const checkpoint = new HeadlessCheckpointAdapter({
			name: "checkpoint",
			channelName: "checkpoint",
			workingDir: queueDir,
			formatInstructions: "Internal checkpoint",
			queueLimit: 1,
			acceptsEvent: (candidate) => candidate.channel === "checkpoint",
			createMessage: (candidate) => ({
				text: candidate.text,
				rawText: candidate.rawText ?? candidate.text,
				user: candidate.user,
				channel: candidate.channel,
				ts: candidate.ts,
				attachments: [],
			}),
			startLog: "Checkpoint ready",
			queueFullLog: () => "Checkpoint queue full",
			runFailedLog: "Checkpoint failed",
		});
		checkpoint.setHandler({
			isRunning: () => false,
			handleSlashCommand: async () => false,
			handleSteer: () => {},
			handleEvent: async (candidate, platform, isScheduled) => {
				order.push(candidate.text);
				assert.equal(platform, checkpoint);
				assert.equal(isScheduled, true);
				if (candidate.text === "first") await firstBlocked;
				if (candidate.text === "second") finishSecond();
				return { stopReason: "end_turn" };
			},
		} as MomHandler);

		assert.equal(checkpoint.enqueueEvent(event("wrong", { channel: "other" })), false);
		assert.equal(checkpoint.enqueueEvent(event("first")), true);
		await sleep(10);
		assert.equal(checkpoint.enqueueEvent(event("second")), true);
		assert.equal(checkpoint.enqueueEvent(event("third")), false, "the configured pending queue bound is enforced");
		releaseFirst();
		await Promise.race([
			secondHandled,
			sleep(1_000).then(() => { throw new Error("Timed out waiting for sequential checkpoint processing"); }),
		]);
		assert.deepEqual(order, ["first", "second"], "checkpoint events run sequentially and rejected events never run");
		const context = checkpoint.createContext(event("context"), {} as never, true);
		await context.respond("discarded");
		await context.sendFinalResponse("discarded");
		assert.deepEqual(checkpoint.getAllUsers(), []);
		assert.deepEqual(checkpoint.getAllChannels(), []);
	} finally {
		rmSync(queueDir, { recursive: true, force: true });
	}

	const heartbeatDir = mkdtempSync(join(tmpdir(), "checkpoint-heartbeat-"));
	try {
		writeFileSync(join(heartbeatDir, "HEARTBEAT.md"), "# Checklist\n\n- Review the queue.\n", "utf8");
		const heartbeat = new HeartbeatAdapter({ workingDir: heartbeatDir });
		const handled: MomEvent[] = [];
		let finishHeartbeat!: () => void;
		const heartbeatHandled = new Promise<void>((resolve) => { finishHeartbeat = resolve; });
		heartbeat.setHandler({
			isRunning: () => false,
			handleSlashCommand: async () => false,
			handleSteer: () => {},
			handleEvent: async (candidate, platform) => {
				handled.push(candidate);
				const context = platform.createContext(candidate, {} as never, true);
				assert.equal(context.message.rawText, candidate.text);
				assert.equal(context.message.userName, "heartbeat");
				finishHeartbeat();
				return { stopReason: "end_turn" };
			},
		} as MomHandler);
		assert.equal(heartbeat.enqueueEvent(event("reflect", { channel: "heartbeat" })), true);
		await Promise.race([
			heartbeatHandled,
			sleep(1_000).then(() => { throw new Error("Timed out waiting for heartbeat checkpoint"); }),
		]);
		assert.match(handled[0]?.text ?? "", /## Heartbeat Checklist\n# Checklist/);
		assert.deepEqual(heartbeat.getAllChannels(), [{ id: "heartbeat", name: "heartbeat" }]);
		heartbeat.logBotResponse("heartbeat", "quiet observation", "1000000000.000002");
		const logEntry = JSON.parse(readFileSync(join(heartbeatDir, "log.jsonl"), "utf8"));
		assert.equal(logEntry.channel, "heartbeat:heartbeat");
		assert.equal(logEntry.text, "quiet observation");

		writeFileSync(join(heartbeatDir, "HEARTBEAT.md"), "# Checklist\n\n- [ ]\n", "utf8");
		assert.equal(heartbeat.enqueueEvent(event("skip", { channel: "heartbeat" })), true);
		await sleep(50);
		assert.equal(handled.length, 1, "an effectively empty HEARTBEAT.md still suppresses the run");

		writeFileSync(join(heartbeatDir, "HEARTBEAT.md"), "Review current work.\n", "utf8");
		const boundedHeartbeat = new HeartbeatAdapter({ workingDir: heartbeatDir });
		let releaseActive!: () => void;
		const activeBlocked = new Promise<void>((resolve) => { releaseActive = resolve; });
		boundedHeartbeat.setHandler({
			isRunning: () => false,
			handleSlashCommand: async () => false,
			handleSteer: () => {},
			handleEvent: async () => {
				await activeBlocked;
				return { stopReason: "end_turn" };
			},
		} as MomHandler);
		assert.equal(boundedHeartbeat.enqueueEvent(event("active", { channel: "heartbeat" })), true);
		assert.equal(boundedHeartbeat.enqueueEvent(event("pending-1", { channel: "heartbeat" })), true);
		assert.equal(boundedHeartbeat.enqueueEvent(event("pending-2", { channel: "heartbeat" })), true);
		assert.equal(boundedHeartbeat.enqueueEvent(event("pending-3", { channel: "heartbeat" })), true);
		assert.equal(boundedHeartbeat.enqueueEvent(event("overflow", { channel: "heartbeat" })), false, "heartbeat retains its three-pending-event limit");
		releaseActive();
		await sleep(20);
	} finally {
		rmSync(heartbeatDir, { recursive: true, force: true });
	}
}

main().then(() => {
	console.log("checkpoint adapter tests passed");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
