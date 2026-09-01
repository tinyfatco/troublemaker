import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeUnconditionalCompactionSchedules } from "../src/compaction-schedule.js";
import { DEFAULT_COMPACTION } from "../src/context.js";
import {
	buildConciseWatchRuntimeContext,
	buildRuntimeContext,
	buildSessionPreamble,
	buildSessionRoutingPreamble,
} from "../src/core/prompt.js";
import { createDynamicRuntimeContextExtension } from "../src/extensions/dynamic-runtime-context.js";

const largeWorkspaceMarker = "workspace-memory-marker-".repeat(10_000);
const options = {
	workspaceContext: largeWorkspaceMarker,
	channels: [{ id: "C0123456789", name: "example" }],
	users: [{ id: "U0123456789", userName: "casey", displayName: "Casey" }],
	skills: [],
	displayChannelId: "C0123456789",
	displayChannelName: "example",
};

const runtimeContext = buildRuntimeContext(options);
const watchRuntimeContext = buildConciseWatchRuntimeContext(options);
const routingContext = buildSessionRoutingPreamble(options);
assert.match(runtimeContext, /^<runtime_context>/, "full dynamic state is marked as runtime context");
assert.ok(runtimeContext.includes(largeWorkspaceMarker), "runtime context retains complete workspace memory");
assert.ok(watchRuntimeContext.includes(largeWorkspaceMarker), "concise Watch retains complete workspace memory");
assert.ok(
	watchRuntimeContext.indexOf(largeWorkspaceMarker) < watchRuntimeContext.indexOf("Attending:"),
	"concise Watch places stable workspace memory before volatile route state",
);
assert.ok(
	runtimeContext.indexOf("Attending:") < runtimeContext.indexOf(largeWorkspaceMarker),
	"non-Watch runtime context preserves its established byte ordering",
);
assert.match(routingContext, /^<session_context>/, "each message retains explicit routing context");
assert.match(routingContext, /Attending: example \(C0123456789\)/, "routing keeps the attending channel");
assert.match(routingContext, /C0123456789\t#example/, "routing keeps channel identity");
assert.match(routingContext, /U0123456789\t@casey\tCasey/, "routing keeps user identity");
assert.ok(!routingContext.includes(largeWorkspaceMarker), "large workspace memory does not accumulate in user messages");
assert.ok(routingContext.length < 1_000, "routing context stays bounded for a small channel map");
assert.ok(buildSessionPreamble(
	options.workspaceContext,
	options.channels,
	options.users,
	options.skills,
	options.displayChannelId,
	options.displayChannelName,
).includes(largeWorkspaceMarker), "legacy callers still receive a complete context block");

let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
const extension = createDynamicRuntimeContextExtension(() => "current-system-prompt", () => runtimeContext);
extension({
	on(event: string, handler: typeof beforeAgentStart) {
		if (event === "before_agent_start") beforeAgentStart = handler;
	},
} as never);
assert.ok(beforeAgentStart, "dynamic context extension registers before_agent_start");
const extensionResult = await beforeAgentStart!({ systemPrompt: "base-system-prompt" });
assert.equal(extensionResult?.systemPrompt, `current-system-prompt\n\n${runtimeContext}`, "runtime context is applied to Troublemaker's current system prompt");

assert.equal(DEFAULT_COMPACTION.reserveTokens, 16_384, "compaction uses Pi's native fixed response headroom");
assert.equal(DEFAULT_COMPACTION.keepRecentTokens, 20_000, "compaction uses Pi's native recent-context retention");

const root = mkdtempSync(join(tmpdir(), "troublemaker-compaction-schedule-"));
try {
	const current = join(root, "attention", "queue", "compaction.json");
	const legacy = join(root, "events", "compaction.json");
	mkdirSync(join(root, "attention", "queue"), { recursive: true });
	mkdirSync(join(root, "events"), { recursive: true });
	writeFileSync(current, "{}\n");
	writeFileSync(legacy, "{}\n");
	const cleanup = removeUnconditionalCompactionSchedules(root);
	assert.deepEqual(cleanup.failures, [], "scheduled compaction cleanup succeeds");
	assert.deepEqual(new Set(cleanup.removed), new Set([current, legacy]), "both current and legacy schedules are removed");
} finally {
	await rm(root, { recursive: true, force: true });
}

const agentSource = await readFile(new URL("../src/agent.ts", import.meta.url), "utf8");
assert.doesNotMatch(agentSource, /thresholdPercent/, "runner does not translate Pi's fixed headroom into a model percentage");
assert.match(
	agentSource,
	/activeRuntimeContext = ctx\.message\.contextProjection === "concise_watch"\s*\? buildConciseWatchRuntimeContext\(sessionContextOptions\)\s*:\s*buildRuntimeContext\(sessionContextOptions\)/,
	"runner refreshes the full established runtime context unless the trusted concise Watch policy is explicit",
);
assert.match(agentSource, /const sessionPreamble = buildSessionRoutingPreamble\(sessionContextOptions\)/, "runner appends only lightweight routing context");
assert.doesNotMatch(agentSource, /SessionContextProjector/, "repair does not depend on fragile transcript references");
const canonicalSource = await readFile(new URL("../src/console/voice-session-canonical.ts", import.meta.url), "utf8");
assert.match(
	canonicalSource,
	/input\.responsePolicy === "concise_watch"[\s\S]*contextProjection: "concise_watch" as const/,
	"only the authenticated concise Watch response policy selects the bounded prompt branch",
);

console.log("context pressure: ok");
