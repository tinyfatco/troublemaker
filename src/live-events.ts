import { randomUUID } from "node:crypto";
import type {
	RuntimeAssistantSnapshotContent,
	RuntimeLiveEvent,
	RuntimeLiveRunMetadata,
	RuntimeStreamEvent,
} from "./core/runtime-contract.js";

const DEFAULT_HISTORY_LIMIT = 512;

type RuntimeLiveEventInput =
	| { kind: "awareness"; line: string; awarenessId?: string }
	| ({ kind: "runtime"; event: RuntimeStreamEvent } & RuntimeLiveRunMetadata)
	| { kind: "reset"; reason: "context_rotated" | "replay_gap" };

export interface LiveEventSubscription {
	unsubscribe(): void;
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
	private readonly subscribers = new Set<(event: RuntimeLiveEvent) => void>();

	constructor(private readonly historyLimit = DEFAULT_HISTORY_LIMIT) {}

	publishAwareness(line: string, awarenessId?: string): RuntimeLiveEvent {
		return this.publish({ kind: "awareness", line, awarenessId });
	}

	publishRuntime(metadata: RuntimeLiveRunMetadata, event: RuntimeStreamEvent): RuntimeLiveEvent {
		return this.publish({
			kind: "runtime",
			...metadata,
			event: projectRuntimeEventForTerminal(event),
		});
	}

	publishReset(reason: "context_rotated" | "replay_gap"): RuntimeLiveEvent {
		return this.publish({ kind: "reset", reason });
	}

	subscribe(listener: (event: RuntimeLiveEvent) => void, afterSequence = 0): LiveEventSubscription {
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
				listener(event);
			}
		} else {
			const oldest = this.history[0]?.sequence;
			if (oldest !== undefined && afterSequence < oldest - 1) {
				listener(this.createEphemeralReset("replay_gap"));
			} else {
				for (const event of this.history) {
					if (event.sequence > afterSequence) listener(event);
				}
			}
		}
		this.subscribers.add(listener);
		return {
			unsubscribe: () => this.subscribers.delete(listener),
		};
	}

	private publish(input: RuntimeLiveEventInput): RuntimeLiveEvent {
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
			if (previousSnapshot >= 0) this.history.splice(previousSnapshot, 1);
		}
		this.history.push(event);
		while (this.history.length > this.historyLimit) {
			const removed = this.history.shift();
			if (
				removed?.kind === "runtime"
				&& removed.event.type === "steering_input"
				&& this.latestSteering.get(removed.event.id)?.id === removed.id
				&& !this.activeSteering.has(removed.event.id)
			) {
				this.latestSteering.delete(removed.event.id);
			}
		}
		for (const subscriber of this.subscribers) subscriber(event);
		return event;
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
				.map((entry) => ({
					channel: entry.channel.trim(),
					userName: entry.userName.trim() || "user",
					text: entry.text,
				})),
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
		return {
			...event,
			arguments: event.arguments ? {} : event.arguments,
			delta: event.delta === undefined ? undefined : "",
			toolCall: event.toolCall ? { ...event.toolCall, arguments: {} } : event.toolCall,
			toolCalls: event.toolCalls?.map((toolCall) => ({ ...toolCall, arguments: {} })),
		};
	}
	if (event.type === "toolResult") return { ...event, result: "" };
	if (event.type === "toolResultDelta") return { ...event, text: "" };
	if (event.type === "thinking_delta") return { ...event, delta: "", thinking: "" };
	if (event.type === "thinking_patch") return { ...event, thinking: "" };
	return event;
}

function assistantTextProjectionKey(event: RuntimeLiveEvent): string {
	if (event.kind !== "runtime" || event.event.type !== "assistant_text") return "";
	const segment = event.event.presentationSegment?.id;
	if (event.event.presentationMode === "ordered_segments") {
		return `${event.runId}:ordered:${segment ?? "terminal"}`;
	}
	return `${event.runId}:legacy`;
}

function projectSnapshotContent(block: RuntimeAssistantSnapshotContent): RuntimeAssistantSnapshotContent[] {
	if (block.type === "thinking" || block.type === "toolOutput") return [];
	if (block.type === "toolCall") {
		return [{
			...block,
			arguments: block.label ? { label: block.label } : {},
		}];
	}
	if (block.type === "toolResult") {
		return [{ ...block, result: "" }];
	}
	return [block];
}
