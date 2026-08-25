import {
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	stripTerminalSequences,
	Text,
	type Component,
} from "@earendil-works/pi-tui";
import { isNativeModifierPressed } from "@earendil-works/pi-tui/dist/native-modifiers.js";
import chalk from "chalk";
import type {
	RuntimeAssistantSnapshotContent,
	RuntimeAssistantSnapshotEntry,
	RuntimeToolOutputContent,
	RuntimeToolResultContent,
} from "../core/runtime-contract.js";

export const TOOL_SELECTOR_COMMIT_MS = 450;
const MAX_SELECTOR_DIGITS = 6;
const MAX_DETAIL_CHARACTERS = 24_000;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const CTRL_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const LEGACY_CTRL_DIGITS = new Map([
	["\x00", "2"],
	["\x1b", "3"],
	["\x1c", "4"],
	["\x1d", "5"],
	["\x1e", "6"],
	["\x1f", "7"],
	["\x7f", "8"],
]);

export type TerminalToolState = "pending" | "success" | "error";

export interface TerminalToolCallView {
	selector: number;
	identity: string;
	id: string;
	name: string;
	label: string;
	arguments: Record<string, unknown>;
	outputs: RuntimeToolOutputContent[];
	result?: RuntimeToolResultContent;
	state: TerminalToolState;
	expanded: boolean;
}

/**
 * Owns the session-local selector assigned to every tool call. View objects are
 * mutated in place so already-mounted transcript components receive cumulative
 * output and result updates without rebuilding older conversation segments.
 */
export class TerminalToolCallRegistry {
	private nextSelector = 1;
	private readonly selectorByIdentity = new Map<string, number>();
	private readonly callsBySelector = new Map<number, TerminalToolCallView>();

	updateSnapshot(
		snapshot: RuntimeAssistantSnapshotEntry,
		historical: boolean,
	): Map<number, TerminalToolCallView> {
		const results = new Map(snapshot.content
			.filter((block): block is RuntimeToolResultContent => block.type === "toolResult")
			.map((block) => [block.toolCallId, block] as const));
		const outputs = new Map<string, RuntimeToolOutputContent[]>();
		for (const block of snapshot.content) {
			if (block.type !== "toolOutput") continue;
			const existing = outputs.get(block.toolCallId) || [];
			existing.push(block);
			outputs.set(block.toolCallId, existing);
		}

		const callsByContentIndex = new Map<number, TerminalToolCallView>();
		for (const [contentIndex, block] of snapshot.content.entries()) {
			if (block.type !== "toolCall") continue;
			const identity = toolIdentity(snapshot, block.id, block.contentIndex ?? contentIndex);
			let selector = this.selectorByIdentity.get(identity);
			if (!selector) {
				selector = this.nextSelector++;
				this.selectorByIdentity.set(identity, selector);
			}

			const existing = this.callsBySelector.get(selector);
			const result = results.get(block.id) || existing?.result;
			const state: TerminalToolState = result
				? result.isError ? "error" : "success"
				: historical || snapshot.isStreaming === false ? "success" : "pending";
			const view: TerminalToolCallView = existing || {
				selector,
				identity,
				id: block.id,
				name: block.name,
				label: toolLabel(block),
				arguments: block.arguments,
				outputs: [],
				state,
				expanded: false,
			};
			view.id = block.id;
			view.name = block.name;
			view.label = toolLabel(block);
			if (Object.keys(block.arguments).length > 0 || Object.keys(view.arguments).length === 0) {
				view.arguments = block.arguments;
			}
			const currentOutputs = outputs.get(block.id);
			if (currentOutputs) view.outputs = currentOutputs;
			if (result) view.result = result;
			view.state = state;
			this.callsBySelector.set(selector, view);
			callsByContentIndex.set(contentIndex, view);
		}
		return callsByContentIndex;
	}

	updateResults(content: RuntimeAssistantSnapshotContent[]): void {
		for (const block of content) {
			if (block.type !== "toolResult" || !block.toolCallId) continue;
			const selector = this.selectorByIdentity.get(`tool:${block.toolCallId}`);
			const view = selector ? this.callsBySelector.get(selector) : undefined;
			if (!view) continue;
			view.result = block;
			view.state = block.isError ? "error" : "success";
		}
	}

	toggle(selector: number): boolean {
		const view = this.callsBySelector.get(selector);
		if (!view) return false;
		view.expanded = !view.expanded;
		return true;
	}

	get(selector: number): TerminalToolCallView | undefined {
		return this.callsBySelector.get(selector);
	}
}

/** Renders consecutive labels in one natural flow, followed by selected details. */
export class TerminalToolCallStream implements Component {
	constructor(private readonly calls: TerminalToolCallView[]) {}

	render(width: number): string[] {
		const labels = this.calls.map((call) => formatToolLabel(call)).join("  ");
		const lines = new Text(labels, 1, 0).render(width);
		for (const call of this.calls) {
			if (!call.expanded) continue;
			lines.push(...new Text(formatToolDetails(call), 3, 0).render(width));
		}
		return lines;
	}

