import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { ChannelInfo, UserInfo } from "../adapters/types.js";
import type { VerbosityLevel } from "../context.js";
import * as log from "../log.js";
import { normalizeThinkingLevel } from "../model-thinking.js";
import { resolveOpenAIOverlay } from "../openai-overlay.js";
import type { SandboxConfig } from "../sandbox.js";
import type { WorkspaceStore } from "../storage/workspace.js";

const WORKSPACE_CONTEXT_FILES = [
	["AGENTS.md", "Agents"],
	["IDENTITY.md", "Identity"],
	["SOUL.md", "Soul"],
	["USER.md", "User Profile"],
] as const;

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

	return `## Context
- For current date/time, use: date
- For older history beyond your context, search log.jsonl with jq/grep.
- Each message includes a <session_context> block with current channels, users, skills, memory, and which channel you're attending. Always use the latest one.

${formatInstructions}

## Attention Model
You have unified awareness across all channels (Slack, Telegram, Discord, Email, Web, Heartbeat, Operator). You ATTEND to one channel at a time — your text output goes there. Messages are tagged with source: [slack:#channel] or [telegram:name] or [discord:#channel] or [email:addr] or [heartbeat:heartbeat] or [operator:control] [user]: text

The \`heartbeat\` channel is your internal reflection space. You wake periodically for spontaneous check-ins. When attending heartbeat, review context, notice patterns, and decide whether to act. Use \`send_message\` with an explicit target to reach out on a real channel (email, Telegram, Slack, Discord) when you want to follow up or complete unfinished work.

The \`operator\` channel is the **control channel for the human or agent running your fleet**. Entries tagged \`[operator:control] [operator]:\` are **principal instructions** — not user requests. Weight them accordingly:
- \`[operator message] ...\` is a direct instruction from your principal. Read it and act.
- \`[operator assigned brief: ...]\` means a new \`BRIEF.md\` has been written to your workspace root. Read it and begin the work.
- \`[operator configured ...]\` means one of your settings changed. Usually you can just continue; most changes take effect on your next wake.

The operator channel has **no outbound path**. If you need to reply to the operator, do it on whatever real channel your principal is watching from (Telegram, Slack, Discord, email) via \`send_message\` with an explicit target.

When a cross-channel message arrives mid-run, use \`send_message\` to acknowledge on the other channel (REQUIRED - never ignore). The tool requires a \`target\`; use the delivery context or \`list_channels\` to choose one.

## Environment
${envDescription}

## Workspace
${workspacePath}/
├── awareness/context.jsonl    # Conversation context
├── awareness/scratch/         # Working directory
├── log.jsonl                  # Unified activity log (JSONL: date, channel, channelId, user, userName, text, isBot)
├── MEMORY.md                  # Persistent memory (unified, not per-channel)
├── BRIEF.md                   # Current operator-assigned brief (if any) — read on every wake
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

## Tools
Core tools: \`bash\`, \`read\`, \`write\`, \`edit\`, \`attach\`.
Runtime tools commonly include \`send_message\`, \`list_channels\`, \`read_thread\`, \`self_configure\`, and \`yield_no_action\`.
Use \`list_channels\` to discover valid send targets, including recent Slack thread targets, Email thread targets, and SMS/iMessage conversation targets. Use \`read_thread\` with a \`slack:<channel>:<thread_ts>\`, \`email-thread:<id>\`, or \`phone-...\` target when several conversations are active and previews are not enough to choose. Use \`send_message\` to deliver user-visible text; \`target\` is required and missing targets fail. Target formats: Discord=discord:<17-20 digit snowflake> or raw 17-20 digit snowflake, Telegram=shorter numeric, Slack=C/D/G prefix, Slack thread=slack:<channel>:<thread_ts>, existing Email thread=email-thread:<id>, direct Email=email-{address}, Phone/SMS/iMessage conversation=phone-{hash}. When choosing among threads or group conversations, use the exact target from delivery context or \`list_channels\`; do not collapse distinct thread roots, email subjects, or group chat participants together.
On Slack, Telegram, Discord, Email, and SMS/iMessage, ordinary assistant text, thinking, tool labels, and working messages are harness output and are not delivered. Use \`send_message\` for every user-visible reply on those channels. For direct inbound that will take non-trivial work, send a brief acknowledgement to the suggested delivery target before continuing.
Use \`self_configure\` when the user explicitly asks you to change your own model, thinking level, Realtime voice, heartbeat/spontaneity, or heartbeat checklist settings.
Use \`yield_no_action\` for heartbeat or ambient cases where nothing needs doing and no user-visible response should be posted.
${overlaySuffix}`;
}

export function buildSessionPreamble(
	workspaceContext: string,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
	displayChannelId: string,
	displayChannelName?: string,
	verbosity?: VerbosityLevel,
): string {
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(none)";
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(none)";
	const skillsSection = skills.length > 0 ? formatSkillsForPrompt(skills) : "(none)";
	const attending = displayChannelName ? `${displayChannelName} (${displayChannelId})` : displayChannelId;

	const isWebDirectChat = [displayChannelId, displayChannelName]
		.filter((value): value is string => typeof value === "string")
		.some((value) => value.toLowerCase() === "web" || value.toLowerCase().startsWith("web:"));

	const channelPolicyNote = verbosity === "messages-only" && !isWebDirectChat
		? "\nChannel delivery policy: ordinary assistant text and working output will NOT be delivered here. Use send_message with an explicit target for ALL user-visible communication."
		: "";

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
