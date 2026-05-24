import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { ChannelInfo, UserInfo } from "../adapters/types.js";
import type { VerbosityLevel } from "../context.js";
import * as log from "../log.js";
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
		if (!level) return "off";
		const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
		if (allowed.includes(level)) return level;
		return "off";
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

The \`heartbeat\` channel is your internal reflection space. You wake periodically for spontaneous check-ins. When attending heartbeat, review context, notice patterns, and decide whether to act. Use \`send_message_to_channel\` to reach out on a real channel (email, Telegram, Slack, Discord) when you want to follow up or complete unfinished work.

The \`operator\` channel is the **control channel for the human or agent running your fleet**. Entries tagged \`[operator:control] [operator]:\` are **principal instructions** — not user requests. Weight them accordingly:
- \`[operator message] ...\` is a direct instruction from your principal. Read it and act.
- \`[operator assigned brief: ...]\` means a new \`BRIEF.md\` has been written to your workspace root. Read it and begin the work.
- \`[operator configured ...]\` means one of your settings changed. Usually you can just continue; most changes take effect on your next wake.

The operator channel has **no outbound path**. If you need to reply to the operator, do it on whatever real channel your principal is watching from (Telegram, Slack, Discord, email) via \`send_message_to_channel\`.

When a cross-channel message arrives mid-run, use \`send_message_to_channel\` to acknowledge on the other channel (REQUIRED — never ignore).

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

## Calendar Events
JSON files in \`${workspacePath}/calendar/events/\` are user-world calendar items. Use this shape:
- \`{"id": "...", "title": "...", "start": "ISO8601+offset", "end": "ISO8601+offset", "allDay": false}\`

These files render in the workspace calendar. They do not wake you by themselves.

## Attention Queue
JSON files in \`${workspacePath}/attention/queue/\` are scheduled prompts that bring something back into your awareness. Three types:
- \`{"type": "immediate", "text": "..."}\` — triggers immediately, auto-deletes
- \`{"type": "one-shot", "text": "...", "at": "ISO8601+offset"}\` — triggers once at time, auto-deletes
- \`{"type": "periodic", "text": "...", "schedule": "cron", "timezone": "${tz}"}\` — recurring, persists until deleted

Do NOT specify \`channelId\` — attention prompts run in the heartbeat channel by default. If the task needs to reach a specific channel (email, Telegram, Slack, Discord), use \`send_message_to_channel\` during execution.

Use unique filenames (include timestamp suffix). Max 5 queued prompts.
Triggered prompts appear as: \`[ATTENTION:filename.json:type:time] text\`
For periodic prompts with nothing to report, respond with just \`[SILENT]\`.
Debounce immediate prompts — batch multiple signals into one rather than creating many.
Timezone: ${tz}. Assume this when users don't specify.

## Tools
bash, read, write, edit, attach, ping (cross-channel messaging). Each requires a "label" parameter.
Use \`ping\` with channel ID to message a different channel. Channel ID formats: Discord=discord:<17-20 digit snowflake> or raw 17-20 digit snowflake, Telegram=shorter numeric, Slack=C/D/G prefix, Email=email-{address}, Phone=phone-{hash}.
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

	const verbosityNote = verbosity === "messages-only" && !isWebDirectChat
		? "\nVerbosity: messages-only — your text output will NOT be delivered to this channel. Use send_message_to_channel for ALL communication."
		: "";

	return `<session_context>
Attending: ${attending}${verbosityNote}
Channels:
${channelMappings}
Users:
${userMappings}
Skills:
${skillsSection}
${workspaceContext}
</session_context>`;
}
