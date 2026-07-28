import assert from "node:assert/strict";
import { TelegramPollingAdapter } from "../src/adapters/telegram-polling.js";

async function main(): Promise<void> {
	const calls: string[] = [];
	const adapter = new TelegramPollingAdapter({
		botToken: "123456:synthetic-token",
		workingDir: "/tmp/example-telegram-workspace",
	});

	(adapter as any).bot = {
		getMe: async () => {
			calls.push("getMe");
			return { id: 123456, username: "ExampleBot" };
		},
		on: (event: string) => {
			assert.equal(event, "message");
			calls.push("on:message");
		},
		startPolling: () => {
			calls.push("startPolling");
			return Promise.resolve();
		},
	};
	adapter.setHandler({} as any);

	await adapter.start();

	assert.deepEqual(calls, ["getMe", "on:message", "startPolling"]);
	console.log("telegram polling startup test passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
