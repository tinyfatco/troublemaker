import { randomUUID } from "node:crypto";
import { readVerifiedSenderIdentity } from "./sender-identity.js";
import {
	projectToolInvocationDetails,
	projectToolResultDetails,
} from "./console/tool-detail-projection.js";
import type {
	RuntimeAssistantSnapshotContent,
	RuntimeLiveEvent,
	RuntimeLiveRunMetadata,
	RuntimeStreamEvent,
	RuntimeToolCallContent,
	RuntimeToolExecutionDetails,
} from "./core/runtime-contract.js";

const DEFAULT_HISTORY_LIMIT = 512;
const PI_DETAIL_HISTORY_LIMIT = 64;
const PI_SNAPSHOT_DETAIL_CHARACTER_LIMIT = 128_000;

type RuntimeLiveEventInput =
	| { kind: "awareness"; line: string; awarenessId?: string }
	| ({ kind: "runtime"; event: RuntimeStreamEvent } & RuntimeLiveRunMetadata)
	| { kind: "reset"; reason: "context_rotated" | "replay_gap" };

export interface LiveEventSubscription {
	unsubscribe(): void;
}

export type RuntimeLivePresentation = "compact" | "pi";

export interface LiveEventSubscriptionOptions {
	presentation?: RuntimeLivePresentation;
}

interface LiveEventSubscriber {
	listener: (event: RuntimeLiveEvent) => void;
	presentation: RuntimeLivePresentation;
}

export interface RuntimeLiveCursor {
	sequence: number;
	streamId: string;
	id: string;
	timestamp: string;
}

/**
 * Small in-process fanout with bounded reconnect replay. It deliberately owns
 * no platform behavior: producers publish sanitized events and transports
 * subscribe to one ordered sequence.
 */
export class RuntimeLiveEventHub {
	private sequence = 0;
	private readonly streamId = randomUUID();
	private readonly history: RuntimeLiveEvent[] = [];
	private readonly activeRuns = new Map<string, RuntimeLiveEvent>();
	private readonly activeAssistantText = new Map<string, RuntimeLiveEvent>();
	private readonly activeSteering = new Map<string, RuntimeLiveEvent>();
	private readonly latestSteering = new Map<string, RuntimeLiveEvent>();
	private readonly piDetails = new Map<string, RuntimeLiveEvent>();
	private readonly subscribers = new Set<LiveEventSubscriber>();

	constructor(private readonly historyLimit = DEFAULT_HISTORY_LIMIT) {}

	publishAwareness(line: string, awarenessId?: string): RuntimeLiveEvent {
		return this.publish({ kind: "awareness", line, awarenessId });
	}

	publishRuntime(metadata: RuntimeLiveRunMetadata, event: RuntimeStreamEvent): RuntimeLiveEvent {
		return this.publish({
			kind: "runtime",
			...metadata,
			event: projectRuntimeEventForTerminal(event),
		}, this.hasPiSubscribers() ? projectRuntimeEventForPiTerminal(event) : undefined);
	}

	publishReset(reason: "context_rotated" | "replay_gap"): RuntimeLiveEvent {
		return this.publish({ kind: "reset", reason });
	}

	/** A non-advancing cursor used for ready and heartbeat frames. */
	cursor(): RuntimeLiveCursor {
		return {
			sequence: this.sequence,
			streamId: this.streamId,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
		};
	}

	subscribe(
		listener: (event: RuntimeLiveEvent) => void,
		afterSequence = 0,
		options: LiveEventSubscriptionOptions = {},
	): LiveEventSubscription {
		const subscriber: LiveEventSubscriber = {
			listener,
			presentation: options.presentation === "pi" ? "pi" : "compact",
		};
		if (afterSequence === 0) {
			// A newly opened live client can attach in the middle of an external run.
			// Replay only each active run's latest cumulative state, never stale
			// completed history from earlier in the resident process.
			const active = new Map<string, RuntimeLiveEvent>();
			for (const event of [
				...this.activeAssistantText.values(),
				...this.activeRuns.values(),
				...this.activeSteering.values(),
			]) {
				active.set(event.id, event);
			}
			for (const event of [...active.values()].sort((a, b) => a.sequence - b.sequence)) {
				this.deliver(subscriber, event);
			}
		} else {
			const oldest = this.history[0]?.sequence;
			if (oldest !== undefined && afterSequence < oldest - 1) {
				this.deliver(subscriber, this.createEphemeralReset("replay_gap"));
			} else {
				for (const event of this.history) {
					if (event.sequence > afterSequence) this.deliver(subscriber, event);
				}
			}
		}
		this.subscribers.add(subscriber);
		return {
			unsubscribe: () => {
				this.subscribers.delete(subscriber);
				if (!this.hasPiSubscribers()) this.piDetails.clear();
			},
		};
	}

