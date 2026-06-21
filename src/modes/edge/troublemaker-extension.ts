import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChannelInfo, UserInfo } from "../../adapters/types.js";
import type { VerbosityLevel } from "../../context.js";
import { buildSessionPreamble, type PromptSkill } from "../../core/prompt.js";
import type { WebTurnInput } from "../../core/runtime-contract.js";

export interface EdgeTroublemakerExtensionContext {
	systemPrompt: string;
	workspaceContext?: string;
	channels?: ChannelInfo[];
	users?: UserInfo[];
	skills?: PromptSkill[];
	channelName?: string;
	verbosity?: VerbosityLevel;
}

export interface EdgeTroublemakerTurn {
	systemPrompt: string;
	promptMessage: AgentMessage;
}

function formatTimestamp(date: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	const offset = -date.getTimezoneOffset();
	const offsetSign = offset >= 0 ? "+" : "-";
	const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
	const offsetMins = pad(Math.abs(offset) % 60);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
}

function sourceUserName(input: WebTurnInput): string {
	if (!input.source || input.source === "web") return "user";
	return input.source;
}

export function createTroublemakerEdgeTurn(
	input: WebTurnInput,
	context: EdgeTroublemakerExtensionContext,
	now = new Date(),
): EdgeTroublemakerTurn {
	const channelName = context.channelName || input.channelId || input.source || "web";
	const workspaceContext = context.workspaceContext?.trim() || "Memory:\n(no working memory loaded)";
	const sessionPreamble = buildSessionPreamble(
		workspaceContext,
		context.channels ?? [],
		context.users ?? [],
		context.skills ?? [],
		input.channelId,
		channelName,
		context.verbosity,
	);
	const text = `${sessionPreamble}\n\n[${formatTimestamp(now)}] [${channelName}] [${sourceUserName(input)}]: ${input.message}`;

	return {
		systemPrompt: context.systemPrompt,
		promptMessage: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: now.getTime(),
		} as AgentMessage,
	};
}
