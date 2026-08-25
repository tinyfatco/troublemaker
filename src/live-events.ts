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

export interface LiveEventSubscriptionOptions {
	/** Include tool arguments, output, and results. Thinking remains excluded. */
	toolDetails?: boolean;
}

interface LiveEventSubscriber {
	listener: (event: RuntimeLiveEvent) => void;
	toolDetails: boolean;
}

/**
 * Small in-process fanout with bounded reconnect replay. It deliberately owns
 * no platform behavior: transports subscribe to one ordered sequence and each
 * subscription receives its requested projection.
 */
export class RuntimeLiveEventHub {
	private sequence = 0;
	private readonly streamId = randomUUID();
	private readonly history: RuntimeLiveEvent[] = [];
	private readonly activeRuns = new Map<string, RuntimeLiveEvent>();
	private readonly activeSteering = new Map<string, RuntimeLiveEvent>();
	private readonly latestSteering = new Map<string, RuntimeLiveEvent>();
	private readonly subscribers = new Set<LiveEventSubscriber>();

	constructor(private readonly historyLimit = DEFAULT_HISTORY_LIMIT) {}

	publishAwareness(line: string, awarenessId?: string): RuntimeLiveEvent {
		return this.publish({ kind: "awareness", line, awarenessId });
	}

	publishRuntime(metadata: RuntimeLiveRunMetadata, event: RuntimeStreamEvent): RuntimeLiveEvent {
		const published = this.publish({
			kind: "runtime",
			...metadata,
			event,
		});
		return projectLiveEventForTerminal(published, false);
	}

	publishReset(reason: "context_rotated" | "replay_gap"): RuntimeLiveEvent {
		return this.publish({ kind: "reset", reason });
	}

	subscribe(
		listener: (event: RuntimeLiveEvent) => void,
		afterSequence = 0,
		options: LiveEventSubscriptionOptions = {},
	): LiveEventSubscription {
		const subscriber: LiveEventSubscriber = {
			listener,
			toolDetails: options.toolDetails === true,
		};
		if (afterSequence === 0) {
			// A newly opened live client can attach in the middle of an external run.
			// Replay only each active run's latest cumulative state, never stale
			// completed history from earlier in the resident process.
			const active = new Map<string, RuntimeLiveEvent>();
			for (const event of [...this.activeRuns.values(), ...this.activeSteering.values()]) {
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
			unsubscribe: () => this.subscribers.delete(subscriber),
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
			if (event.event.type === "run_complete") this.activeRuns.delete(event.runId);
			else this.activeRuns.set(event.runId, event);
			if (event.event.type === "steering_input") {
				this.latestSteering.set(event.event.id, event);
				if (event.event.state === "accepted") this.activeSteering.set(event.event.id, event);
				else this.activeSteering.delete(event.event.id);
			}
		}
		if (event.kind === "runtime" && event.event.type === "assistant_snapshot") {
			const previousSnapshot = this.history.findIndex((candidate) =>
				candidate.kind === "runtime" &&
				candidate.runId === event.runId &&
				candidate.event.type === "assistant_snapshot"
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
		for (const subscriber of this.subscribers) this.deliver(subscriber, event);
		return event;
	}

	private deliver(subscriber: LiveEventSubscriber, event: RuntimeLiveEvent): void {
		subscriber.listener(projectLiveEventForTerminal(event, subscriber.toolDetails));
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
 * Default live clients receive visible input, safe tool labels, and completion
 * state. An explicit terminal-detail subscription may additionally receive
 * tool arguments, output, and results. Thinking never crosses this endpoint.
 */
export function projectRuntimeEventForTerminal(
	event: RuntimeStreamEvent,
	includeToolDetails = false,
): RuntimeStreamEvent {
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
				content: event.entry.content.flatMap((block) => projectSnapshotContent(block, includeToolDetails)),
			},
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
			arguments: event.arguments
				? includeToolDetails ? event.arguments : {}
				: event.arguments,
			delta: event.delta === undefined
				? undefined
				: includeToolDetails ? event.delta : "",
			toolCall: event.toolCall
				? { ...event.toolCall, arguments: includeToolDetails ? event.toolCall.arguments : {} }
				: event.toolCall,
			toolCalls: event.toolCalls?.map((toolCall) => ({
				...toolCall,
				arguments: includeToolDetails ? toolCall.arguments : {},
			})),
		};
	}
	if (event.type === "toolResult") return { ...event, result: includeToolDetails ? event.result : "" };
	if (event.type === "toolResultDelta") return { ...event, text: includeToolDetails ? event.text : "" };
	if (event.type === "thinking_delta") return { ...event, delta: "", thinking: "" };
	if (event.type === "thinking_patch") return { ...event, thinking: "" };
	return event;
}

function projectLiveEventForTerminal(event: RuntimeLiveEvent, includeToolDetails: boolean): RuntimeLiveEvent {
	if (event.kind !== "runtime") return event;
	return {
		...event,
		event: projectRuntimeEventForTerminal(event.event, includeToolDetails),
	};
}

function projectSnapshotContent(
	block: RuntimeAssistantSnapshotContent,
	includeToolDetails: boolean,
): RuntimeAssistantSnapshotContent[] {
	if (block.type === "thinking") return [];
	if (block.type === "toolOutput") return includeToolDetails ? [block] : [];
	if (block.type === "toolCall") {
		return [{
			...block,
			arguments: includeToolDetails ? block.arguments : block.label ? { label: block.label } : {},
		}];
	}
	if (block.type === "toolResult") {
		return [{ ...block, result: includeToolDetails ? block.result : "" }];
	}
	return [block];
}
