import { AsyncLocalStorage } from "node:async_hooks";

export interface ZulipTopicDeliveryScope {
	deliveryId: string;
	channelId: string;
	topic: string;
	capability: string;
}

const scopeStorage = new AsyncLocalStorage<ZulipTopicDeliveryScope>();

export function currentZulipTopicDeliveryScope(): ZulipTopicDeliveryScope | undefined {
	return scopeStorage.getStore();
}

export function withZulipTopicDeliveryScope<T>(
	scope: ZulipTopicDeliveryScope,
	work: () => Promise<T>,
): Promise<T> {
	return scopeStorage.run(scope, work);
}
