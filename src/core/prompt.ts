import type { ChannelInfo, UserInfo } from "../adapters/types.js";
import type { VerbosityLevel } from "../context.js";
import * as log from "../log.js";
import { normalizeThinkingLevel } from "../model-thinking.js";
import { resolveOpenAIOverlay } from "../openai-overlay.js";
import type { SandboxConfig } from "../sandbox.js";
import type { WorkspaceStore } from "../storage/workspace.js";
import { readGoalState, renderGoalContext } from "../goal-state.js";

const WORKSPACE_CONTEXT_FILES = [
	["AGENTS.md", "Agents"],
	["IDENTITY.md", "Identity"],
	["SOUL.md", "Soul"],
	["USER.md", "User Profile"],
] as const;

export interface PromptSkill {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
}

export const CLAUDE_CLI_SEND_MESSAGE_SELECT_QUERY = "select:mcp__troublemaker__send_message";
export const CLAUDE_CLI_REACT_TO_MESSAGE_SELECT_QUERY = "select:mcp__troublemaker__react_to_message";
export const CLAUDE_CLI_YIELD_NO_ACTION_SELECT_QUERY = "select:mcp__troublemaker__yield_no_action";

interface ClaudeCliDeliveryRetryOptions {
	model?: { provider?: string };
	verbosity?: VerbosityLevel;
	toolsUsed: string[];
	directlyAddressed?: boolean;
	eventType?: "mention" | "dm";
	replyTarget?: string;
}

function baseToolName(name: string): string {
	return name.split("__").at(-1)?.split(".").at(-1) || name;
}

/**
 * Claude's deferred MCP tools require an explicit ToolSearch selection. If a
 * messages-only turn ends without choosing either delivery or silence, retry
 * once with an exact selection instruction instead of exposing model prose.
 */
