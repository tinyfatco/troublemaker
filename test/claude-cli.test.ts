import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	buildClaudeCliArgs,
	buildClaudeCliEnvironment,
	createClaudeCliStream,
	getClaudeCliModel,
	getClaudeCliRuntimeAuth,
	isClaudeCliAuthenticated,
	registerClaudeCliRuntimeAuth,
	resetClaudeCliAuthCache,
	resetClaudeCliSession,
} from "../src/claude-cli.js";
import { listModels, resolveModel } from "../src/model-config.js";
import { MomSettingsManager } from "../src/context.js";

const tempDir = mkdtempSync(join(tmpdir(), "troublemaker-claude-cli-test-"));
const workspaceDir = join(tempDir, "workspace");
const awarenessDir = join(workspaceDir, "awareness");
const invocationLog = join(tempDir, "invocations.jsonl");
const fakeClaude = join(tempDir, "fake-claude");

const originalEnv = new Map<string, string | undefined>();
const envKeys = [
	"MOM_CLAUDE_CLI_PATH",
	"MOM_CLAUDE_CLI_AUTH_CACHE_MS",
	"MOM_MODEL_PROVIDER",
	"MOM_MODEL_ID",
	"FAKE_CLAUDE_AUTHENTICATED",
	"FAKE_CLAUDE_INVOCATION_LOG",
	"FAKE_CLAUDE_REJECT_RESUME",
	"ANTHROPIC_API_KEY",
];
for (const key of envKeys) originalEnv.set(key, process.env[key]);

