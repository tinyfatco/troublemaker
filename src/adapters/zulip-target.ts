export interface ParsedZulipTarget {
	channel: string;
	threadTs?: string;
	inputTarget: string;
}

const CHANNEL_ID_RE = /^[1-9]\d*$/;
const DM_CHANNEL_RE = /^dm:([1-9]\d*(?:,[1-9]\d*)*)$/;

export function parseZulipTarget(target: string): ParsedZulipTarget | null {
	const input = target.trim();
	const topic = input.match(/^zulip:([1-9]\d*):topic:(.+)$/);
	if (topic) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(topic[2]);
		} catch {
			return null;
		}
		if (!decoded.trim()) return null;
		return { channel: topic[1], threadTs: decoded, inputTarget: formatZulipTopicTarget(topic[1], decoded) };
	}

	const direct = input.match(/^zulip:dm:([1-9]\d*(?:,[1-9]\d*)*)$/);
	if (direct) {
		const channel = formatZulipDmChannel(direct[1].split(","));
		return { channel, inputTarget: `zulip:${channel}` };
	}

	const channel = input.match(/^zulip:([1-9]\d*)$/);
	if (channel) return { channel: channel[1], inputTarget: input };
	return null;
}

export function formatZulipTopicTarget(channelId: string, topic: string): string {
	if (!CHANNEL_ID_RE.test(channelId)) throw new Error("Zulip channel ID is invalid");
	if (!topic.trim()) return `zulip:${channelId}`;
	return `zulip:${channelId}:topic:${encodeURIComponent(topic)}`;
}

export function formatZulipDmChannel(userIds: Iterable<string | number>): string {
	const values = Array.from(userIds, (value) => String(value));
	if (values.some((value) => !CHANNEL_ID_RE.test(value))) {
		throw new Error("Zulip DM target contains an invalid user ID");
	}
	const normalized = Array.from(new Set(values)).sort((left, right) => Number(left) - Number(right));
	if (normalized.length === 0) throw new Error("Zulip DM target requires at least one user ID");
	return `dm:${normalized.join(",")}`;
}

export function parseZulipDmChannel(channel: string): string[] | null {
	const match = channel.match(DM_CHANNEL_RE);
	if (!match) return null;
	return match[1].split(",");
}

export function isZulipChannelId(channel: string): boolean {
	return CHANNEL_ID_RE.test(channel);
}