export function resolveClaudeCliDeliveryRetry(options: ClaudeCliDeliveryRetryOptions): string | null {
	if (options.model?.provider !== "claude-cli" || options.verbosity !== "messages-only") return null;
	if (options.toolsUsed.some((name) => ["send_message", "yield_no_action"].includes(baseToolName(name)))) return null;

	const direct = options.directlyAddressed === true || options.eventType === "dm";
	if (direct) {
		const target = options.replyTarget
			? ` Use the exact target ${JSON.stringify(options.replyTarget)}.`
			: " Use the exact suggested reply target from the latest delivery_context.";
		return `Your previous assistant text was intentionally not delivered because this channel requires explicit Troublemaker delivery. Do not write another assistant response. Call ToolSearch now with query ${JSON.stringify(CLAUDE_CLI_SEND_MESSAGE_SELECT_QUERY)}, then call mcp__troublemaker__send_message with a concise reply to the latest user.${target} Use ToolSearch for any other mcp__troublemaker__ tools needed to complete the request before sending the reply.`;
	}

	return `Your previous assistant text was intentionally not delivered because this channel requires an explicit Troublemaker action. Do not write another assistant response. If a visible reply is warranted, call ToolSearch with query ${JSON.stringify(CLAUDE_CLI_SEND_MESSAGE_SELECT_QUERY)} and then call mcp__troublemaker__send_message. Otherwise call ToolSearch with query ${JSON.stringify(CLAUDE_CLI_YIELD_NO_ACTION_SELECT_QUERY)} and then call mcp__troublemaker__yield_no_action.`;
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function formatSkillsForSessionPreamble(skills: PromptSkill[]): string {
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return lines.join("\n");
}

function readWorkspaceFile(workspace: WorkspaceStore, filename: string): string {
	const content = workspace.readText(filename)?.trim();
	if (content) return content;
	return "";
}

function getRecentDailyMemory(workspace: WorkspaceStore): string {
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	const fmt = (d: Date) => d.toISOString().slice(0, 10);

	const parts: string[] = [];
	for (const date of [fmt(today), fmt(yesterday)]) {
		const content = readWorkspaceFile(workspace, `memory/${date}.md`);
		if (content) parts.push(`### ${date}\n${content}`);
	}
	return parts.join("\n\n");
}

export function resolveThinkingLevel(workspace: WorkspaceStore): any {
	try {
		const raw = workspace.readText("settings.json");
		if (!raw) return "off";
		const settings = JSON.parse(raw) as {
			thinking_level?: string;
			defaultThinkingLevel?: string;
		};
		const level = settings.thinking_level ?? settings.defaultThinkingLevel;
		return normalizeThinkingLevel(level);
	} catch {
		return "off";
	}
}

export function getWorkspaceContext(workspace: WorkspaceStore): string {
	if (workspace.exists("BOOTSTRAP.md")) {
		const bootstrap = readWorkspaceFile(workspace, "BOOTSTRAP.md");
		return `Bootstrap:\n${bootstrap}`;
	}

	const sections: string[] = [];

	for (const [file, label] of WORKSPACE_CONTEXT_FILES) {
		const content = readWorkspaceFile(workspace, file);
		if (content) sections.push(`${label}:\n${content}`);
	}

	const memory = readWorkspaceFile(workspace, "MEMORY.md");
	if (memory) sections.push(`Memory:\n${memory}`);
	else sections.push("Memory:\n(no working memory yet)");

	const brief = readWorkspaceFile(workspace, "BRIEF.md");
	if (brief) sections.push(`Current Brief (assigned by operator):\n${brief}`);

	const goal = renderGoalContext(readGoalState(workspace));
	if (goal) sections.push(goal);

	const recent = getRecentDailyMemory(workspace);
	if (recent) sections.push(`Recent:\n${recent}`);

	return sections.join("\n\n");
}

export function getWorkspaceSkillsMtime(workspace: WorkspaceStore): number {
	try {
		return workspace.mtimeMs("skills");
	} catch (error) {
		log.logWarning("[skills] Failed to stat workspace skills", error instanceof Error ? error.message : String(error));
		return 0;
	}
}

/**
 * Build the static system prompt. This must be byte-identical across turns
 * so that provider prompt caching can cache-hit on the system prefix.
 */
export function buildSystemPrompt(
	workspacePath: string,
	sandboxConfig: SandboxConfig,
	formatInstructions: string,
	model?: { id?: string; provider?: string },
): string {
	const isDocker = sandboxConfig.type === "docker";
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	const envDescription = isDocker
		? "Docker container (Alpine Linux). Working directory: /. Install tools with apk add."
		: `Host machine. Working directory: ${process.cwd()}. Be careful with system modifications.`;

	const overlay = resolveOpenAIOverlay(model);
	const overlaySuffix = overlay ? `\n\n${overlay}` : "";
	const activeModel = model?.provider && model?.id ? `${model.provider}/${model.id}` : "unknown";
	const claudeCli = model?.provider === "claude-cli";
	const heartbeatGuidance = "The `heartbeat` channel is your internal reflection space. You wake periodically for spontaneous check-ins. When attending heartbeat, review context, notice patterns, and decide whether to act. Use `send_message` with an explicit target to reach out on a real channel (email, Telegram, Slack, Mattermost, Discord) when you want to follow up or complete unfinished work.";
	const operatorReplyGuidance = "The operator channel has **no outbound path**. If you need to reply to the operator, do it on whatever real channel your principal is watching from (Telegram, Slack, Mattermost, Discord, email) via `send_message` with an explicit target.";
	const crossChannelGuidance = "When a cross-channel message arrives mid-run, use `send_message` to acknowledge on the other channel (REQUIRED - never ignore). The tool requires a `target`; use the delivery context or `list_channels` to choose one.";
	const claudeToolBoundary = claudeCli
		? `Claude Code's built-in action tools are disabled; only \`ToolSearch\` remains so Claude can discover deferred MCP tools. Every live Troublemaker tool is provided by the \`troublemaker\` MCP server and appears to Claude as \`mcp__troublemaker__<tool_name>\`. Use those MCP tools exclusively for actions. Before first use, load a tool with an exact ToolSearch query such as \`${CLAUDE_CLI_SEND_MESSAGE_SELECT_QUERY}\`, \`${CLAUDE_CLI_REACT_TO_MESSAGE_SELECT_QUERY}\`, or \`${CLAUDE_CLI_YIELD_NO_ACTION_SELECT_QUERY}\`; never merely describe the tool call in prose. Never use or discuss Claude Code's native \`SendMessage\`; it is unrelated to Troublemaker delivery.`
		: "";
	const toolGuidance = `## Tools
${claudeToolBoundary ? `${claudeToolBoundary}\nTroublemaker MCP tools include \`mcp__troublemaker__bash\`, \`mcp__troublemaker__read\`, \`mcp__troublemaker__write\`, \`mcp__troublemaker__edit\`, and \`mcp__troublemaker__attach\`.` : "Core tools: `bash`, `read`, `write`, `edit`, `attach`."}
Runtime tools commonly include \`send_message\`, \`react_to_message\`, \`list_channels\`, \`read_thread\`, \`self_configure\`, \`set_goal\`, \`complete_goal\`, \`block_goal\`, \`abandon_goal\`, and \`yield_no_action\`.
Use \`list_channels\` to discover valid send targets, including Mattermost and Slack thread targets, Email thread targets, and SMS/iMessage conversation targets. Use \`read_thread\` with a \`mattermost:<channel>:<root>\`, \`slack:<channel>:<thread_ts>\`, \`email-thread:<id>\`, or \`phone-...\` target when several conversations are active and previews are not enough to choose. Use \`send_message\` to deliver user-visible text; \`target\` is required and missing targets fail. Target formats: Mattermost=mattermost:<channel>[:<root>], Discord=discord:<17-20 digit snowflake> or raw 17-20 digit snowflake, Telegram=shorter numeric, Slack=C/D/G prefix, Slack thread=slack:<channel>:<thread_ts>, existing Email thread=email-thread:<id>, direct Email=email-{address}, Phone/SMS/iMessage conversation=phone-{hash}. When choosing among threads or group conversations, use the exact target from delivery context or \`list_channels\`; do not collapse distinct thread roots, email subjects, or group chat participants together.
Use \`react_to_message\` only to add an emoji reaction to an exact Slack message target in the form \`slack:<channel_id>:<message_ts>\`; it never posts text, and non-Slack or channel-only targets fail closed. An inbound \`slack_reaction_added\` turn is lightweight feedback about the specific reacted-to message: decide whether it endorses a promised or implied next step, but never treat it as blanket approval for unrelated consequential actions.
Follow the latest session context's channel delivery policy. When it says ordinary assistant output will not be delivered, use \`send_message\` with the suggested explicit target for every user-visible reply. Otherwise, ordinary assistant output is delivered by the harness; do not duplicate it with \`send_message\` unless you are replying cross-channel. For direct inbound that will take non-trivial work, send a brief acknowledgement before continuing.
Use \`self_configure\` when the user explicitly asks you to change your own model, thinking level, verbosity, working-output routing, Slack response placement, selective Slack tool streaming or Discord tool streaming, Slack tool-stream presentation (split or condensed) or Discord tool-stream presentation, Slack tool-stream window minutes or Discord tool-stream window minutes, busy voice-webhook routing (interrupt or steer), voice wake aliases, Realtime voice, heartbeat/spontaneity, or heartbeat checklist settings. For working output, use \`working_output\`: mode \`off\` hides external labels, mode \`follow\` puts them wherever you are contacted, and mode \`fixed\` with target \`here\` pins labels from all future turns to the current stable Slack channel or DM. This is independent from messages-only user delivery.
Use \`set_goal\` for an explicitly requested persistent objective. An active goal keeps the runtime working through automatic continuation turns; ending one turn does not end the goal. Call \`complete_goal\` only after actually achieving and verifying it, or \`abandon_goal\` because the user cancels or redirects it. Call \`block_goal\` only when the same blocker has repeated for at least three consecutive goal turns and no meaningful progress is possible without user input or an external state change. Terminal run errors also block automatic continuation to prevent a failure loop; use \`set_goal\` again only when the user explicitly asks to resume or replace a blocked goal. Do not turn ordinary one-turn requests into persistent goals.
When a tool offers \`show\`, set it to true only when its safe human-readable label is itself a useful progress milestone. Omit it for routine reads/checks and never put secrets, raw arguments, private content, or sensitive paths in a surfaced label. The runtime may display selected labels while suppressing all other harness detail.
Use \`yield_no_action\` for heartbeat or ambient cases where nothing needs doing and no user-visible response should be posted.`;

	return `## Context
- For current date/time, use: date
- For older history beyond your context, search log.jsonl with jq/grep.
- Each message includes a <session_context> block with current channels, users, skills, memory, and which channel you're attending. Always use the latest one.

${formatInstructions}

## Attention Model
You have unified awareness across all channels (Slack, Mattermost, Telegram, Discord, Email, Web, Heartbeat, Operator). You ATTEND to one channel at a time — your text output goes there. Messages are tagged with source: [slack:#channel] or [mattermost:channel] or [telegram:name] or [discord:#channel] or [email:addr] or [heartbeat:heartbeat] or [operator:control] [user]: text

${heartbeatGuidance}

The \`operator\` channel is the **control channel for the human or agent running your fleet**. Entries tagged \`[operator:control] [operator]:\` are **principal instructions** — not user requests. Weight them accordingly:
- \`[operator message] ...\` is a direct instruction from your principal. Read it and act.
- \`[operator assigned brief: ...]\` means a new \`BRIEF.md\` has been written to your workspace root. Read it and begin the work.
- \`[operator configured ...]\` means one of your settings changed. Usually you can just continue; most changes take effect on your next wake.

${operatorReplyGuidance}

${crossChannelGuidance}

## Environment
${envDescription}
- Active runtime model: ${activeModel}. When asked, report this exact value rather than inferring it from memory or prior sessions.

## Workspace
${workspacePath}/
├── awareness/context.jsonl    # Conversation context
├── awareness/scratch/         # Working directory
├── log.jsonl                  # Unified activity log (JSONL: date, channel, channelId, user, userName, text, isBot)
├── MEMORY.md                  # Persistent memory (unified, not per-channel)
├── BRIEF.md                   # Current operator-assigned brief (if any) — read on every wake
├── goal.json                  # Active persistent goal and lifecycle state
├── SYSTEM.md                  # Environment config log (packages, env vars, config changes)
├── settings.json              # Model & preferences (change model here or /model <name>)
├── skills/                    # Custom CLI tools (each has SKILL.md with name/description frontmatter)
├── calendar/README.md         # Calendar event authoring guide
├── calendar/events/           # Calendar items shown in the workspace calendar
├── attention/queue/           # Scheduled prompts that trigger future attention
├── attention/history/         # Fired/expired scheduled prompts with metadata
├── display/README.md          # Display project authoring guide
├── display/projects/          # Canvas/display projects shown in the workspace UI
└── attachments/               # Files shared by users

## Calendar And Attention
Use the \`scheduling\` skill when creating or editing calendar events in \`${workspacePath}/calendar/events/\` or attention prompts in \`${workspacePath}/attention/queue/\`. Timezone: ${tz}. Assume this when users don't specify.

${toolGuidance}
${overlaySuffix}`;
}