	private publish(input: RuntimeLiveEventInput, piEvent?: RuntimeStreamEvent): RuntimeLiveEvent {
		if (input.kind === "runtime" && input.event.type === "steering_input") {
			const previous = this.latestSteering.get(input.event.id);
			if (previous?.kind === "runtime" && previous.event.type === "steering_input") {
				if (previous.event.state === input.event.state || input.event.state === "accepted") return previous;
			}
		}
		const event = {
			...input,
			sequence: ++this.sequence,
			streamId: this.streamId,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
		} as RuntimeLiveEvent;
		if (event.kind === "runtime" && piEvent) {
			this.piDetails.set(event.id, { ...event, event: piEvent });
			while (this.piDetails.size > PI_DETAIL_HISTORY_LIMIT) {
				const oldest = this.piDetails.keys().next().value;
				if (typeof oldest !== "string") break;
				this.piDetails.delete(oldest);
			}
		}
		if (event.kind === "runtime") {
			if (event.event.type === "run_complete") {
				this.activeRuns.delete(event.runId);
				for (const [key, active] of this.activeAssistantText) {
					if (active.kind === "runtime" && active.runId === event.runId) {
						this.activeAssistantText.delete(key);
					}
				}
			}
			else if (event.event.type !== "assistant_text") this.activeRuns.set(event.runId, event);
			if (event.event.type === "assistant_text") {
				this.activeAssistantText.set(assistantTextProjectionKey(event), event);
			}
			if (event.event.type === "steering_input") {
				this.latestSteering.set(event.event.id, event);
				if (event.event.state === "accepted") this.activeSteering.set(event.event.id, event);
				else this.activeSteering.delete(event.event.id);
			}
		}
		if (
			event.kind === "runtime"
			&& (event.event.type === "assistant_snapshot" || event.event.type === "assistant_text")
		) {
			const previousSnapshot = this.history.findIndex((candidate) =>
				candidate.kind === "runtime" &&
				candidate.runId === event.runId &&
				candidate.event.type === event.event.type &&
				(event.event.type !== "assistant_text"
					|| assistantTextProjectionKey(candidate) === assistantTextProjectionKey(event))
			);
			if (previousSnapshot >= 0) {
				const [removed] = this.history.splice(previousSnapshot, 1);
				if (removed) this.piDetails.delete(removed.id);
			}
		}
		this.history.push(event);
		while (this.history.length > this.historyLimit) {
			const removed = this.history.shift();
			if (removed) this.piDetails.delete(removed.id);
			if (
				removed?.kind === "runtime"
				&& removed.event.type === "steering_input"
				&& this.latestSteering.get(removed.event.id)?.id === removed.id
				&& !this.activeSteering.has(removed.event.id)
			) {
				this.latestSteering.delete(removed.event.id);
			}
		}
		for (const subscriber of this.subscribers) this.deliver(subscriber, event);
		return event;
	}

	private deliver(subscriber: LiveEventSubscriber, event: RuntimeLiveEvent): void {
		subscriber.listener(subscriber.presentation === "pi"
			? this.piDetails.get(event.id) ?? event
			: event);
	}

	private hasPiSubscribers(): boolean {
		return [...this.subscribers].some((subscriber) => subscriber.presentation === "pi");
	}

	private createEphemeralReset(reason: "replay_gap"): RuntimeLiveEvent {
		return {
			kind: "reset",
			reason,
			sequence: this.sequence,
			streamId: this.streamId,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
		};
	}
}

/**
 * Live clients need visible input, safe tool labels, and tool completion
 * state. Raw arguments, tool output, results, and thinking never cross the
 * shared live endpoint.
 */
export function projectRuntimeEventForTerminal(event: RuntimeStreamEvent): RuntimeStreamEvent {
	if (event.type === "user_input" || event.type === "steering_input") {
		return {
			...event,
			entries: event.entries
				.filter((entry) => entry.channel.trim() && entry.text.trim())
				.map((entry) => {
					const sender = readVerifiedSenderIdentity({ source: "verified_ingress", ...entry });
					return {
						channel: entry.channel.trim(),
						userName: entry.userName.trim() || "user",
						...(sender ? { userId: sender.userId, displayName: sender.displayName } : {}),
						text: entry.text,
					};
				}),
		};
	}
	if (event.type === "assistant_snapshot") {
		return {
			...event,
			entry: {
				...event.entry,
				content: event.entry.content.flatMap(projectSnapshotContent),
			},
		};
	}
	if (event.type === "assistant_text") {
		return {
			type: "assistant_text",
			completionId: event.completionId,
			revision: event.revision,
			text: event.text,
			isFinal: event.isFinal,
			...(event.outcome ? { outcome: event.outcome } : {}),
			...(event.durableMessageIds ? { durableMessageIds: [...event.durableMessageIds] } : {}),
			speechEligible: event.speechEligible,
			...(event.presentationMode ? { presentationMode: event.presentationMode } : {}),
			...(event.presentationSegment ? {
				presentationSegment: {
					id: event.presentationSegment.id,
					index: event.presentationSegment.index,
					revision: event.presentationSegment.revision,
					text: event.presentationSegment.text,
					isFinal: event.presentationSegment.isFinal,
					startedAt: event.presentationSegment.startedAt,
					...(event.presentationSegment.durableMessageIds
						? { durableMessageIds: [...event.presentationSegment.durableMessageIds] }
						: {}),
				},
			} : {}),
			...(event.mode ? { mode: event.mode } : {}),
		};
	}
	if (
		event.type === "toolCall" ||
		event.type === "toolcall_start" ||
		event.type === "toolcall_delta" ||
		event.type === "toolcall_end"
	) {
		const projected = {
			...event,
			arguments: event.arguments ? {} : event.arguments,
			delta: event.delta === undefined ? undefined : "",
			toolCall: event.toolCall ? compactToolCall(event.toolCall) : event.toolCall,
			toolCalls: event.toolCalls?.map((toolCall) => compactToolCall(toolCall)),
		};
		return projected;
	}
	if (event.type === "toolResult") return { ...event, result: "" };
	if (event.type === "toolResultDelta") return { ...event, text: "" };
	if (event.type === "thinking_delta") return { ...event, delta: "", thinking: "" };
	if (event.type === "thinking_patch") return { ...event, thinking: "" };
	return event;
}

