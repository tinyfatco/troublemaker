import type { ChannelPulse, PulseEntry } from "./channel-pulse.js";

export interface AmbientDeliveryContext {
	threadTs: string;
	replyTarget?: string;
	replyTargetDescription?: string;
}

export interface AmbientPromptSummary {
	temperature: number;
	recentParticipants: number;
	timeSinceMyLastMs: number;
}

export interface PendingAmbientEvaluation {
	channelId: string;
	timer: ReturnType<typeof setTimeout>;
}

export interface AmbientCancellationResult {
	cancelledTimers: number;
	discardedMessages: number;
}

export interface AmbientThreadPartition {
	sameThread: PulseEntry[];
	deferred: PulseEntry[];
}

/**
 * Frame ambient entries as completed platform messages. This matters when a
 * message contains an earlier pause phrase (for example, "gimme one sec") but
 * then continues with substantive content in the same posted message.
 */
export function buildAmbientEvaluationText(
	channelLabel: string,
	messageLines: string,
	summary: AmbientPromptSummary,
): string {
	const lastSpoke = summary.timeSinceMyLastMs === Infinity
		? "never"
		: `${Math.round(summary.timeSinceMyLastMs / 1000)}s ago`;

	return `[AMBIENT] A conversation is happening in ${channelLabel}. New unseen, complete messages since your last ambient wake:\n\n<ambient_messages>\n${messageLines}\n</ambient_messages>\n\nChannel pulse: ${summary.temperature} messages in last 15min, ${summary.recentParticipants} participants, you last spoke ${lastSpoke}.\n\nEach entry above is one complete, already-posted message. Read every entry through its end before deciding whether to act. A phrase such as "gimme one sec", "hold on", or "let me finish" does not mean the speaker is still composing when substantive content follows it in that same entry. Do not yield merely because of an earlier pause phrase; evaluate and respond to the completed content that follows. Only treat a request to wait as current when it concludes the final message and no substantive continuation follows.\n\nYou're observing this conversation naturally. You were not directly addressed. If you choose to respond to a specific Slack thread, use that message's exact Reply target with send_message. Keep it brief and conversational. If you have nothing to add after evaluating the complete messages, use the yield_no_action tool.`;
}

/**
 * Resolve a delivery locus only when every ambient message belongs to the same
 * native thread. Ambiguous batches intentionally return undefined so adapters
 * can suppress automatic harness output instead of choosing a thread.
 */
export function resolveAmbientDeliveryContext(entries: PulseEntry[]): AmbientDeliveryContext | undefined {
	if (entries.length === 0 || entries.some((entry) => !entry.threadTs)) return undefined;

	const threadTimestamps = new Set(entries.map((entry) => entry.threadTs));
	if (threadTimestamps.size !== 1) return undefined;

	const replyTargets = new Set(entries.map((entry) => entry.replyTarget).filter((target): target is string => Boolean(target)));
	if (replyTargets.size > 1) return undefined;

	const replyTargetDescriptions = new Set(entries
		.map((entry) => entry.replyTargetDescription)
		.filter((description): description is string => Boolean(description)));

	return {
		threadTs: entries[0].threadTs!,
		replyTarget: replyTargets.values().next().value,
		replyTargetDescription: replyTargetDescriptions.size === 1
			? replyTargetDescriptions.values().next().value
			: undefined,
	};
}

export function pulseEntryAmbientKey(entry: Pick<PulseEntry, "messageId" | "participantId" | "ts" | "text">): string {
	return entry.messageId ? `id:${entry.messageId}` : `entry:${entry.participantId}:${entry.ts}:${entry.text ?? ""}`;
}

export function selectUnseenAmbientMessages(
	pulse: ChannelPulse,
	channelId: string,
	includedKeys: Set<string>,
): PulseEntry[] {
	return pulse.recentMessages(channelId).filter((entry) =>
		pulse.isAmbientCandidate(entry) && !includedKeys.has(pulseEntryAmbientKey(entry)),
	);
}

/**
 * Split an ambient batch around the thread that currently owns the active run.
 * Only exact, non-empty thread matches are eligible for soft steering; every
 * other message stays deferred for a later standalone ambient evaluation.
 */
export function partitionAmbientMessagesForThread(
	entries: PulseEntry[],
	activeThreadTs?: string,
): AmbientThreadPartition {
	if (!activeThreadTs) return { sameThread: [], deferred: [...entries] };

	const sameThread: PulseEntry[] = [];
	const deferred: PulseEntry[] = [];
	for (const entry of entries) {
		if (entry.threadTs === activeThreadTs) sameThread.push(entry);
		else deferred.push(entry);
	}
	return { sameThread, deferred };
}

export function markAmbientMessagesIncluded(entries: PulseEntry[], includedKeys: Set<string>): void {
	for (const entry of entries) {
		includedKeys.add(pulseEntryAmbientKey(entry));
	}
}

/**
 * Cancel deferred ambient wakes and consume the backlog they represented.
 * A user stop must not let an already-armed timer resurrect completed work,
 * nor should the discarded backlog replay when later channel activity arrives.
 */
export function cancelPendingAmbientEvaluations(
	pending: Map<string, PendingAmbientEvaluation>,
	includedKeysByScope: Map<string, Set<string>>,
	pulse: ChannelPulse,
): AmbientCancellationResult {
	let discardedMessages = 0;

	for (const [scopeKey, evaluation] of pending) {
		clearTimeout(evaluation.timer);
		let includedKeys = includedKeysByScope.get(scopeKey);
		if (!includedKeys) {
			includedKeys = new Set();
			includedKeysByScope.set(scopeKey, includedKeys);
		}
		const unseenMessages = selectUnseenAmbientMessages(pulse, evaluation.channelId, includedKeys);
		discardedMessages += unseenMessages.length;
		markAmbientMessagesIncluded(unseenMessages, includedKeys);
	}

	const cancelledTimers = pending.size;
	pending.clear();
	return { cancelledTimers, discardedMessages };
}
