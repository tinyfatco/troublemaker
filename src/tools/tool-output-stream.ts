import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeToolOutputStream } from "../core/runtime-contract.js";

export interface ToolOutputEvent {
	type: "toolResultDelta";
	toolCallId: string;
	stream: RuntimeToolOutputStream;
	text: string;
	pid?: number;
	sequence: number;
}

type ToolOutputSink = (event: ToolOutputEvent) => void | Promise<void>;

interface ToolOutputContext {
	emit: ToolOutputSink;
	nextSequence: () => number;
}

const storage = new AsyncLocalStorage<ToolOutputContext>();

export async function withToolOutputStream<T>(
	emit: ToolOutputSink,
	fn: () => Promise<T>,
): Promise<T> {
	let sequence = 0;
	return storage.run({
		emit,
		nextSequence: () => {
			sequence += 1;
			return sequence;
		},
	}, fn);
}

export function emitToolOutput(event: Omit<ToolOutputEvent, "type" | "sequence">): void {
	const ctx = storage.getStore();
	if (!ctx) return;
	void ctx.emit({
		type: "toolResultDelta",
		toolCallId: event.toolCallId,
		stream: event.stream,
		text: event.text,
		pid: event.pid,
		sequence: ctx.nextSequence(),
	});
}