/**
 * Optional Pi-style snapshots carry only the existing bounded, redacted
 * display projection. Raw arguments, output, results, and thinking still never
 * enter live history or cross the terminal endpoint.
 */
export function projectRuntimeEventForPiTerminal(event: RuntimeStreamEvent): RuntimeStreamEvent | undefined {
	if (event.type !== "assistant_snapshot") return undefined;
	const compact = projectRuntimeEventForTerminal(event);
	if (compact.type !== "assistant_snapshot") return undefined;
	const budget = { remainingCharacters: PI_SNAPSHOT_DETAIL_CHARACTER_LIMIT };
	return {
		...compact,
		entry: {
			...compact.entry,
			content: event.entry.content.flatMap((block) => projectPiSnapshotContent(block, budget)),
		},
	};
}

function projectPiSnapshotContent(
	block: RuntimeAssistantSnapshotContent,
	budget: { remainingCharacters: number },
): RuntimeAssistantSnapshotContent[] {
	if (block.type === "thinking") return [];
	if (block.type === "toolCall") {
		const compact = projectSnapshotContent(block)[0];
		if (!compact || compact.type !== "toolCall") return [];
		const displayDetails = reservePiDetails(projectToolInvocationDetails({
			name: block.name,
			arguments: block.arguments,
			startedAt: block.startedAt,
		}), budget);
		return [{ ...compact, ...(displayDetails ? { displayDetails } : {}) }];
	}
	if (block.type === "toolOutput") {
		const displayDetails = reservePiDetails(projectToolResultDetails({
			text: block.text,
		}), budget);
		if (!displayDetails?.result) return [];
		return [{
			...block,
			text: displayDetails.result.text,
			displayDetails,
		}];
	}
	if (block.type === "toolResult") {
		const displayDetails = reservePiDetails(projectToolResultDetails({
			result: block.result,
			isError: block.isError === true,
		}), budget);
		return [{
			...block,
			result: displayDetails?.result?.text ?? "",
			...(displayDetails ? { displayDetails } : {}),
		}];
	}
	return [block];
}

function reservePiDetails(
	details: RuntimeToolExecutionDetails | undefined,
	budget: { remainingCharacters: number },
): RuntimeToolExecutionDetails | undefined {
	if (!details) return undefined;
	let size: number;
	try {
		size = JSON.stringify(details).length;
	} catch {
		return undefined;
	}
	if (size > budget.remainingCharacters) {
		budget.remainingCharacters = 0;
		return undefined;
	}
	budget.remainingCharacters -= size;
	return details;
}

function assistantTextProjectionKey(event: RuntimeLiveEvent): string {
	if (event.kind !== "runtime" || event.event.type !== "assistant_text") return "";
	const segment = event.event.presentationSegment?.id;
	if (event.event.presentationMode === "ordered_segments") {
		return `${event.runId}:ordered:${segment ?? "terminal"}`;
	}
	return `${event.runId}:legacy`;
}

function compactToolCall(block: RuntimeToolCallContent, preserveLabel = false): RuntimeToolCallContent {
	const projected = {
		...block,
		arguments: preserveLabel && block.label ? { label: block.label } : {},
	};
	delete projected.displayDetails;
	return projected;
}

function projectSnapshotContent(block: RuntimeAssistantSnapshotContent): RuntimeAssistantSnapshotContent[] {
	if (block.type === "thinking" || block.type === "toolOutput") return [];
	if (block.type === "toolCall") return [compactToolCall(block, true)];
	if (block.type === "toolResult") {
		const projected = { ...block, result: "" };
		delete projected.displayDetails;
		return [projected];
	}
	return [block];
}