function restoreEnv(): void {
	for (const [key, value] of originalEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function readInvocations(): Array<{ args: string[]; input: string; leakedApiKey: boolean }> {
	if (!readFileSync(invocationLog, "utf8").trim()) return [];
	return readFileSync(invocationLog, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

function contextWith(messages: Context["messages"]): Context {
	return { systemPrompt: "You are the test agent.", messages, tools: [] };
}

async function collect(
	streamFn: ReturnType<typeof createClaudeCliStream>,
	model: Model<any>,
	context: Context,
): Promise<{ message: AssistantMessage; deltas: string[] }> {
	const stream = streamFn(model, context);
	const deltas: string[] = [];
	for await (const event of stream) {
		if (event.type === "text_delta") deltas.push(event.delta);
	}
	return { message: await stream.result(), deltas };
}

try {
	mkdirSync(awarenessDir, { recursive: true });
	writeFileSync(invocationLog, "");
	writeFileSync(
		fakeClaude,
		`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_AUTHENTICATED !== "false" }) + "\\n");
  process.exit(0);
}
(async () => {
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(process.env.FAKE_CLAUDE_INVOCATION_LOG, JSON.stringify({
  args,
  input,
  leakedApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
}) + "\\n");
const resumeIndex = args.indexOf("--resume");
if (resumeIndex >= 0 && process.env.FAKE_CLAUDE_REJECT_RESUME === "true") {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "error",
    is_error: true,
    result: "Session not found; cannot resume conversation",
    session_id: args[resumeIndex + 1],
    usage: {},
  }) + "\\n");
  process.exitCode = 1;
} else {
  const sessionFlag = resumeIndex >= 0 ? resumeIndex : args.indexOf("--session-id");
  const sessionId = args[sessionFlag + 1];
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "fake-claude-model" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "stream_event", parent_tool_use_id: "toolu_nested", event: { type: "content_block_delta", delta: { type: "text_delta", text: "nested leak" } } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "from claude" } } }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "hello from claude",
    session_id: sessionId,
    total_cost_usd: 0.25,
    usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
  }) + "\\n");
}
})();
`,
		{ mode: 0o755 },
	);
	chmodSync(fakeClaude, 0o755);

	process.env.MOM_CLAUDE_CLI_PATH = fakeClaude;
	process.env.MOM_CLAUDE_CLI_AUTH_CACHE_MS = "0";
	process.env.FAKE_CLAUDE_AUTHENTICATED = "true";
	process.env.FAKE_CLAUDE_INVOCATION_LOG = invocationLog;
	process.env.ANTHROPIC_API_KEY = "must-not-reach-claude";
	resetClaudeCliAuthCache();

	assert.equal(
		AuthStorage.create().getOAuthProviders().some((provider) => provider.id === "claude-cli"),
		false,
		"Claude CLI auth is never offered through Troublemaker /login",
	);
	const runtimeAuth = AuthStorage.inMemory();
	registerClaudeCliRuntimeAuth(runtimeAuth);
	const runtimeRegistry = ModelRegistry.create(runtimeAuth);
	assert.equal(
		runtimeRegistry.hasConfiguredAuth(getClaudeCliModel("sonnet")!),
		true,
		"Pi AgentSession's generic auth preflight accepts the local CLI backend",
	);
	assert.equal(runtimeAuth.has("claude-cli"), false, "the CLI preflight marker is never persisted as a credential");
	assert.ok(getClaudeCliRuntimeAuth("claude-cli"), "the low-level agent receives the same non-secret runtime marker");
	assert.equal(getClaudeCliRuntimeAuth("anthropic"), undefined, "normal providers never receive the CLI marker");
	assert.equal(isClaudeCliAuthenticated(), true, "existing Claude CLI auth is detected");
	const listed = listModels(undefined, { getAvailable: () => [], getAll: () => [] } as any);
	assert.deepEqual(
		listed.filter((model) => model.provider === "claude-cli").map((model) => model.id).sort(),
		["fable", "haiku", "opus", "sonnet"],
		"authenticated Claude CLI exposes exactly four aliases",
	);

	process.env.FAKE_CLAUDE_AUTHENTICATED = "false";
	resetClaudeCliAuthCache();
	assert.equal(isClaudeCliAuthenticated(), false, "missing Claude CLI auth is detected");
	assert.equal(
		listModels(undefined, { getAvailable: () => [], getAll: () => [] } as any)
			.some((model) => model.provider === "claude-cli"),
		false,
		"unauthenticated Claude CLI models stay out of /model discovery",
	);

	process.env.FAKE_CLAUDE_AUTHENTICATED = "true";
	resetClaudeCliAuthCache();
	const model = resolveModel(undefined, undefined as any);
	assert.notEqual(model.provider, "claude-cli", "default model remains unchanged");
	process.env.MOM_MODEL_PROVIDER = "claude-cli";
	process.env.MOM_MODEL_ID = "sonnet";
	assert.equal(resolveModel().id, "sonnet", "selected Claude CLI aliases resolve without API auth storage");
	assert.equal(
		new MomSettingsManager(workspaceDir).getVerbose("C123", "slack"),
		"messages-only",
		"Claude CLI preserves Slack's send_message-only delivery boundary",
	);
	delete process.env.MOM_MODEL_PROVIDER;
	delete process.env.MOM_MODEL_ID;

	const args = buildClaudeCliArgs({
		modelId: "opus",
		systemPromptFile: "/tmp/system.md",
		mcpConfigFile: "/tmp/mcp.json",
		sessionId: "11111111-1111-4111-8111-111111111111",
		resume: false,
		reasoning: "minimal",
		permissionMode: "bypassPermissions",
	});
	assert.deepEqual(args.slice(0, 7), ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--setting-sources", "user"]);
	assert.ok(args.includes("--strict-mcp-config"), "Claude ignores user/project MCP servers for resident runs");
	assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/mcp.json", "Claude receives the per-turn Troublemaker MCP config");
	assert.equal(args[args.indexOf("--tools") + 1], "ToolSearch", "only Claude's non-acting MCP discovery tool remains");
	assert.equal(args[args.indexOf("--allowedTools") + 1], "ToolSearch,mcp__troublemaker__*", "ToolSearch and Troublemaker MCP tools are pre-approved");
	assert.equal(args[args.indexOf("--disallowedTools") + 1], "SendMessage", "Claude's native SendMessage stays explicitly denied");
	assert.ok(args.includes("--disable-slash-commands"), "resident Claude runs do not expose user slash-command skills");
	assert.ok(args.includes("--session-id"), "fresh calls supply a deterministic session id");
	assert.ok(args.includes("--effort") && args.includes("low"), "Troublemaker thinking maps to Claude effort");
	assert.ok(args.includes("--permission-mode") && args.includes("bypassPermissions"), "explicit host permission mode is forwarded");

	const childEnv = buildClaudeCliEnvironment(process.env);
	assert.equal(childEnv.ANTHROPIC_API_KEY, undefined, "Anthropic API overrides are scrubbed from subscription-backed CLI calls");
	assert.equal(childEnv.FAKE_CLAUDE_INVOCATION_LOG, invocationLog, "unrelated resident configuration is preserved");

	const streamFn = createClaudeCliStream(workspaceDir);
	const sonnet = getClaudeCliModel("sonnet")!;
	const firstContext = contextWith([{ role: "user", content: "first turn", timestamp: Date.now() }]);
	const first = await collect(streamFn, sonnet, firstContext);
	assert.equal(first.message.stopReason, "stop");
	assert.equal(first.message.content[0]?.type === "text" ? first.message.content[0].text : "", "hello from claude");
	assert.deepEqual(first.deltas, ["hello ", "from claude"], "partial Claude stream-json deltas reach Pi");
	assert.doesNotMatch(first.message.content[0]?.type === "text" ? first.message.content[0].text : "", /nested leak/, "nested Claude tool/subagent text is not surfaced as assistant output");
	assert.equal(first.message.responseModel, "fake-claude-model");
	assert.equal(first.message.usage.totalTokens, 26, "Claude result usage maps into Pi usage");
	assert.equal(first.message.usage.cost.total, 0.25, "reported Claude CLI total cost is retained");

	const secondContext = contextWith([
		...firstContext.messages,
		first.message,
		{ role: "user", content: "second turn", timestamp: Date.now() },
	]);
	const second = await collect(createClaudeCliStream(workspaceDir), sonnet, secondContext);
	assert.equal(second.message.stopReason, "stop", "a new Troublemaker process view resumes the persisted Claude session");
	let invocations = readInvocations();
	assert.ok(invocations[0]?.args.includes("--session-id"), "first invocation creates a Claude session");
	assert.ok(invocations[1]?.args.includes("--resume"), "second invocation resumes the stored Claude session");
	assert.match(invocations[1]?.input || "", /second turn/, "resume sends the new turn");
	assert.doesNotMatch(invocations[1]?.input || "", /first turn/, "resume does not duplicate prior transcript context");
	assert.equal(invocations.some((entry) => entry.leakedApiKey), false, "API key overrides never reach the fake Claude process");
	assert.equal(
		readFileSync(invocationLog, "utf8").includes(getClaudeCliRuntimeAuth("claude-cli")!),
		false,
		"the Pi preflight marker never reaches Claude arguments, input, or environment",
	);

	process.env.FAKE_CLAUDE_REJECT_RESUME = "true";
	const thirdContext = contextWith([
		...secondContext.messages,
		second.message,
		{ role: "user", content: "recover this turn", timestamp: Date.now() },
	]);
	const recovered = await collect(createClaudeCliStream(workspaceDir), sonnet, thirdContext);
	assert.equal(recovered.message.stopReason, "stop", "missing Claude transcript retries as a fresh seeded session");
	invocations = readInvocations();
	assert.ok(invocations.at(-2)?.args.includes("--resume"), "recovery first attempts the stored session");
	assert.ok(invocations.at(-1)?.args.includes("--session-id"), "recovery replaces it with a fresh session");
	assert.match(invocations.at(-1)?.input || "", /conversation_reseed/, "fresh recovery reseeds bounded Troublemaker history");
	delete process.env.FAKE_CLAUDE_REJECT_RESUME;

	resetClaudeCliSession(workspaceDir);
	await collect(createClaudeCliStream(workspaceDir), sonnet, thirdContext);
	assert.ok(readInvocations().at(-1)?.args.includes("--session-id"), "/clear session reset forces a fresh Claude session");

	console.log("claude-cli ok");
} finally {
	restoreEnv();
	resetClaudeCliAuthCache();
	rmSync(tempDir, { recursive: true, force: true });
}
