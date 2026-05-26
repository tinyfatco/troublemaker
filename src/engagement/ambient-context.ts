import type { ChannelPulse, PulseEntry } from "./channel-pulse.js";

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
