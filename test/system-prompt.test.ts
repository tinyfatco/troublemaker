import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/core/prompt.js";
import { createExecutor } from "../src/sandbox.js";
import { YIELD_NO_ACTION_CONTRACT } from "../src/yield-contract.js";

const prompt = buildSystemPrompt(
	"/data",
	{ type: "host" },
	"format instructions",
	{
		id: "test-model",
		provider: "test-provider",
	},
);

assert(prompt.includes("Use the `scheduling` skill"), "system prompt points scheduling/calendar work to the scheduling skill");
assert(prompt.includes("send_message"), "system prompt names send_message");
assert(!prompt.includes("send_message_to_channel"), "system prompt no longer names send_message_to_channel");
assert(prompt.includes("list_channels"), "system prompt names list_channels");
assert(prompt.includes("Email thread targets"), "system prompt says list_channels discovers email thread targets");
assert(prompt.includes("SMS/iMessage conversation targets"), "system prompt says list_channels discovers phone conversation targets");
assert(prompt.includes("do not collapse distinct thread roots"), "system prompt preserves Slack thread distinctions");
assert(prompt.includes("group chat participants"), "system prompt preserves group chat distinctions");
assert(prompt.includes("read_thread"), "system prompt names read_thread");
assert(prompt.includes("react_to_message"), "system prompt names react_to_message");
assert(prompt.includes("exact Slack message target"), "system prompt constrains reactions to exact Slack messages");
assert(prompt.includes("never treat it as blanket approval"), "system prompt limits inbound reaction approval semantics");
assert(prompt.includes("execute it without asking for approval again"), "system prompt tells agents to execute clear authorized work");
assert(prompt.includes("act first, verify the outcome, and report"), "system prompt prefers action and verification for reversible work");
assert(prompt.includes("required capability is absent"), "system prompt limits questions to genuine capability or boundary blockers");
assert(prompt.includes("Never use approval-seeking as a substitute for attempting the work"), "system prompt rejects ceremonial approval gates");
assert(prompt.includes("previews are not enough to choose"), "system prompt tells agents to inspect conversation nuance");
assert(prompt.includes("email-thread:<id>"), "system prompt names email thread targets");
assert(prompt.includes("self_configure"), "system prompt names self_configure");
assert(prompt.includes("working-output routing"), "system prompt advertises working-output routing");
assert(prompt.includes("mode `fixed` with target `here`"), "system prompt explains fixed current-locus working output");
assert(prompt.includes("independent from messages-only user delivery"), "system prompt separates working labels from user delivery");
assert(prompt.includes("set_goal"), "system prompt names persistent goal tools");
assert(prompt.includes("complete_goal"), "system prompt explains how achieved goals close");
assert(prompt.includes("block_goal"), "system prompt explains how genuinely blocked goals stop continuation");
assert(prompt.includes("Do not turn ordinary one-turn requests into persistent goals"), "system prompt limits durable goal creation to explicit requests");
assert(prompt.includes("selective Slack tool streaming"), "system prompt names selective Slack tool streaming");
assert(prompt.includes("Slack tool-stream presentation (split or condensed)"), "system prompt advertises configurable Slack tool-stream grouping");
assert(prompt.includes("Slack tool-stream window minutes"), "system prompt advertises configurable Slack tool-stream window");
assert(prompt.includes("busy voice-webhook routing (interrupt or steer)"), "system prompt advertises configurable voice webhook routing");
assert(prompt.includes("set it to true only when its safe human-readable label"), "system prompt limits show:true to meaningful safe labels");
assert(prompt.includes("never put secrets, raw arguments, private content, or sensitive paths"), "system prompt protects surfaced labels from sensitive content");
assert(prompt.includes("yield_no_action"), "system prompt names yield_no_action");
assert(prompt.includes(YIELD_NO_ACTION_CONTRACT), "system prompt carries the canonical evaluated-silence contract");
assert(prompt.includes("agent-authored DM or group DM may end with `yield_no_action`"), "system prompt permits quiet direct-agent closure");
assert(prompt.includes("human-authored DM, @mention, or direct request always requires a user-visible response"), "system prompt keeps human direct response mandatory");
assert(prompt.includes("Active runtime model: test-provider/test-model"), "system prompt includes the exact active model identity");
assert(!prompt.includes("Use `ping`"), "system prompt no longer instructs the ping tool");
assert(!prompt.includes("ping (cross-channel messaging)"), "system prompt no longer lists ping as cross-channel messaging");
assert(!prompt.includes("## Calendar Events"), "calendar event details moved out of the system prompt");
assert(!prompt.includes("## Attention Queue"), "attention queue details moved out of the system prompt");

const claudeCliPrompt = buildSystemPrompt(
	"/srv/claude-agent/workspace",
	{ type: "host" },
	"format instructions",
	{ id: "sonnet", provider: "claude-cli" },
);
assert(claudeCliPrompt.includes("built-in action tools are disabled"), "Claude CLI prompt identifies the MCP-only action boundary");
assert(claudeCliPrompt.includes("only `ToolSearch` remains"), "Claude CLI prompt identifies the non-acting discovery exception");
assert(claudeCliPrompt.includes("`troublemaker` MCP server"), "Claude CLI prompt identifies the runtime tool bridge");
assert(claudeCliPrompt.includes("mcp__troublemaker__<tool_name>"), "Claude CLI prompt explains namespaced runtime tools");
assert(claudeCliPrompt.includes("select:mcp__troublemaker__send_message"), "Claude CLI prompt gives the exact deferred send_message selection query");
assert(claudeCliPrompt.includes("select:mcp__troublemaker__react_to_message"), "Claude CLI prompt gives the exact deferred reaction selection query");
assert(claudeCliPrompt.includes("select:mcp__troublemaker__yield_no_action"), "Claude CLI prompt gives the exact deferred yield selection query");
assert(claudeCliPrompt.includes("mcp__troublemaker__bash"), "Claude CLI prompt names MCP-backed core tools instead of native actions");
assert(claudeCliPrompt.includes("native `SendMessage`"), "Claude CLI prompt distinguishes the unrelated native team tool");
assert(claudeCliPrompt.includes("Active runtime model: claude-cli/sonnet"), "Claude CLI prompt reports its exact model alias");
assert(claudeCliPrompt.includes("When a cross-channel message arrives mid-run, use `send_message`"), "Claude CLI prompt preserves cross-channel delivery guidance");

const dockerWorkspacePath = createExecutor({ type: "docker", container: "test-container" }).getWorkspacePath("/host/data");
const dockerPrompt = buildSystemPrompt(
	dockerWorkspacePath,
	{ type: "docker", container: "test-container" },
	"format instructions",
	{
		id: "test-model",
		provider: "test-provider",
	},
);

assert.equal(dockerWorkspacePath, "/data", "docker executor exposes /data as the workspace path");
assert(dockerPrompt.includes("## Workspace\n/data/"), "docker system prompt points agents at /data");
assert(!dockerPrompt.includes("/workspace"), "docker system prompt must not mention stale /workspace path");

console.log("system-prompt ok");
