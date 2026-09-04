export const CONCISE_WATCH_HISTORY_MAXIMUM_MESSAGES = 32;
export const CONCISE_WATCH_HISTORY_MAXIMUM_BYTES = 64 * 1_024;

export interface ConciseWatchContextProjection<T> {
	messages: T[];
	sourceMessageCount: number;
	sourceBytes: number;
	projectedBytes: number;
}

/**
 * Keep only a bounded suffix of complete historical messages for the Watch
 * voice prompt. The current request is supplied separately by the runner, and
 * the system prompt plus full workspace identity/memory/tool authority are not
 * inputs to this projector.
 */
export function projectConciseWatchHistory<T>(
	messages: readonly T[],
	maximumMessages = CONCISE_WATCH_HISTORY_MAXIMUM_MESSAGES,
	maximumBytes = CONCISE_WATCH_HISTORY_MAXIMUM_BYTES,
): ConciseWatchContextProjection<T> {
	if (!Number.isSafeInteger(maximumMessages) || maximumMessages < 1
		|| !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
		throw new Error("Invalid concise Watch history bounds");
	}
	const sizes = messages.map(encodedMessageBytes);
	const sourceBytes = sizes.reduce((total, size) => total + size, 0);
	let projectedBytes = 0;
	let projectedCount = 0;
	let earliestIncludedUser = -1;
	for (let index = messages.length - 1; index >= 0; index--) {
		const size = sizes[index]!;
		if (projectedCount >= maximumMessages || projectedBytes + size > maximumBytes) break;
		projectedBytes += size;
		projectedCount++;
		if (messageRole(messages[index]) === "user") earliestIncludedUser = index;
	}
	const projected = earliestIncludedUser >= 0
		? messages.slice(earliestIncludedUser)
		: [];
	return {
		messages: [...projected],
		sourceMessageCount: messages.length,
		sourceBytes,
		projectedBytes: projected.reduce(
			(total, message) => total + encodedMessageBytes(message),
			0,
		),
	};
}

function encodedMessageBytes(value: unknown): number {
	let encoded: string;
	try { encoded = JSON.stringify(value) ?? "null"; }
	catch { encoded = "null"; }
	return Buffer.byteLength(encoded) + 1;
}

function messageRole(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const role = (value as { role?: unknown }).role;
	return typeof role === "string" ? role : undefined;
}
