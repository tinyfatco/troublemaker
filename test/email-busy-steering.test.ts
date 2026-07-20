import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailWebhookAdapter } from "../src/adapters/email-webhook.js";
import type { MomEvent, MomHandler, SlashCommandResult } from "../src/adapters/types.js";

function makeHandler() {
	const steered: MomEvent[] = [];
	const handled: MomEvent[] = [];

	const handler: MomHandler = {
		isRunning: () => true,
		handleEvent: async (event) => {
			handled.push(event);
		},
		handleSlashCommand: async (): Promise<SlashCommandResult> => false,
		handleSteer: (event) => {
			steered.push(event);
		},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};

	return { handler, steered, handled };
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-email-busy-"));

try {
	const adapter = new EmailWebhookAdapter({
		workingDir,
		toolsToken: "test-token",
		sendUrl: "https://example.invalid/send",
	});
	const { handler, steered, handled } = makeHandler();
	adapter.setHandler(handler);

	await (adapter as unknown as {
		processEmail(payload: {
			from: string;
			to: string;
			subject: string;
			body: string;
			messageId?: string;
		}): Promise<void>;
	}).processEmail({
		from: "sender@example.com",
		to: "agent@example.com",
		subject: "Re: Respond here in thread",
		body: "fresh email during heartbeat",
		messageId: "<email-busy@example.com>",
	});

	assert.equal(handled.length, 0, "busy email should not start a parallel handleEvent run");
	assert.equal(steered.length, 1, "busy email should enter the shared steering path");
	assert.equal(steered[0]?.channel, "email-sender_example_com");
	assert.match(steered[0]?.text || "", /fresh email during heartbeat/);

	const directEvent: MomEvent = {
		type: "dm",
		channel: "email-sender_example_com",
		ts: "123",
		user: "sender@example.com",
		text: "direct queued event",
	};

	assert.equal(adapter.enqueueEvent(directEvent), true, "email enqueueEvent claims email channels");
	assert.equal(steered.length, 2, "busy enqueueEvent should also use steering instead of discarding input");
	assert.equal(steered[1], directEvent);
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("email busy steering ok");
