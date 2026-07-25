import { readFileSync } from 'node:fs';

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

const awarenessEntry = readFileSync('ui/src/components/AwarenessEntry.tsx', 'utf-8');
const markdown = readFileSync('ui/src/components/Markdown.tsx', 'utf-8');
const css = readFileSync('ui/src/styles/index.css', 'utf-8');

assert(
	awarenessEntry.includes('<Markdown content={displayText} className="thinking-markdown" />'),
	'thinking block renders through the shared Markdown component',
);
assert(
	!awarenessEntry.includes('<span className="thinking-text">{displayText}</span>'),
	'thinking block no longer renders raw markdown source text',
);
assert(
	markdown.includes('className?: string') && markdown.includes("['markdown-content', className]"),
	'shared Markdown component accepts an extra style class',
);
assert(
	css.includes('.awareness-thinking .markdown-content p'),
	'thinking markdown shares paragraph spacing with assistant markdown',
);
assert(
	css.includes('.thinking-markdown strong') && css.includes('.thinking-markdown a'),
	'thinking markdown has polished inline emphasis and link styling',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
