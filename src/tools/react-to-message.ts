/** Add one emoji reaction to one exact Slack or Microsoft Teams message. */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PlatformAdapter } from "../adapters/types.js";
import { normalizeSlackEmojiName, parseSlackMessageTarget } from "../adapters/slack-reactions.js";
import { parseTeamsTarget } from "../adapters/teams-target.js";
import * as log from "../log.js";
import { waitForToolDisplay } from "../streaming/tool-delivery-barrier.js";
import { requiredToolLabelSchema, requireNonblankToolLabel } from "./tool-label.js";

export interface ResolvedSlackReactionTarget {
	adapter: PlatformAdapter & Required<Pick<PlatformAdapter, "addReaction">>;
	channelId: string;
	messageTs: string;
	target: string;
	emoji: string;
}

export interface ResolvedReactionTarget extends ResolvedSlackReactionTarget {
	platform: "slack" | "teams";
}

export function resolveSlackReactionTarget(
	target: unknown,
	emoji: unknown,
	adapters: PlatformAdapter[],
): ResolvedSlackReactionTarget {
	const parsed = parseSlackMessageTarget(target);
	if (!parsed) {
		throw new Error("react_to_message requires an exact Slack message target in the form slack:<channel_id>:<message_ts>.");
	}
	const normalizedEmoji = normalizeSlackEmojiName(emoji);
	if (!normalizedEmoji) {
		throw new Error("react_to_message requires a valid Slack emoji name such as thumbsup or :thumbsup:.");
	}
	const adapter = adapters.find((candidate) => candidate.name === "slack" && typeof candidate.addReaction === "function");
	if (!adapter || typeof adapter.addReaction !== "function") {
		throw new Error("No Slack adapter with reaction support is available for react_to_message.");
	}
	return {
		adapter: adapter as ResolvedSlackReactionTarget["adapter"],
		channelId: parsed.channelId,
		messageTs: parsed.messageTs,
		target: parsed.target,
		emoji: normalizedEmoji,
	};
}

export function resolveReactionTarget(
	target: unknown,
	emoji: unknown,
	adapters: PlatformAdapter[],
): ResolvedReactionTarget {
	const teams = parseTeamsTarget(target);
	if (teams?.messageId) {
		const normalizedEmoji = typeof emoji === "string" ? emoji.trim() : "";
		if (!normalizedEmoji) throw new Error("react_to_message requires a Microsoft Teams reaction type or supported emoji name.");
		const adapter = adapters.find((candidate) => candidate.name === "teams" && typeof candidate.addReaction === "function");
		if (!adapter?.addReaction) throw new Error("No Microsoft Teams adapter with reaction support is available for react_to_message.");
		return {
			adapter: adapter as ResolvedReactionTarget["adapter"],
			channelId: teams.conversationId,
			messageTs: teams.messageId,
			target: teams.target,
			emoji: normalizedEmoji,
			platform: "teams",
		};
	}
	const slack = resolveSlackReactionTarget(target, emoji, adapters);
	return { ...slack, platform: "slack" };
}

export function createReactToMessageTool(adapters: PlatformAdapter[]): AgentTool<any> {
	return {
		name: "react_to_message",
		label: "react_to_message",
		description:
			"Add an emoji reaction to one exact Slack or Microsoft Teams message without posting text. " +
			"The target must be slack:<channel_id>:<message_ts> or teams:<encoded conversation>:<encoded message>; conversation-only guesses fail closed. " +
			"Use a provider-supported emoji name such as thumbsup, heart, eyes, check, rocket, or pushpin.",
		parameters: Type.Object({
			label: requiredToolLabelSchema("Brief, safe description of why you're reacting (shown to the user)"),
			show: Type.Optional(Type.Boolean({ description: "Surface this safe label only when it is a meaningful progress milestone. Default false." })),
			target: Type.String({ description: "Exact Slack or Microsoft Teams message target." }),
			emoji: Type.String({ description: "Provider-supported emoji or reaction name." }),
		}),
		execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
			requireNonblankToolLabel(params, "react_to_message");
			if (signal?.aborted) throw new Error("Operation aborted");
			const body = params as { target?: unknown; emoji?: unknown };
			const resolved = resolveReactionTarget(body.target, body.emoji, adapters);
			await waitForToolDisplay(toolCallId);
			if (signal?.aborted) throw new Error("Operation aborted");
			await resolved.adapter.addReaction(resolved.channelId, resolved.messageTs, resolved.emoji);
			log.logInfo(`[react_to_message] Added :${resolved.emoji}: to ${resolved.target}`);
			return {
				content: [{ type: "text" as const, text: `Added :${resolved.emoji}: to ${resolved.platform === "teams" ? "Microsoft Teams" : "Slack"} message ${resolved.target}.` }],
				details: { reacted: true, target: resolved.target, emoji: resolved.emoji },
			};
		},
	};
}
