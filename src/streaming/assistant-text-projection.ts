import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	RuntimeAssistantTextEvent,
	RuntimeAssistantTextOutcome,
	RuntimeAssistantTextPresentationSegment,
} from "../core/runtime-contract.js";

interface ActivePresentationSegment {
	id: string;
	index: number;
	revision: number;
	text: string;
	lastEmittedText: string;
	startedAt: string;
}

/**
 * Builds a cumulative projection of public assistant text for one canonical
 * run. Cumulative patches are intentionally self-contained: a consumer may
 * drop any earlier patch and still recover without guessing from response
 * bodies. Thinking, tool calls, tool results, and unknown blocks have no
 * representation in this projection.
 */
export class AssistantTextProjection {
	private static readonly MINIMUM_PATCH_GROWTH = 24;
	private completionId = "";
	private revision = 0;
	private segments: string[] = [];
	private activeSegment = -1;
	private lastEmittedText = "";
	private forceNextPatch = false;
	private nextPresentationIndex = 0;
	private activePresentation: ActivePresentationSegment | null = null;
	private lastPresentationStartedAt = 0;

	constructor(private readonly now: () => Date = () => new Date()) {}

	reset(completionId: string): void {
		this.completionId = completionId;
		this.revision = 0;
		this.segments = [];
		this.activeSegment = -1;
		this.lastEmittedText = "";
		this.forceNextPatch = false;
		this.nextPresentationIndex = 0;
		this.activePresentation = null;
		this.lastPresentationStartedAt = 0;
	}

	begin(message: AgentMessage): RuntimeAssistantTextEvent | null {
		if (!isAssistantMessage(message)) return null;
		const text = publicAssistantText(message);
		this.segments.push(text);
		this.activeSegment = this.segments.length - 1;
		this.startPresentation(text);
		this.forceNextPatch = true;
		const patch = this.patchIfChanged(true);
		if (patch) this.forceNextPatch = false;
		return patch;
	}

	update(message: AgentMessage, updateType?: string): RuntimeAssistantTextEvent | null {
		if (!isAssistantMessage(message) || !isPublicTextUpdate(updateType)) return null;
		this.ensureActiveSegment();
		const text = publicAssistantText(message);
		this.segments[this.activeSegment] = text;
		this.ensureActivePresentation(text);
		this.activePresentation!.text = text;
		const patch = this.patchIfChanged(this.forceNextPatch);
		this.forceNextPatch = false;
		return patch;
	}

	end(message: AgentMessage): RuntimeAssistantTextEvent | null {
		if (!isAssistantMessage(message)) return null;
		this.ensureActiveSegment();
		const text = publicAssistantText(message);
		this.segments[this.activeSegment] = text;
		this.ensureActivePresentation(text);
		this.activePresentation!.text = text;
		this.activeSegment = -1;
		this.forceNextPatch = false;
		return this.patchIfChanged(true);
	}

	/**
	 * Closes the current visible prose segment before another visible event is
	 * emitted. The next assistant patch receives a new immutable identity.
	 */
	boundary(options: { durableMessageIds?: string[] } = {}): RuntimeAssistantTextEvent | null {
		const presentation = this.activePresentation;
		this.activePresentation = null;
		if (!presentation || !presentation.text) return null;
		this.lastEmittedText = this.text;
		return this.event({
			isFinal: false,
			speechEligible: false,
			presentation: this.presentationEvent(presentation, true, options.durableMessageIds),
		});
	}

	finalize(options: {
		outcome: RuntimeAssistantTextOutcome;
		durableMessageIds?: string[];
		presentationDurableMessageIds?: string[];
	}): RuntimeAssistantTextEvent {
		const text = this.text;
		this.lastEmittedText = text;
		const presentation = this.activePresentation;
		this.activePresentation = null;
		return this.event({
			isFinal: true,
			outcome: options.outcome,
			durableMessageIds: options.durableMessageIds,
			speechEligible: options.outcome === "completed" && text.trim().length > 0,
			presentation: presentation && presentation.text
				? this.presentationEvent(presentation, true, options.presentationDurableMessageIds)
				: undefined,
		});
	}

	private ensureActiveSegment(): void {
		if (this.activeSegment >= 0) return;
		this.segments.push("");
		this.activeSegment = this.segments.length - 1;
		this.forceNextPatch = true;
	}

	private startPresentation(text: string): void {
		const index = this.nextPresentationIndex++;
		const now = this.now().getTime();
		const startedAt = Math.max(now, this.lastPresentationStartedAt + 1);
		this.lastPresentationStartedAt = startedAt;
		this.activePresentation = {
			id: `${this.completionId}:segment:${index}`,
			index,
			revision: 0,
			text,
			lastEmittedText: "",
			startedAt: new Date(startedAt).toISOString(),
		};
	}

	private ensureActivePresentation(text: string): void {
		if (this.activePresentation) return;
		this.startPresentation(text);
	}

	private patchIfChanged(force = false): RuntimeAssistantTextEvent | null {
		const presentation = this.activePresentation;
		if (!presentation || !presentation.text || presentation.text === presentation.lastEmittedText) return null;
		const isAppendOnly = presentation.text.startsWith(presentation.lastEmittedText);
		const growth = isAppendOnly ? presentation.text.length - presentation.lastEmittedText.length : 0;
		if (
			!force
			&& isAppendOnly
			&& presentation.lastEmittedText.length > 0
			&& growth < AssistantTextProjection.MINIMUM_PATCH_GROWTH
		) return null;
		presentation.lastEmittedText = presentation.text;
		this.lastEmittedText = this.text;
		return this.event({
			isFinal: false,
			speechEligible: false,
			presentation: this.presentationEvent(presentation, false),
		});
	}

	private event(options: {
		isFinal: boolean;
		outcome?: RuntimeAssistantTextOutcome;
		durableMessageIds?: string[];
		speechEligible: boolean;
		presentation?: RuntimeAssistantTextPresentationSegment;
	}): RuntimeAssistantTextEvent {
		const durableMessageIds = unique(options.durableMessageIds);
		return {
			type: "assistant_text",
			completionId: this.completionId,
			revision: ++this.revision,
			text: this.text,
			isFinal: options.isFinal,
			...(options.outcome ? { outcome: options.outcome } : {}),
			...(durableMessageIds.length > 0 ? { durableMessageIds } : {}),
			speechEligible: options.speechEligible,
			presentationMode: "ordered_segments",
			...(options.presentation ? { presentationSegment: options.presentation } : {}),
		};
	}

	private presentationEvent(
		presentation: ActivePresentationSegment,
		isFinal: boolean,
		durableMessageIds?: string[],
	): RuntimeAssistantTextPresentationSegment {
		const durable = unique(durableMessageIds);
		return {
			id: presentation.id,
			index: presentation.index,
			revision: ++presentation.revision,
			text: presentation.text,
			isFinal,
			startedAt: presentation.startedAt,
			...(durable.length > 0 ? { durableMessageIds: durable } : {}),
		};
	}

	private get text(): string {
		return this.segments.join("");
	}
}

function unique(values: string[] | undefined): string[] {
	return [...new Set((values ?? []).filter((value) => value.trim().length > 0))];
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