export function buildSessionPreamble(
	workspaceContext: string,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: PromptSkill[],
	displayChannelId: string,
	displayChannelName?: string,
	verbosity?: VerbosityLevel,
	model?: { provider?: string },
): string {
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(none)";
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(none)";
	const skillsSection = skills.length > 0 ? formatSkillsForSessionPreamble(skills) || "(none)" : "(none)";
	const attending = displayChannelName ? `${displayChannelName} (${displayChannelId})` : displayChannelId;

	const isWebDirectChat = [displayChannelId, displayChannelName]
		.filter((value): value is string => typeof value === "string")
		.some((value) => value.toLowerCase() === "web" || value.toLowerCase().startsWith("web:"));

	let channelPolicyNote = "";
	if (verbosity === "messages-only" && !isWebDirectChat) {
		channelPolicyNote = "\nChannel delivery policy: ordinary assistant text and harness finals will NOT be delivered here. Safe tool-label progress may follow the configured working-output route. Use send_message with an explicit target for ALL user-visible communication.";
		if (model?.provider === "claude-cli") {
			channelPolicyNote += ` Before writing assistant text, call ToolSearch with \`${CLAUDE_CLI_SEND_MESSAGE_SELECT_QUERY}\`, then call \`mcp__troublemaker__send_message\`. If no response is appropriate, select \`${CLAUDE_CLI_YIELD_NO_ACTION_SELECT_QUERY}\` and call \`mcp__troublemaker__yield_no_action\`. Direct assistant text is discarded.`;
		}
	}

	return `<session_context>
Attending: ${attending}${channelPolicyNote}
Channels:
${channelMappings}
Users:
${userMappings}
Skills:
${skillsSection}
${workspaceContext}
</session_context>`;
}
