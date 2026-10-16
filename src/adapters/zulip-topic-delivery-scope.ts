import { AsyncLocalStorage } from "node:async_hooks";

export interface ZulipTopicDeliveryScope {
	deliveryId: string;
	channelId: string;
	topic: string;
	capability: string;
}

const scopeStorage = new AsyncLocalStorage<ZulipTopicDeliveryScope>();
let activeRuntimeScope: ZulipTopicDeliveryScope | undefined;

function sameScope(left: ZulipTopicDeliveryScope, right: ZulipTopicDeliveryScope): boolean {
	return left.deliveryId === right.deliveryId
		&& left.channelId === right.channelId
		&& left.topic === right.topic
		&& left.capability === right.capability;
}

export function currentZulipTopicDeliveryScope(): ZulipTopicDeliveryScope | undefined {
	return scopeStorage.getStore() ?? activeRuntimeScope;
}

export async function withZulipTopicDeliveryScope<T>(
	scope: ZulipTopicDeliveryScope | undefined,
	work: () => Promise<T>,
): Promise<T> {
	if (!scope) return work();
	const previous = activeRuntimeScope;
	if (previous && !sameScope(previous, scope)) {
		throw new Error("overlapping Zulip topic delivery scopes are not allowed");
	}
	activeRuntimeScope = scope;
	try {
		return await scopeStorage.run(scope, work);
	} finally {
		if (activeRuntimeScope === scope) activeRuntimeScope = previous;
	}
}
