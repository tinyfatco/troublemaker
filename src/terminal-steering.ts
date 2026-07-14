import type { MomEvent } from "./adapters/types.js";

interface SteerableRunner {
	steer(text: string): boolean;
}

export function tryTerminalTuiSoftSteer(event: MomEvent, runner: SteerableRunner, now = new Date()): boolean {
	if (event.sourceEventType !== "terminal_tui") return false;
	return runner.steer(formatTerminalTuiSteer(event, now));
}

export function formatTerminalTuiSteer(event: MomEvent, now = new Date()): string {
	const channel = event.channel.trim() || "terminal";
	return `[${now.toISOString()}] [${channel}] [terminal]: ${event.text.trim()}`;
}
