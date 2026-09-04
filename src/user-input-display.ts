const MODEL_CONTEXT_BLOCK_RE = /\s*<(session_context|delivery_context)>[\s\S]*?<\/\1>\s*/g;
const USER_PREFIX_RE = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]:\s*([\s\S]*)$/;
const FOLLOW_UP_CHECKPOINT_RE = /^\[ATTENTION:follow-up-[^\]\n]+:one-shot:[^\]\n]+\]\s+\[FOLLOW_UP\s+(\d+)\/(\d+)\s+after\s+(\d+)\s+minutes?\s+since the latest completed wake\]/;
const HEARTBEAT_CHECKPOINT_RE = /^\[ATTENTION:[^\]\r\n]+:(?:immediate|one-shot|periodic):[^\]\r\n]+\]\s+[\s\S]*\S$/;

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
	const lane = generatedInputLane(envelope.channel, envelope.userName);
	return [{
		channel: envelope.channel,
		userName: envelope.userName,
		text: lane === "follow-up"
			? compactFollowUpCheckpoint(envelope.text)
			: lane === "heartbeat"
				? compactHeartbeatCheckpoint(envelope.text)
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

/** Keep a generated heartbeat visible without painting its schedule or checklist. */
export function compactHeartbeatCheckpoint(text: string): string {
	return HEARTBEAT_CHECKPOINT_RE.test(text) ? "Heartbeat" : text;
}

/** Exact terminal-only shape produced for an internal heartbeat wake. */
export function isCompactHeartbeatInput(input: VisibleUserInput): boolean {
	return generatedInputLane(input.channel, input.userName) === "heartbeat"
		&& input.text === "Heartbeat";
}

export function isCompactGeneratedInput(input: VisibleUserInput): boolean {
	return isCompactFollowUpInput(input) || isCompactHeartbeatInput(input);
}

type GeneratedInputLane = "follow-up" | "heartbeat";

function generatedInputLane(channel: string, userName: string): GeneratedInputLane | null {
	if (channel === "follow-up" && userName === "follow-up") return "follow-up";
	if ((channel === "heartbeat" || channel === "heartbeat:heartbeat") && userName === "heartbeat") return "heartbeat";
	return null;
}

function embeddedGeneratedInputLane(text: string): GeneratedInputLane | null {
	if (/\[[^\]\r\n]+\]\s+\[follow-up\]\s+\[follow-up\]:/.test(text)) return "follow-up";
	if (/\[[^\]\r\n]+\]\s+\[heartbeat(?::heartbeat)?\]\s+\[heartbeat\]:/.test(text)) return "heartbeat";
	return null;
}

function redactedGeneratedSessionLine(lane: GeneratedInputLane): string {
	return JSON.stringify({
		type: "custom",
		customType: lane === "follow-up"
			? "troublemaker.generated-follow-up-redacted"
			: "troublemaker.generated-heartbeat-redacted",
		display: false,
	});
}

function compactGeneratedCheckpoint(lane: GeneratedInputLane, text: string): string {
	return lane === "follow-up"
		? compactFollowUpCheckpoint(text)
		: compactHeartbeatCheckpoint(text);
}

/**
 * Keep the persisted model prompt intact on disk while projecting only the
 * compact generated wake through awareness APIs. This protects older terminal
 * clients that do their own durable-history rendering after a newer server has
 * already painted the compact live input.
 */
export function sanitizeGeneratedTerminalSessionLine(line: string): string {
	try {
		const entry = JSON.parse(line) as {
			type?: unknown;
			message?: { role?: unknown; content?: unknown };
		};
		if (entry.type !== "message" || entry.message?.role !== "user") return line;

		const content = entry.message.content;
		const textBlocks = typeof content === "string"
			? [content]
			: Array.isArray(content)
				? content.flatMap((block) => block && typeof block === "object"
					&& (block as { type?: unknown }).type === "text"
					&& typeof (block as { text?: unknown }).text === "string"
						? [(block as { text: string }).text]
						: [])
				: [];
		const combined = textBlocks.join("\n");
		const combinedEnvelope = parseUserPromptEnvelope(combined);
		const candidateLane = combinedEnvelope
			? generatedInputLane(combinedEnvelope.channel, combinedEnvelope.userName)
			: embeddedGeneratedInputLane(combined);
		if (!candidateLane) return line;

		// A generated wake is canonical only as one complete text value. Any
		// split, extra, or malformed internal shape is hidden rather than
		// returning its harness to an older client.
		const canonicalText = typeof content === "string"
			? content
			: Array.isArray(content) && content.length === 1 && textBlocks.length === 1
				? textBlocks[0]
				: null;
		if (!canonicalText) return redactedGeneratedSessionLine(candidateLane);
		const envelope = parseUserPromptEnvelope(canonicalText);
		const lane = envelope ? generatedInputLane(envelope.channel, envelope.userName) : null;
		if (!envelope || lane !== candidateLane) return redactedGeneratedSessionLine(candidateLane);
		const compact = compactGeneratedCheckpoint(lane, envelope.text);
		if (compact === envelope.text || !isCompactGeneratedInput({
			channel: envelope.channel,
			userName: envelope.userName,
			text: compact,
		})) return redactedGeneratedSessionLine(lane);
		const projectedText = `[${envelope.timestamp}] [${envelope.channel}] [${envelope.userName}]: ${compact}`;
		const sanitizedContent = typeof content === "string" ? projectedText : [{ type: "text", text: projectedText }];
		return JSON.stringify({ ...entry, message: { ...entry.message, content: sanitizedContent } });
	} catch {
		const lane = embeddedGeneratedInputLane(line);
		return lane ? redactedGeneratedSessionLine(lane) : line;
	}
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
