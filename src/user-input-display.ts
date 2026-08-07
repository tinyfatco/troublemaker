const MODEL_CONTEXT_BLOCK_RE = /\s*<(session_context(?:_delta|_ref)?|delivery_context)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/g;
const USER_PREFIX_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/;

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
	return [{ channel: envelope.channel, userName: envelope.userName, text: envelope.text }];
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
