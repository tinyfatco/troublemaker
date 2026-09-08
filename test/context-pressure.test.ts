import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeUnconditionalCompactionSchedules } from "../src/compaction-schedule.js";
import { DEFAULT_COMPACTION } from "../src/context.js";
import {
	buildConciseWatchRuntimeContext,
	buildRuntimeContext,
	buildWorkspaceRuntimeContext,
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

type HookResult = {
	systemPrompt: string;
	message?: { customType: string; content: string; display: boolean };
};
let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<HookResult>) | undefined;
let history: AgentMessage[] = [];
let snapshot = buildWorkspaceRuntimeContext(options);
const register = () => {
	createDynamicRuntimeContextExtension(() => "current-system-prompt", () => snapshot, () => history)({
		on(event: string, handler: typeof beforeAgentStart) {
			if (event === "before_agent_start") beforeAgentStart = handler;
		},
	} as never);
};
register();
const runHook = () => beforeAgentStart!({ systemPrompt: "base-system-prompt" });
const retain = (result: HookResult) => {
	if (result.message) history.push({ role: "custom", ...result.message, timestamp: 1 });
};
const first = await runHook();
assert.equal(first.systemPrompt, "current-system-prompt", "workspace state never mutates the system prefix");
assert.equal(first.message?.content, snapshot, "first run receives full current workspace context");
assert.equal(first.message?.display, false, "runtime metadata is not displayed as conversation");
retain(first);
const originalHistory = JSON.stringify(convertToLlm(history));
assert.equal((await runHook()).message, undefined, "unchanged context is not duplicated");

const otherRoute = { ...options, displayChannelId: "C1111111111", displayChannelName: "other-example", verbosity: "messages-only" as const };
snapshot = buildWorkspaceRuntimeContext(otherRoute);
assert.equal(snapshot, first.message?.content, "channel and delivery-policy changes do not alter workspace context");
assert.match(buildSessionRoutingPreamble(otherRoute), /Attending: other-example/, "new input retains current route");
assert.match(buildSessionRoutingPreamble(otherRoute), /Channel delivery policy:/, "new input retains current delivery policy");
const switched = await runHook();
assert.equal(switched.systemPrompt, first.systemPrompt, "switching channels keeps the system prompt byte-identical");
assert.equal(switched.message, undefined, "switching channels does not append another workspace copy");
assert.equal(JSON.stringify(convertToLlm(history)), originalHistory, "existing provider-visible history remains byte-identical");

snapshot = buildWorkspaceRuntimeContext({ ...otherRoute, workspaceContext: "updated example workspace" });
const changed = await runHook();
assert.equal(changed.systemPrompt, first.systemPrompt, "workspace updates also keep the system prefix stable");
assert.equal(changed.message?.content, snapshot, "workspace updates append fresh context");
retain(changed);
assert.equal(JSON.stringify(convertToLlm(history.slice(0, 1))), originalHistory, "updates never rewrite prior snapshot content");
register();
assert.equal((await runHook()).message, undefined, "restart deduplication uses restored model history, not closure state");
snapshot = first.message!.content;
assert.ok((await runHook()).message, "reverting workspace state compares the latest snapshot rather than any old matching snapshot");
history = [];
assert.equal((await runHook()).message?.content, snapshot, "compaction/projection that removes the snapshot restores full current context");
const session = SessionManager.inMemory();
session.appendCustomMessageEntry("runtime-context", snapshot, false);
const kept = session.appendMessage({ role: "user", content: "Example input", timestamp: 1 });
history = session.buildSessionContext().messages;
assert.equal((await runHook()).message, undefined, "persisted custom snapshots survive session reconstruction");
session.appendCompaction("Example summary", kept, 100);
history = session.buildSessionContext().messages;
assert.equal((await runHook()).message?.content, snapshot, "actual session compaction restores a summarized-away snapshot");


assert.equal(DEFAULT_COMPACTION.reserveTokens, 16_384, "integrated runtime keeps Pi-native fixed response headroom");
assert.equal(DEFAULT_COMPACTION.keepRecentTokens, 20_000, "integrated runtime keeps Pi-native recent context");
assert.equal("thresholdPercent" in DEFAULT_COMPACTION, false, "removed percentage translation cannot return through mobile integration");

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
assert.match(
	agentSource,
	/activeRuntimeContext = buildWorkspaceRuntimeContext\(sessionContextOptions\)/,
	"runner keeps volatile channel state out of workspace snapshots",
);
assert.match(agentSource, /\(\) => agent\.state\.messages/, "snapshot deduplication inspects the actual post-compaction model history");

assert.match(agentSource, /const sessionPreamble = buildSessionRoutingPreamble\(sessionContextOptions\)/, "runner appends only lightweight routing context");
assert.doesNotMatch(agentSource, /SessionContextProjector/, "repair does not depend on fragile transcript references");
const canonicalSource = await readFile(new URL("../src/console/voice-session-canonical.ts", import.meta.url), "utf8");
assert.match(
	canonicalSource,
	/input\.responsePolicy === "concise_watch"[\s\S]*contextProjection: "concise_watch" as const/,
	"only the authenticated concise Watch response policy selects the bounded prompt branch",
);

console.log("context pressure: ok");
