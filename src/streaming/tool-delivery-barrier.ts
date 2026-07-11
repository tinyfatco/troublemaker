const displayBarriers = new Map<string, Promise<void>>();

export function registerToolDisplayBarrier(toolCallId: string, barrier: Promise<void>): void {
	if (!toolCallId) return;
	displayBarriers.set(toolCallId, barrier);
	void barrier.finally(() => {
		if (displayBarriers.get(toolCallId) === barrier) displayBarriers.delete(toolCallId);
	});
}

export async function waitForToolDisplay(toolCallId: string): Promise<void> {
	// Pi emits tool_execution_start immediately before execute. Yield once so the
	// async event handler can register the platform delivery barrier first.
	await Promise.resolve();
	await displayBarriers.get(toolCallId);
}
