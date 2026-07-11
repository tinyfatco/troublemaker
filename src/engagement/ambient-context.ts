import type { ChannelPulse, PulseEntry } from "./channel-pulse.js";

export interface AmbientDeliveryContext {
	threadTs: string;
	replyTarget?: string;
	replyTargetDescription?: string;
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

export function markAmbientMessagesIncluded(entries: PulseEntry[], includedKeys: Set<string>): void {
	for (const entry of entries) {
		includedKeys.add(pulseEntryAmbientKey(entry));
	}
}
