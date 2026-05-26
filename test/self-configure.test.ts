import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applySelfConfiguration, createSelfConfigureTool } from "../src/tools/self-configure.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

function readSettings(workingDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(workingDir, "settings.json"), "utf-8")) as Record<string, unknown>;
}

const workingDir = mkdtempSync(join(tmpdir(), "self-configure-"));

try {
	const model = applySelfConfiguration(workingDir, "model", "minimax");
	let settings = readSettings(workingDir);
	assert(model.newValue === "fireworks/accounts/fireworks/models/minimax-m2p7", "model alias resolves to canonical provider/model");
	assert(settings.defaultProvider === "fireworks", "model writes defaultProvider");
	assert(settings.defaultModel === "accounts/fireworks/models/minimax-m2p7", "model writes defaultModel");

	const thinking = applySelfConfiguration(workingDir, "thinking_level", "low");
	settings = readSettings(workingDir);
	assert(thinking.newValue === "low", "thinking level result reports new value");
	assert(settings.thinking_level === "low", "thinking_level writes canonical key");
	assert(settings.defaultThinkingLevel === "low", "thinking_level keeps legacy key in sync");

	const spontaneity = applySelfConfiguration(workingDir, "spontaneity.level", 5);
	settings = readSettings(workingDir);
	assert((settings.spontaneity as any).level === 5, "spontaneity level writes settings");
	assert((settings.spontaneity as any).intervalMinutes === 45, "spontaneity level recomputes interval");
	assert(existsSync(join(workingDir, "attention", "queue", "heartbeat.json")), "spontaneity change resyncs heartbeat schedule");
	assert(spontaneity.schedule?.enabled === true, "spontaneity result reports schedule");

	const checklist = applySelfConfiguration(workingDir, "heartbeat.checklist", "Check the inbox.");
	assert(checklist.path === "HEARTBEAT.md", "heartbeat checklist reports file path");
	assert(readFileSync(join(workingDir, "HEARTBEAT.md"), "utf-8") === "Check the inbox.", "heartbeat checklist writes file");

	const tool = createSelfConfigureTool(workingDir);
	const result = await (tool.execute as any)("call-1", {
		label: "set thinking high",
		setting: "thinking_level",
		value: "high",
	});
	settings = readSettings(workingDir);
	assert(settings.thinking_level === "high", "tool execute applies setting");
	assert((result.content?.[0]?.text || "").includes("Configured thinking_level"), "tool result summarizes setting");

	try {
		applySelfConfiguration(workingDir, "verbose", true);
		assert(false, "unsupported setting throws");
	} catch (err) {
		assert(err instanceof Error && err.message.includes("Unknown self_configure setting"), "unsupported setting fails closed");
	}
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
