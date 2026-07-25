import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MomSettingsManager } from "../src/context.js";

const workingDir = mkdtempSync(join(tmpdir(), "troublemaker-pi-batched-steering-"));
try {
	const settings = new MomSettingsManager(workingDir);
	assert.equal(
		settings.getSteeringMode(),
		"all",
		"every resident session asks Pi to drain all pending steering messages together",
	);

	const agent = readFileSync("src/agent.ts", "utf8");
	assert.match(
		agent,
		/steeringMode:\s*"all"/,
		"the core Pi Agent starts in batched steering mode before AgentSession initialization",
	);
	assert.match(
		agent,
		/activeSession\.steer\(text\)\.then[\s\S]*?activeSession\.waitForIdle\(\)/,
		"durable ingress can keep its receipt alive until Pi's batched session settles",
	);

	const workspaceRouter = readFileSync("src/adapters/workspace-channel-runtime.ts", "utf8");
	assert.match(
		workspaceRouter,
		/const settled = handler\.handleSteer\(event, adapter\);[\s\S]*?if \(awaitCompletion\) await settled/,
		"host-managed collaboration adapters await batched steering settlement",
	);

	for (const adapter of [
		"src/adapters/email-webhook.ts",
		"src/adapters/phone-messaging-webhook.ts",
	]) {
		const source = readFileSync(adapter, "utf8");
		assert.match(
			source,
			/await this\.handler\.handleSteer\(event, this\)/,
			`${adapter} keeps its host receipt alive for a batched steer`,
		);
	}
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("pi batched steering ok");
