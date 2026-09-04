const MODEL_CONTEXT_BLOCK_RE = /\s*<(session_context|delivery_context)>[\s\S]*?<\/\1>\s*/g;
const USER_PREFIX_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/;
const FOLLOW_UP_CHECKPOINT_RE = /^\[ATTENTION:follow-up-[^\]\n]+:one-shot:[^\]\n]+\]\s+\[FOLLOW_UP\s+(\d+)\/(\d+)\s+after\s+(\d+)\s+minutes?\s+since the latest completed wake\]/;

export interface VisibleUserInput {
	channel: string;
	userName: string;
	text: string;
}

export interface UserPromptEnvelope extends VisibleUserInput {
	timestamp: string;
}

export function parseUserPromptEnvelope(prompt: string): UserPromptEnvelope | null {
	const visibleText = stripModelContextBlocks(prompt).trim();
	const match = visibleText.match(USER_PREFIX_RE);
	if (!match) return null;
	return {
		timestamp: match[1],
		channel: match[2].trim() || "unknown",
		userName: match[3].trim() || "user",
		text: match[4].trimStart(),
	};
}

/**
 * Project one model-visible user prompt onto the input rows that are safe to
 * paint in a client transcript. Session/delivery scaffolding and ambient
 * evaluation prompts stay out of the live terminal feed.
 */
export function parseVisibleUserInputs(prompt: string): VisibleUserInput[] {
	const envelope = parseUserPromptEnvelope(prompt);
	if (!envelope || envelope.text.startsWith("[AMBIENT]")) return [];

	const batched = parseInterruptBatchMessages(envelope.text);
	if (batched.length > 0) return batched;
	if (!envelope.text) return [];
	return [{
		channel: envelope.channel,
		userName: envelope.userName,
		text: envelope.channel === "follow-up" && envelope.userName === "follow-up"
			? compactFollowUpCheckpoint(envelope.text)
			: envelope.text,
	}];
}

/** Keep generated follow-up wakes visible without painting their full model prompt. */
export function compactFollowUpCheckpoint(text: string): string {
	const match = text.match(FOLLOW_UP_CHECKPOINT_RE);
	if (!match) return text;
	return `Follow-up ${match[1]}/${match[2]} · ${match[3]}m`;
}

/** Exact terminal-only shape produced for an internal follow-up checkpoint. */
export function isCompactFollowUpInput(input: VisibleUserInput): boolean {
	return input.channel === "follow-up"
		&& input.userName === "follow-up"
		&& /^Follow-up \d+\/\d+ · \d+m$/.test(input.text);
}

export function parseInterruptBatchMessages(text: string): VisibleUserInput[] {
	if (!text.startsWith("Recent messages:\n")) return [];
	const body = text.slice("Recent messages:\n".length);
	const header = /^\[([^\]\n]+)\]\s+\[([^\]\n]+)\]\s+\[([^\]\n]+)\]:[ \t]*/gm;
	const matches = [...body.matchAll(header)];
	// Harness interrupt batches contain at least two messages. Requiring that
	// boundary avoids reinterpreting an ordinary user-authored phrase.
	if (matches.length < 2) return [];

	return matches.map((match, index) => {
		const start = (match.index ?? 0) + match[0].length;
		const end = matches[index + 1]?.index ?? body.length;
		return {
			channel: match[2].trim() || "unknown",
			userName: match[3].trim() || "user",
			text: body.slice(start, end).trimEnd(),
		};
	}).filter((entry) => Boolean(entry.text));
}

export function stripModelContextBlocks(text: string): string {
	return text.replace(MODEL_CONTEXT_BLOCK_RE, "\n");
}
