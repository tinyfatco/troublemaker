import { shouldRenderContinuationPlaceholder, shouldRenderStreamingPlaceholder } from '../ui/src/streamingCursor.ts';

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

assert(
	shouldRenderStreamingPlaceholder({ isStreaming: true, content: [] }),
	'empty streaming assistant entry shows the waiting placeholder',
);

assert(
	!shouldRenderStreamingPlaceholder({ isStreaming: true, content: [{ type: 'text', text: 'Hello' }] }),
	'streaming assistant text replaces the waiting placeholder',
);

assert(
	!shouldRenderStreamingPlaceholder({ isStreaming: true, content: [{ type: 'thinking', thinking: 'Thinking' }] }),
	'streaming thinking replaces the waiting placeholder',
);

assert(
	!shouldRenderStreamingPlaceholder({
		isStreaming: true,
		content: [{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: {} }],
	}),
	'streaming tool activity replaces the waiting placeholder',
);

assert(
	shouldRenderStreamingPlaceholder({
		isStreaming: true,
		content: [{ type: 'text', text: '<session_context>hidden</session_context>' }],
	}),
	'session-context-only text still shows the waiting placeholder',
);

assert(
	shouldRenderStreamingPlaceholder({
		isStreaming: true,
		content: [{ type: 'text', text: '<delivery_context>\nMessage type: dm\n</delivery_context>' }],
	}),
	'delivery-context-only text still shows the waiting placeholder',
);

assert(
	!shouldRenderStreamingPlaceholder({ isStreaming: false, content: [] }),
	'settled empty assistant entry does not show the waiting placeholder',
);

assert(
	!shouldRenderContinuationPlaceholder({
		isStreaming: true,
		content: [{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: {} }],
	}),
	'running tool call does not show a separate continuation placeholder',
);

assert(
	shouldRenderContinuationPlaceholder({
		isStreaming: true,
		content: [
			{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: {} },
			{ type: 'toolResult', toolCallId: 'tool-1', result: 'ok' },
		],
	}),
	'settled tool call while stream remains open shows continuation placeholder',
);

assert(
	!shouldRenderContinuationPlaceholder({
		isStreaming: true,
		content: [
			{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: {} },
			{ type: 'toolResult', toolCallId: 'tool-1', result: 'ok' },
			{ type: 'text', text: 'Done.' },
		],
	}),
	'streaming text after a tool hides continuation placeholder',
);

assert(
	!shouldRenderContinuationPlaceholder({
		isStreaming: true,
		content: [
			{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: {} },
			{ type: 'toolCall', id: 'tool-2', name: 'bash', arguments: {} },
			{ type: 'toolResult', toolCallId: 'tool-1', result: 'ok' },
		],
	}),
	'multi-tool group waits until every tool has a result before showing continuation placeholder',
);

assert(
	shouldRenderContinuationPlaceholder({
		isStreaming: true,
		content: [
			{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: {} },
			{ type: 'toolCall', id: 'tool-2', name: 'bash', arguments: {} },
			{ type: 'toolResult', toolCallId: 'tool-1', result: 'ok' },
			{ type: 'toolResult', toolCallId: 'tool-2', result: 'ok' },
		],
	}),
	'multi-tool group shows continuation placeholder once all tools settle',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
