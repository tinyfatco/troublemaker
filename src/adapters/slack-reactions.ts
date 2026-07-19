const SLACK_MESSAGE_TARGET_RE = /^slack:([CDG][A-Z0-9]+):(\d+\.\d+)$/;
const SLACK_EMOJI_NAME_RE = /^[a-z0-9_+-]{1,100}(?:::skin-tone-[2-6])?$/;

export interface SlackMessageTarget {
	channelId: string;
	messageTs: string;
	target: string;
}

/** Parse the exact Slack message target required by reactions.add. */
export function parseSlackMessageTarget(value: unknown): SlackMessageTarget | null {
	if (typeof value !== "string") return null;
	const match = value.trim().match(SLACK_MESSAGE_TARGET_RE);
	if (!match) return null;
	return {
		channelId: match[1],
		messageTs: match[2],
		target: `slack:${match[1]}:${match[2]}`,
	};
}

/**
 * Normalize Slack's API emoji-name form. A single matching pair of wrapper
 * colons is accepted for convenience; malformed wrappers and Unicode glyphs
 * fail closed instead of being forwarded to Slack.
 */
export function normalizeSlackEmojiName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let name = value.trim();
	if (name.startsWith(":") || name.endsWith(":")) {
		if (!(name.startsWith(":") && name.endsWith(":")) || name.length < 3) return null;
		name = name.slice(1, -1);
	}
	return SLACK_EMOJI_NAME_RE.test(name) ? name : null;
}
