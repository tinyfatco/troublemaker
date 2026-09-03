import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripModelContextBlocks } from "../user-input-display.js";

const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;
const TERMINAL_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/** Select the oldest local prompt represented by the current queued count. */
export function selectWaitingPrompt(prompts: readonly string[], queuedCount: number): string | undefined {
	const count = Math.max(0, Math.floor(queuedCount));
	if (count === 0 || prompts.length === 0) return undefined;
	const represented = Math.min(count, prompts.length);
	return prompts[prompts.length - represented];
}

/** Keep a locally entered prompt safe for a single terminal status line. */
export function sanitizeWaitingPrompt(prompt: string): string {
	return stripModelContextBlocks(prompt)
		.replace(ANSI_ESCAPE_RE, "")
		.replace(TERMINAL_CONTROL_RE, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Show the next locally entered prompt while reserving room for a multi-input
 * count. If no local prompt is available, retain a count-only privacy fallback
 * rather than exposing queued work from another channel.
 */
export function formatWaitingInputStatus(
	baseStatus: string,
	queuedCount: number,
	localPrompts: readonly string[],
	maxWidth: number,
): string {
	const width = Math.max(1, Math.floor(maxWidth));
	const queued = Math.max(0, Math.floor(queuedCount));
	if (queued === 0) return truncateToWidth(baseStatus, width);

	const waiting = sanitizeWaitingPrompt(selectWaitingPrompt(localPrompts, queued) ?? "");
	if (!waiting) {
		const countOnly = `${baseStatus} · ${queued} input${queued === 1 ? "" : "s"} queued`;
		return truncateToWidth(countOnly, width);
	}

	let remaining = queued > 1 ? ` (+${queued - 1} more)` : "";
	const waitingPrefix = "Waiting: ";
	if (width - visibleWidth(waitingPrefix) - visibleWidth(remaining) < 4 && queued > 1) {
		remaining = ` (+${queued - 1})`;
	}
	if (width - visibleWidth(waitingPrefix) - visibleWidth(remaining) < 1) {
		remaining = "";
	}

	const separator = " · Waiting: ";
	const minimumPromptWidth = 8;
	let shownBase = baseStatus;
	const fullBaseBudget = width - visibleWidth(separator) - visibleWidth(remaining) - minimumPromptWidth;
	if (fullBaseBudget < visibleWidth(shownBase)) {
		shownBase = fullBaseBudget >= 8 ? truncateToWidth(shownBase, fullBaseBudget) : "";
	}
	const prefix = shownBase ? `${shownBase}${separator}` : waitingPrefix;
	const promptWidth = width - visibleWidth(prefix) - visibleWidth(remaining);
	if (promptWidth <= 0) return truncateToWidth(`${waitingPrefix}${waiting}`, width);
	return `${prefix}${truncateToWidth(waiting, promptWidth, promptWidth < 4 ? "" : "...")}${remaining}`;
}
