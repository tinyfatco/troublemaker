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

/**
 * Terminal clients (Node and Textual TUIs) reach the resident through the web
 * adapter, but the user is in a terminal, not a browser chat. Give those turns
 * terminal-accurate formatting guidance; every other event keeps the adapter's own.
 */
export const TERMINAL_TUI_FORMAT_INSTRUCTIONS = `## Terminal Formatting (Markdown)
You are responding in a terminal UI. Markdown renders: **bold**, *italic*, \`code\`, fenced code blocks, lists, and tables.
Links are not clickable, so show full URLs or paths. Keep responses concise and helpful.`;

export function formatInstructionsForEvent(event: Pick<MomEvent, "sourceEventType">, adapterInstructions: string): string {
	return event.sourceEventType === "terminal_tui" ? TERMINAL_TUI_FORMAT_INSTRUCTIONS : adapterInstructions;
}