	invalidate(): void {
		// Rendering is derived from the mutable registry views on every frame.
	}
}

/** Collects a Ctrl+T-led or enhanced Ctrl+digit burst and commits it after a pause. */
export class ToolSelectorSequence {
	private digits = "";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private acceptsPlainDigits = false;

	constructor(
		private readonly onSelector: (selector: number) => void,
		private readonly commitDelayMs = TOOL_SELECTOR_COMMIT_MS,
		private readonly isControlPressed = () => isNativeModifierPressed("control"),
	) {}

	handleInput(data: string): boolean {
		const digit = ctrlDigit(data, this.isControlPressed);
		if (digit !== undefined) {
			if (isKeyRelease(data) || isKeyRepeat(data)) return true;
			this.acceptsPlainDigits = false;
			this.appendDigit(digit);
			return true;
		}
		if (matchesKey(data, Key.ctrl("t"))) {
			this.flush();
			this.acceptsPlainDigits = true;
			return true;
		}
		if (this.acceptsPlainDigits && /^[0-9]$/.test(data)) {
			this.appendDigit(data);
			return true;
		}
		this.flush();
		return false;
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.acceptsPlainDigits = false;
		if (!this.digits) return;
		const selector = Number.parseInt(this.digits, 10);
		this.digits = "";
		if (Number.isSafeInteger(selector) && selector > 0) this.onSelector(selector);
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.digits = "";
		this.acceptsPlainDigits = false;
	}

	private appendDigit(digit: string): void {
		if (this.digits.length >= MAX_SELECTOR_DIGITS) this.flush();
		this.digits += digit;
		this.scheduleCommit();
	}

	private scheduleCommit(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), this.commitDelayMs);
		this.timer.unref?.();
	}
}

export function formatToolLabel(call: TerminalToolCallView): string {
	const color = call.state === "error" ? chalk.red : call.state === "success" ? chalk.green : chalk.yellow;
	const icon = call.state === "error" ? "×" : call.state === "success" ? "✓" : "→";
	const disclosure = call.expanded ? "▾" : "▸";
	const label = oneLine(call.label) || oneLine(call.name) || "tool";
	return `${chalk.dim(`[${call.selector}]`)} ${chalk.dim(disclosure)} ${color(icon)} ${chalk.bold(label)}`;
}

export function formatToolDetails(call: TerminalToolCallView): string {
	const sections = [`${chalk.dim(`[${call.selector}] tool`)} ${oneLine(call.name) || "tool"}`];
	if (Object.keys(call.arguments).length > 0) {
		sections.push(`${chalk.dim("arguments")}\n${boundDetail(stringifyArguments(call.arguments))}`);
	}
	for (const output of call.outputs) {
		const metadata = typeof output.pid === "number" ? ` · pid ${output.pid}` : "";
		sections.push(`${chalk.dim(`${output.stream}${metadata}`)}\n${boundDetail(output.text) || "(no output)"}`);
	}
	const outputText = call.outputs.map((output) => sanitizeDetail(output.text)).join("");
	if (call.result && (!outputText || sanitizeDetail(call.result.result) !== outputText)) {
		const heading = call.result.isError ? chalk.red("error") : chalk.dim("result");
		sections.push(`${heading}\n${boundDetail(call.result.result) || "(empty result)"}`);
	}
	if (sections.length === 1) sections.push(chalk.dim("No arguments or output received."));
	return sections.join("\n");
}

export function sanitizeDetail(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL_CHARACTERS, "");
}

function ctrlDigit(data: string, isControlPressed: () => boolean): string | undefined {
	for (const digit of CTRL_DIGITS) {
		if (matchesKey(data, Key.ctrl(digit))) return digit;
	}
	if (!isControlPressed()) return undefined;
	if (/^[0-9]$/.test(data)) return data;
	return LEGACY_CTRL_DIGITS.get(data);
}

function toolIdentity(snapshot: RuntimeAssistantSnapshotEntry, toolCallId: string, contentIndex: number): string {
	return toolCallId ? `tool:${toolCallId}` : `snapshot:${snapshot.id}:${contentIndex}`;
}

function toolLabel(block: Extract<RuntimeAssistantSnapshotContent, { type: "toolCall" }>): string {
	const argumentLabel = typeof block.arguments.label === "string" ? block.arguments.label.trim() : "";
	return block.label?.trim() || argumentLabel || block.name.trim() || "tool";
}

function oneLine(value: string): string {
	return sanitizeDetail(value).replace(/\s+/g, " ").trim();
}

function stringifyArguments(value: Record<string, unknown>): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function boundDetail(value: string): string {
	const safe = sanitizeDetail(value);
	if (safe.length <= MAX_DETAIL_CHARACTERS) return safe;
	const headLength = Math.floor(MAX_DETAIL_CHARACTERS * 0.65);
	const tailLength = MAX_DETAIL_CHARACTERS - headLength;
	const omitted = safe.length - headLength - tailLength;
	return `${safe.slice(0, headLength)}\n… ${omitted} characters omitted …\n${safe.slice(-tailLength)}`;
}
