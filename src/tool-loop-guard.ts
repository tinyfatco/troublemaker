import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TOOL_LOOP_STOP_MESSAGE = "Stopped because tool calls kept repeating with unchanged results. Send a new instruction to continue with a different approach.";
const WARNING = "Repeated tool calls are returning unchanged results. Change your approach, explain the blocker, or call yield_no_action if there is nothing useful to add. Continued repetition will stop this run.";

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(
		Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
	);
	return value;
}

/** Bounded, per-run detection of unchanged tool cycles, including alternating calls. */
export class ToolLoopGuard {
	private history: string[] = [];
	stopped = false;

	reset(): void {
		this.history = [];
		this.stopped = false;
	}

	record(toolName: string, input: Record<string, unknown>, content: unknown, isError: boolean): "warn" | "stop" | undefined {
		if (this.stopped) return "stop";
		// The compact tool surface routes calls through call_tool.
		if (toolName === "call_tool" && typeof input.name === "string" && input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)) {
			toolName = input.name;
			input = input.arguments as Record<string, unknown>;
		}
		// Presentation labels do not change what a tool does. Preserve nested arguments.
		const { label: _label, show: _show, ...args } = input;
		const fingerprint = createHash("sha256").update(JSON.stringify(canonical([toolName, args, content, isError]))).digest("hex");
		this.history.push(fingerprint);
		if (this.history.length > 30) this.history.shift();
		for (let width = 1; width <= 6; width++) {
			let repeats = 1;
			const end = this.history.length;
			while ((repeats + 1) * width <= end &&
				this.history.slice(end - width, end).every((item, i) => item === this.history[end - (repeats + 1) * width + i])) repeats++;
			if (repeats >= 5) { this.stopped = true; return "stop"; }
			if (repeats >= 3) return "warn";
		}
		return undefined;
	}

	extension = (pi: ExtensionAPI): void => {
		pi.on("tool_call", () => this.stopped ? { block: true, terminate: true, reason: TOOL_LOOP_STOP_MESSAGE } : undefined);
		pi.on("tool_result", (event, ctx) => {
			const decision = this.record(event.toolName, event.input, event.content, event.isError);
			if (decision === "stop") ctx.abort();
			if (decision) return { content: [...event.content, { type: "text", text: decision === "stop" ? TOOL_LOOP_STOP_MESSAGE : WARNING }] };
		});
	};
}
