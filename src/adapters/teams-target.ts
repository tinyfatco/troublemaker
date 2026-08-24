const TEAMS_TARGET_PREFIX = "teams:";
const MAX_TARGET_COMPONENT_LENGTH = 2_048;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function validTargetComponent(value: string): boolean {
	return value.length > 0
		&& value.length <= MAX_TARGET_COMPONENT_LENGTH
		&& !CONTROL_CHARACTER.test(value);
}

export interface TeamsTarget {
	conversationId: string;
	messageId?: string;
	target: string;
}

export function formatTeamsTarget(conversationId: string, messageId?: string): string {
	const conversation = conversationId.trim();
	if (!validTargetComponent(conversation)) throw new Error("Teams conversation ID is invalid");
	const base = `${TEAMS_TARGET_PREFIX}${encodeURIComponent(conversation)}`;
	const message = messageId?.trim();
	if (message !== undefined && !validTargetComponent(message)) throw new Error("Teams message ID is invalid");
	return message ? `${base}:${encodeURIComponent(message)}` : base;
}

export function parseTeamsTarget(value: unknown): TeamsTarget | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed.startsWith(TEAMS_TARGET_PREFIX)) return null;
	const encoded = trimmed.slice(TEAMS_TARGET_PREFIX.length);
	if (!encoded) return null;
	const separator = encoded.indexOf(":");
	const encodedConversation = separator === -1 ? encoded : encoded.slice(0, separator);
	const encodedMessage = separator === -1 ? undefined : encoded.slice(separator + 1);
	if (!encodedConversation || encodedMessage === "") return null;
	try {
		const conversationId = decodeURIComponent(encodedConversation);
		const messageId = encodedMessage === undefined ? undefined : decodeURIComponent(encodedMessage);
		if (!validTargetComponent(conversationId)
			|| (messageId !== undefined && !validTargetComponent(messageId))) return null;
		return {
			conversationId,
			...(messageId ? { messageId } : {}),
			target: formatTeamsTarget(conversationId, messageId),
		};
	} catch {
		return null;
	}
}
