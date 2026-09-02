import type { MomEvent } from "./adapters/types.js";

interface SteerableRunner {
	steer(text: string, options?: { projectionId?: string; deliveryId?: string }): unknown;
}

export function tryTerminalTuiSoftSteer(
	event: MomEvent,
	runner: SteerableRunner,
	now = new Date(),
	projectionId?: string,
	deliveryId?: string,
): boolean {
	if (event.sourceEventType !== "terminal_tui") return false;
	return Boolean(runner.steer(
		formatTerminalTuiSteer(event, now),
		projectionId ? { projectionId, ...(deliveryId ? { deliveryId } : {}) } : undefined,
	));
}

export function formatTerminalTuiSteer(event: MomEvent, now = new Date()): string {
	const channel = event.channel.trim() || "terminal";
	return `[${now.toISOString()}] [${channel}] [terminal]: ${event.text.trim()}`;
}
