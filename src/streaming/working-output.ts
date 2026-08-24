import type { MomWorkingOutputSettings } from "../context.js";
import type { ChannelStore } from "../store.js";
import type {
	MomContext,
	PlatformAdapter,
	WorkingOutputContextOptions,
} from "../adapters/types.js";
import { formatTeamsTarget } from "../adapters/teams-target.js";

export interface WorkingOutputRoutingOptions {
	policy: MomWorkingOutputSettings;
	sourceContext: MomContext;
	adapters: PlatformAdapter[];
	store: ChannelStore;
	presentation: WorkingOutputContextOptions;
	warn?: (message: string) => void;
}

function withoutWorkingOutput(source: MomContext): MomContext {
	return {
		...source,
		respond: async (text, shouldLog = true, options = {}) => {
			if (!shouldLog) return;
			await source.respond(text, shouldLog, options);
		},
		respondInThread: async () => {},
		setTyping: async () => {},
		workingStreamPresentation: "condensed",
		workingReplyTarget: null,
		updateToolProgress: undefined,
	};
}

function sendTargetForWorkingOutput(target: NonNullable<MomWorkingOutputSettings["target"]>): string {
	switch (target.platform) {
		case "mattermost":
			return `mattermost:${target.channelId}`;
		case "rocket-chat":
			return `rocket-chat:${target.channelId}`;
		case "zulip":
			return `zulip:${target.channelId}`;
		case "slack":
			return target.channelId;
		case "teams":
			return formatTeamsTarget(target.channelId);
	}
}

function withFixedWorkingOutput(source: MomContext, working: MomContext, target: string): MomContext {
	return {
		...source,
		respond: async (text, shouldLog = true, options = {}) => {
			if (shouldLog) {
				await source.respond(text, shouldLog, options);
				return;
			}
			await working.respond(text, shouldLog, options);
		},
		// Raw arguments, results, reasoning details, and stdout remain internal.
		respondInThread: async () => {},
		// A fixed messages-only sink opens only when the first selected tool label arrives.
		setTyping: async () => {},
		setWorking: async (isWorking) => {
			await working.setWorking(isWorking);
			await source.setWorking(isWorking);
		},
		deleteMessage: async () => {
			await working.deleteMessage();
			await source.deleteMessage();
		},
		restartWorking: async (headerLine) => {
			await working.restartWorking(headerLine);
			await source.restartWorking(headerLine);
		},
		workingStreamPresentation: working.workingStreamPresentation,
		workingReplyTarget: target,
		updateToolProgress: working.updateToolProgress,
	};
}

/**
 * Decorate a turn context with an independent working-output route.
 *
 * User-visible finals, attachments, delivery metadata, and forced errors stay
 * with the source context. Only sanitized tool lifecycle can move to the fixed
 * sink. Missing fixed destinations fail closed rather than leaking progress at
 * the source conversation.
 */
export function routeWorkingOutputContext(options: WorkingOutputRoutingOptions): MomContext {
	const { policy, sourceContext } = options;
	if (policy.mode === "follow") return sourceContext;
	if (policy.mode === "off") return withoutWorkingOutput(sourceContext);

	const target = policy.target;
	if (!target) {
		options.warn?.("Fixed working output has no valid target; suppressing external progress");
		return withoutWorkingOutput(sourceContext);
	}

	const adapter = options.adapters.find((candidate) => candidate.name === target.platform);
	if (!adapter?.createWorkingOutputContext) {
		options.warn?.(`Working-output adapter ${target.platform} is unavailable; suppressing external progress`);
		return withoutWorkingOutput(sourceContext);
	}

	try {
		const working = adapter.createWorkingOutputContext(target, options.store, options.presentation);
		return withFixedWorkingOutput(sourceContext, working, sendTargetForWorkingOutput(target));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		options.warn?.(`Failed to create fixed working output: ${message}`);
		return withoutWorkingOutput(sourceContext);
	}
}
