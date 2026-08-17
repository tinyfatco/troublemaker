import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	RuntimeAssistantTextEvent,
	RuntimeAssistantTextOutcome,
} from "../core/runtime-contract.js";

/**
 * Builds a cumulative projection of public assistant text for one canonical
 * run. Cumulative patches are intentionally self-contained: a consumer may
 * drop any earlier patch and still recover without guessing from response
 * bodies. Thinking, tool calls, tool results, and unknown blocks have no
 * representation in this projection.
 */
export class AssistantTextProjection {
	private completionId = "";
	private revision = 0;
	private segments: string[] = [];
	private activeSegment = -1;
	private lastEmittedText = "";

	reset(completionId: string): void {
		this.completionId = completionId;
		this.revision = 0;
		this.segments = [];
		this.activeSegment = -1;
		this.lastEmittedText = "";
	}

	begin(message: AgentMessage): RuntimeAssistantTextEvent | null {
		if (!isAssistantMessage(message)) return null;
		this.segments.push(publicAssistantText(message));
		this.activeSegment = this.segments.length - 1;
		return this.patchIfChanged();
	}

	update(message: AgentMessage, updateType?: string): RuntimeAssistantTextEvent | null {
		if (!isAssistantMessage(message) || !isPublicTextUpdate(updateType)) return null;
		this.ensureActiveSegment();
		this.segments[this.activeSegment] = publicAssistantText(message);
		return this.patchIfChanged();
	}

	end(message: AgentMessage): RuntimeAssistantTextEvent | null {
		if (!isAssistantMessage(message)) return null;
		this.ensureActiveSegment();
		this.segments[this.activeSegment] = publicAssistantText(message);
		this.activeSegment = -1;
		return this.patchIfChanged();
	}

	finalize(options: {
		outcome: RuntimeAssistantTextOutcome;
		durableMessageIds?: string[];
	}): RuntimeAssistantTextEvent {
		const text = this.text;
		this.lastEmittedText = text;
		return {
			type: "assistant_text",
			completionId: this.completionId,
			revision: ++this.revision,
			text,
			isFinal: true,
			outcome: options.outcome,
			speechEligible: options.outcome === "completed" && text.trim().length > 0,
			...(options.durableMessageIds && options.durableMessageIds.length > 0
				? { durableMessageIds: [...new Set(options.durableMessageIds)] }
				: {}),
		};
	}

	private ensureActiveSegment(): void {
		if (this.activeSegment >= 0) return;
		this.segments.push("");
		this.activeSegment = this.segments.length - 1;
	}

	private patchIfChanged(): RuntimeAssistantTextEvent | null {
		const text = this.text;
		if (!text || text === this.lastEmittedText) return null;
		this.lastEmittedText = text;
		return {
			type: "assistant_text",
			completionId: this.completionId,
			revision: ++this.revision,
			text,
			isFinal: false,
			speechEligible: false,
		};
	}

	private get text(): string {
		return this.segments.join("");
	}
}

function isPublicTextUpdate(type: string | undefined): boolean {
	return type === undefined || type === "text_delta" || type === "text_end";
}

function publicAssistantText(message: AgentMessage): string {
	if (!isAssistantMessage(message)) return "";
	return message.content.flatMap((block): string[] =>
		block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
}

function isAssistantMessage(message: AgentMessage): message is AgentMessage & {
	role: "assistant";
	content: Array<Record<string, any>>;
} {
	return message.role === "assistant" && Array.isArray(message.content);
}
