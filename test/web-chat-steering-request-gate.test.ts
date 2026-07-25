import { createStreamRequestGate } from '../ui/src/streamRequestGate.ts';
import type { AwarenessEntry, ToolCallContent } from '../ui/src/types.ts';
import { reduceWebChatStreamEntry } from '../ui/src/webChatStream.ts';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

function assistant(id: string): AwarenessEntry {
	return {
		id,
		type: 'message',
		timestamp: '2026-05-24T00:00:00.000Z',
		role: 'assistant',
		content: [],
		isStreaming: true,
	};
}

const gate = createStreamRequestGate();
let entry: AwarenessEntry | null = assistant('normal');

const normalRequest = gate.activate();
const steeringRequest = gate.activate();
entry = assistant('steering');

function applyScoped(
	requestId: number,
	update: (prev: AwarenessEntry | null) => AwarenessEntry | null,
): boolean {
	if (!gate.isActive(requestId)) return false;
	entry = update(entry);
	return true;
}

const staleSettled = applyScoped(normalRequest, (prev) => prev ? { ...prev, isStreaming: false } : prev);
assert(!staleSettled, 'superseded normal request cannot settle the active steering stream');
assert(entry?.id === 'steering', 'steering request owns the live assistant entry');
assert(entry?.isStreaming === true, 'steering entry stays live after stale normal finalizer');

const liveUpdated = applyScoped(steeringRequest, (prev) => reduceWebChatStreamEntry(prev, {
	type: 'toolcall_delta',
	contentIndex: 0,
	partial: {
		content: [{ type: 'toolCall', id: 'tool-steer', name: 'write', arguments: { path: 'demo.ts' } }],
	},
}));
assert(liveUpdated, 'active steering request can update the stream');

const toolCalls = entry?.content?.filter((block) => block.type === 'toolCall') as ToolCallContent[];
assert(toolCalls.length === 1, 'steering tool delta renders into the live entry');
assert(toolCalls[0]?.id === 'tool-steer', 'steering tool delta keeps its tool id');
assert(toolCalls[0]?.arguments.path === 'demo.ts', 'steering tool delta keeps streamed arguments');

assert(gate.deactivate(steeringRequest), 'active request can be deactivated');
assert(gate.current() === 0, 'deactivated gate has no active request');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
