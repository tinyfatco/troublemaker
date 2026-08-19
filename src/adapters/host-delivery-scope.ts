import { AsyncLocalStorage } from "node:async_hooks";

export interface HostDeliveryScope {
	source: "mcp-operator";
	eventId: string;
	replyTarget?: string;
}

const storage = new AsyncLocalStorage<HostDeliveryScope>();
let activeRuntimeScope: HostDeliveryScope | undefined;

export async function withHostDeliveryScope<T>(
	scope: HostDeliveryScope,
	work: () => Promise<T>,
): Promise<T> {
	if (activeRuntimeScope && activeRuntimeScope !== scope) {
		throw new Error("A different Host relationship delivery is already active");
	}
	const previous = activeRuntimeScope;
	activeRuntimeScope = scope;
	try {
		return await storage.run(scope, work);
	} finally {
		if (activeRuntimeScope === scope) activeRuntimeScope = previous;
	}
}

export function currentHostDeliveryScope(): HostDeliveryScope | undefined {
	// Claude CLI invokes runtime tools back through the local MCP HTTP bridge.
	// That server callback is outside the initiating AsyncLocalStorage chain, so
	// retain the one process-wide scope while the serialized runtime turn lives.
	return storage.getStore() ?? activeRuntimeScope;
}
