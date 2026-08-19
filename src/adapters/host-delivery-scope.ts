import { AsyncLocalStorage } from "node:async_hooks";

export interface HostDeliveryScope {
	source: "mcp-operator";
	eventId: string;
}

const storage = new AsyncLocalStorage<HostDeliveryScope>();

export function withHostDeliveryScope<T>(
	scope: HostDeliveryScope,
	work: () => Promise<T>,
): Promise<T> {
	return storage.run(scope, work);
}

export function currentHostDeliveryScope(): HostDeliveryScope | undefined {
	return storage.getStore();
}
