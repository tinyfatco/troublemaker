import { shouldRenderStreamingCursor } from '../ui/src/streamingCursor.ts';

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
	shouldRenderStreamingCursor({ isStreaming: true, content: [] }),
	'empty streaming assistant entry shows the cursor placeholder',
);

assert(
	!shouldRenderStreamingCursor({ isStreaming: true, content: [{ type: 'text', text: 'Hello' }] }),
	'streaming assistant text replaces the cursor placeholder',
);

assert(
	!shouldRenderStreamingCursor({ isStreaming: true, content: [{ type: 'thinking', thinking: 'Thinking' }] }),
	'streaming thinking replaces the cursor placeholder',
);

assert(
	!shouldRenderStreamingCursor({
		isStreaming: true,
		content: [{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: {} }],
	}),
	'streaming tool activity replaces the cursor placeholder',
);

assert(
	shouldRenderStreamingCursor({
		isStreaming: true,
		content: [{ type: 'text', text: '<session_context>hidden</session_context>' }],
	}),
	'session-context-only text still shows the cursor placeholder',
);

assert(
	!shouldRenderStreamingCursor({ isStreaming: false, content: [] }),
	'settled empty assistant entry does not show the cursor placeholder',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
