import { reduceWebChatStreamEntry } from '../ui/src/webChatStream.ts';
import type {
	AwarenessEntry,
	TextContent,
	ThinkingContent,
	ToolCallContent,
	ToolOutputContent,
	ToolResultContent,
} from '../ui/src/types.ts';

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
		id: 'local-live-assistant',
		type: 'message',
		timestamp: '2026-06-12T00:00:00.000Z',
		role: 'assistant',
		content: [],
		isStreaming: true,
	};
}

let entry = reduceWebChatStreamEntry(assistant(), {
	type: 'assistant_snapshot',
	entry: {
		id: 'live-assistant',
		type: 'message',
		timestamp: '2026-06-12T00:00:01.000Z',
		role: 'assistant',
		isStreaming: true,
		content: [
			{ type: 'thinking', thinking: 'Need repo context.', contentIndex: 0 },
			{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' }, contentIndex: 1 },
		],
	},
});

const thinking = entry?.content?.find((block) => block.type === 'thinking') as ThinkingContent | undefined;
const toolCall = entry?.content?.find((block) => block.type === 'toolCall') as ToolCallContent | undefined;
assert(entry?.id === 'live-assistant', 'assistant snapshot adopts the runtime live entry id');
assert(entry?.streamProtocol === 'snapshot', 'assistant snapshot marks the live protocol');
assert(thinking?.thinking === 'Need repo context.', 'assistant snapshot renders Pi thinking content');
assert(toolCall?.arguments.command === 'pwd', 'assistant snapshot renders Pi tool calls');

entry = reduceWebChatStreamEntry(entry, {
	type: 'text_delta',
	contentIndex: 2,
	delta: 'duplicate text',
});

assert(
	!entry?.content?.some((block) => block.type === 'text' && block.text === 'duplicate text'),
	'legacy assistant text deltas are ignored after snapshots begin',
);

entry = reduceWebChatStreamEntry(entry, {
	type: 'toolResultDelta',
	toolCallId: 'tool-1',
	stream: 'stdout',
	text: '/Users/example/project\n',
	pid: 123,
	sequence: 1,
});

const output = entry?.content?.find((block) => block.type === 'toolOutput') as ToolOutputContent | undefined;
assert(output?.text === '/Users/example/project\n', 'tool output side channel still streams into snapshot entries');

entry = reduceWebChatStreamEntry(entry, {
	type: 'assistant_snapshot',
	entry: {
		id: 'live-assistant',
		type: 'message',
		timestamp: '2026-06-12T00:00:01.000Z',
		role: 'assistant',
		isStreaming: false,
		content: [
			{ type: 'thinking', thinking: 'Need repo context.', contentIndex: 0 },
			{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' }, contentIndex: 1 },
			{ type: 'toolResult', toolCallId: 'tool-1', result: 'ok' },
			{ type: 'text', text: 'The command ran in the workspace.', contentIndex: 2 },
		],
	},
});

const outputs = entry?.content?.filter((block) => block.type === 'toolOutput') as ToolOutputContent[];
const results = entry?.content?.filter((block) => block.type === 'toolResult') as ToolResultContent[];
const texts = entry?.content?.filter((block) => block.type === 'text') as TextContent[];
assert(entry?.isStreaming === false, 'final assistant snapshot settles the live entry');
assert(outputs.length === 1 && outputs[0]?.text === '/Users/example/project\n', 'tool output is preserved across Pi snapshots');
assert(results.length === 1 && results[0]?.result === 'ok', 'final snapshot includes the tool result once');
assert(texts.length === 1 && texts[0]?.text === 'The command ran in the workspace.', 'final snapshot includes one coherent assistant response');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
