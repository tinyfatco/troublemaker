import { reduceWebChatStreamEntry } from '../ui/src/webChatStream.ts';
import type { AwarenessEntry, ToolCallContent } from '../ui/src/types.ts';

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

function assistant(): AwarenessEntry {
	return {
		id: 'live-assistant',
		type: 'message',
		timestamp: '2026-05-22T00:00:00.000Z',
		role: 'assistant',
		content: [],
		isStreaming: true,
	};
}

let entry = reduceWebChatStreamEntry(assistant(), {
	type: 'toolcall_delta',
	contentIndex: 0,
	partial: {
		content: [{ type: 'toolCall', id: 'tool-1', name: 'send_message_to_channel', arguments: { channel: '123' } }],
	},
});

entry = reduceWebChatStreamEntry(entry, {
	type: 'toolcall_delta',
	contentIndex: 0,
	partial: {
		content: [{ type: 'toolCall', id: 'tool-1', name: 'send_message_to_channel', arguments: { channel: '123', text: 'hello' } }],
	},
});

const partialCalls = entry?.content?.filter((block) => block.type === 'toolCall') as ToolCallContent[];
assert(partialCalls.length === 1, 'toolcall_delta updates one live tool call block');
assert(partialCalls[0]?.arguments.text === 'hello', 'toolcall_delta reveals streamed arguments');

entry = reduceWebChatStreamEntry(entry, {
	type: 'toolCall',
	id: 'tool-1',
	name: 'send_message_to_channel',
	arguments: { channel: '123', text: 'hello', label: 'Notify' },
});

const startedCalls = entry?.content?.filter((block) => block.type === 'toolCall') as ToolCallContent[];
assert(startedCalls.length === 1, 'tool execution start does not duplicate a streamed tool call');
assert(startedCalls[0]?.arguments.label === 'Notify', 'tool execution start merges final validated args');

entry = reduceWebChatStreamEntry(entry, {
	type: 'toolResult',
	toolCallId: 'tool-1',
	result: 'sent',
});
entry = reduceWebChatStreamEntry(entry, {
	type: 'toolResult',
	toolCallId: 'tool-1',
	result: 'sent again',
});

const results = entry?.content?.filter((block) => block.type === 'toolResult') || [];
assert(results.length === 1, 'tool results update by id instead of duplicating');
assert((results[0] as any)?.result === 'sent again', 'latest tool result is retained');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
