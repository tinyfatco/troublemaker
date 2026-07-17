const SLACK_BROADCAST_MENTION_RE = /<!(?:channel|here|everyone)>/i;
const SLACK_BROADCAST_MENTION_GLOBAL_RE = /<!(?:channel|here|everyone)>/gi;

/** Slack encodes @channel, @here, and @everyone as special mention tokens. */
export function hasSlackBroadcastMention(text: string | undefined): boolean {
	return typeof text === "string" && SLACK_BROADCAST_MENTION_RE.test(text);
}

/** Remove channel-wide addressing after it has been promoted to trigger metadata. */
export function stripSlackBroadcastMentions(text: string): string {
	return text.replace(SLACK_BROADCAST_MENTION_GLOBAL_RE, "").trim();
}
