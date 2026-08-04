import type { MomEvent } from "./adapters/types.js";

interface SteerableRunner {
	steer(text: string, options?: { projectionId?: string }): unknown;
}

export function tryTerminalTuiSoftSteer(
	event: MomEvent,
	runner: SteerableRunner,
	now = new Date(),
	projectionId?: string,
): boolean {
	if (event.sourceEventType !== "terminal_tui") return false;
	return Boolean(runner.steer(
		formatTerminalTuiSteer(event, now),
		projectionId ? { projectionId } : undefined,
	));
}

export function formatTerminalTuiSteer(event: MomEvent, now = new Date()): string {
	const channel = event.channel.trim() || "terminal";
	return `[${now.toISOString()}] [${channel}] [terminal]: ${event.text.trim()}`;
}
