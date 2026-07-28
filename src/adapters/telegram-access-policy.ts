export interface TelegramAccessPolicy {
	allowedUserIds?: ReadonlySet<string>;
	privateOnly: boolean;
}

export interface TelegramIncomingIdentity {
	chatId: string;
	chatType: string;
	userId: string;
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;

export function createTelegramAccessPolicy(input: {
	allowedUserIds?: Iterable<string>;
	privateOnly?: boolean;
}): TelegramAccessPolicy {
	const allowedUserIds = input.allowedUserIds === undefined
		? undefined
		: new Set(Array.from(input.allowedUserIds, (id) => id.trim()).filter(Boolean));
	if (allowedUserIds && Array.from(allowedUserIds).some((id) => !POSITIVE_INTEGER.test(id))) {
		throw new Error("Telegram allowed user IDs must be positive integers");
	}
	return {
		allowedUserIds,
		privateOnly: input.privateOnly === true,
	};
}

export function allowsTelegramIncoming(
	policy: TelegramAccessPolicy,
	identity: TelegramIncomingIdentity,
): boolean {
	if (policy.allowedUserIds !== undefined && !policy.allowedUserIds.has(identity.userId)) return false;
	if (!policy.privateOnly) return true;
	return identity.chatType === "private" && identity.chatId === identity.userId;
}

export function allowsTelegramOutbound(
	policy: TelegramAccessPolicy,
	channelId: string,
	admittedChannelIds: ReadonlySet<string>,
): boolean {
	if (!/^-?\d+$/.test(channelId)) return false;
	if (policy.privateOnly) {
		if (!POSITIVE_INTEGER.test(channelId)) return false;
		return policy.allowedUserIds === undefined || policy.allowedUserIds.has(channelId);
	}
	if (policy.allowedUserIds === undefined) return true;
	return policy.allowedUserIds.has(channelId) || admittedChannelIds.has(channelId);
}
