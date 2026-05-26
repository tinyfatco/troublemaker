import { reduceWebChatStreamEntry } from '../ui/src/webChatStream.ts';
import type { AwarenessEntry, ToolCallContent, ToolOutputContent } from '../ui/src/types.ts';

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
		content: [{ type: 'toolCall', id: 'tool-1', name: 'send_message', arguments: { target: '123' } }],
	},
});

entry = reduceWebChatStreamEntry(entry, {
	type: 'toolcall_delta',
	contentIndex: 0,
	partial: {
		content: [{ type: 'toolCall', id: 'tool-1', name: 'send_message', arguments: { target: '123', text: 'hello' } }],
	},
});

const partialCalls = entry?.content?.filter((block) => block.type === 'toolCall') as ToolCallContent[];
assert(partialCalls.length === 1, 'toolcall_delta updates one live tool call block');
assert(partialCalls[0]?.arguments.text === 'hello', 'toolcall_delta reveals streamed arguments');

entry = reduceWebChatStreamEntry(entry, {
	type: 'toolCall',
	id: 'tool-1',
	name: 'send_message',
	arguments: { target: '123', text: 'hello', label: 'Notify' },
});

const startedCalls = entry?.content?.filter((block) => block.type === 'toolCall') as ToolCallContent[];
assert(startedCalls.length === 1, 'tool execution start does not duplicate a streamed tool call');
assert(startedCalls[0]?.arguments.label === 'Notify', 'tool execution start merges final validated args');

entry = reduceWebChatStreamEntry(entry, {
	type: 'toolResultDelta',
	toolCallId: 'tool-1',
	stream: 'system',
	text: '',
	pid: 4242,
	sequence: 1,
});
entry = reduceWebChatStreamEntry(entry, {
	type: 'toolResultDelta',
	toolCallId: 'tool-1',
	stream: 'stdout',
	text: 'line one\n',
	pid: 4242,
	sequence: 2,
});
entry = reduceWebChatStreamEntry(entry, {
	type: 'toolResultDelta',
	toolCallId: 'tool-1',
	stream: 'stderr',
	text: 'line two\n',
	pid: 4242,
	sequence: 3,
});

const outputs = entry?.content?.filter((block) => block.type === 'toolOutput') as ToolOutputContent[];
assert(outputs.length === 1, 'tool result deltas accumulate in one live output block');
assert(outputs[0]?.text === 'line one\nline two\n', 'tool output chunks append in stream order');
assert(outputs[0]?.pid === 4242, 'tool output keeps execution pid metadata');

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

let multi = reduceWebChatStreamEntry(assistant(), {
	type: 'toolcall_delta',
	toolCalls: [
		{ type: 'toolCall', id: 'tool-a', name: 'read_file', arguments: { path: 'README.md' }, contentIndex: 0 },
		{ type: 'toolCall', id: 'tool-b', name: 'bash', arguments: { command: 'pwd' }, contentIndex: 1 },
	],
});

let multiCalls = multi?.content?.filter((block) => block.type === 'toolCall') as ToolCallContent[];
assert(multiCalls.length === 2, 'toolcall_delta can insert multiple live tool call blocks');
assert(multiCalls[1]?.arguments.command === 'pwd', 'second streamed tool call keeps its arguments');

multi = reduceWebChatStreamEntry(multi, {
	type: 'toolcall_delta',
	partial: {
		content: [
			{ type: 'toolCall', id: 'tool-a', name: 'read_file', arguments: { path: 'README.md' } },
			{ type: 'toolCall', id: 'tool-b', name: 'bash', arguments: { command: 'pwd && ls' } },
		],
	},
});

multiCalls = multi?.content?.filter((block) => block.type === 'toolCall') as ToolCallContent[];
assert(multiCalls.length === 2, 'multi-tool partial updates do not duplicate cards');
assert(multiCalls[1]?.arguments.command === 'pwd && ls', 'multi-tool partial updates merge by tool id');

let postTool = reduceWebChatStreamEntry(assistant(), {
	type: 'toolcall_delta',
	contentIndex: 0,
	partial: {
		content: [{ type: 'toolCall', id: 'tool-post', name: 'read_file', arguments: { path: 'plan.md' } }],
	},
});
postTool = reduceWebChatStreamEntry(postTool, {
	type: 'toolResult',
	toolCallId: 'tool-post',
	result: 'ok',
});
postTool = reduceWebChatStreamEntry(postTool, {
	type: 'text_patch',
	contentIndex: 1,
	text: 'The plan',
});
postTool = reduceWebChatStreamEntry(postTool, {
	type: 'text_delta',
	contentIndex: 1,
	delta: ' is ready.',
});

const postToolText = postTool?.content?.filter((block) => block.type === 'text') || [];
assert(postToolText.length === 1, 'post-tool text patch creates one streaming text block');
assert((postToolText[0] as any)?.text === 'The plan is ready.', 'post-tool text deltas append to the indexed text block');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
