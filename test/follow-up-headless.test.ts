import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FollowUpAdapter } from "../src/adapters/follow-up.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "../src/adapters/types.js";
import { EventsWatcher } from "../src/events.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
	const workingDir = mkdtempSync(join(tmpdir(), "follow-up-headless-"));
	const queueDir = join(workingDir, "attention", "queue");
	mkdirSync(queueDir, { recursive: true });

	const adapter = new FollowUpAdapter({ workingDir });
	let externalEnqueues = 0;
	let harnessPosts = 0;
	let handledEvent: MomEvent | null = null;
	let finish!: () => void;
	const handled = new Promise<void>((resolve) => { finish = resolve; });

	adapter.postMessage = async () => {
		harnessPosts++;
		return "unexpected";
	};
	adapter.setHandler({
		isRunning: () => false,
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleEvent: async (event, platform) => {
			handledEvent = event;
			assert.equal(platform.name, "follow-up", "the dedicated headless adapter owns generated wakes");
			const context = platform.createContext(event, {} as any, true);
			assert.equal(context.message.directlyAddressed, false, "the model sees a non-direct evaluation");
			assert.equal(context.message.replyTarget, "slack:C0000000000:1000000000.000001");
			await context.setTyping(true);
			await context.setWorking(true);
			await context.respond("ordinary working text");
			await context.sendFinalResponse("ordinary final text");
			await context.setWorking(false);
			finish();
			return { stopReason: "end_turn" };
		},
	} as MomHandler);

	const externalAdapter = {
		enqueueEvent() {
			externalEnqueues++;
			return true;
		},
	} as unknown as PlatformAdapter;
	const watcher = new EventsWatcher(queueDir, [adapter, externalAdapter]);

	try {
		writeFileSync(join(queueDir, "follow-up-synthetic.json"), JSON.stringify({
			type: "one-shot",
			channelId: "C0000000000",
			at: new Date(Date.now() + 80).toISOString(),
			text: "Review whether one short check-in is useful.",
			sourceEventType: "follow_up",
			replyTarget: "slack:C0000000000:1000000000.000001",
			replyTargetDescription: "synthetic thread",
			threadTs: "1000000000.000001",
			followUp: { key: "synthetic-key", generation: "synthetic-generation", ordinal: 0 },
		}, null, 2));
		watcher.start();
		await Promise.race([
			handled,
			sleep(1500).then(() => { throw new Error("Timed out waiting for headless follow-up wake"); }),
		]);
		assert(handledEvent);
		assert.equal(handledEvent.directlyAddressed, false, "the scheduler marks follow-up wakes non-direct");
		assert.equal(externalEnqueues, 0, "the original external adapter never receives the generated wake");
		assert.equal(harnessPosts, 0, "working and final harness output remain headless");
		assert(adapter.formatInstructions.includes("yield_no_action"), "headless instructions preserve explicit silence");
		assert(adapter.formatInstructions.includes("send_message"), "headless instructions preserve deliberate delivery");
	} finally {
		watcher.stop();
		rmSync(workingDir, { recursive: true, force: true });
	}
}

main().then(() => {
	console.log("follow-up headless tests passed");
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
