import { buildSessionPreamble } from "../src/core/prompt.js";
import { readFileSync } from "fs";

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

const workspaceContext = "Workspace:\n(none)";

const webPreamble = buildSessionPreamble(
	workspaceContext,
	[],
	[],
	[],
	"web",
	undefined,
	"messages-only",
);

assert(webPreamble.includes("Attending: web"), "web preamble still identifies the attending channel");
assert(!webPreamble.includes("send_message with an explicit target for ALL communication"), "web direct chat does not instruct the agent to use send_message");
assert(!webPreamble.includes("your text output will NOT be delivered"), "web direct chat does not claim direct text output is undeliverable");

const agentSource = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf-8");
assert(!agentSource.includes("<project_context>"), "agent prompt assembly does not inject project_context");
assert(!agentSource.includes("Project-room rules:"), "agent prompt assembly does not inject project-room rules");

const telegramPreamble = buildSessionPreamble(
	workspaceContext,
	[],
	[],
	[],
	"8389147137",
	"telegram",
	"messages-only",
);

assert(telegramPreamble.includes("Channel delivery policy"), "non-web messages-only channels show the channel delivery policy");
assert(telegramPreamble.includes("Use send_message with an explicit target"), "non-web messages-only channels keep the send_message reminder");

const verboseSlackPreamble = buildSessionPreamble(
	workspaceContext,
	[],
	[],
	[],
	"C1234567890",
	"tinyfat",
	true,
);
assert(!verboseSlackPreamble.includes("Channel delivery policy"), "verbose Slack does not claim harness output is undeliverable");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
