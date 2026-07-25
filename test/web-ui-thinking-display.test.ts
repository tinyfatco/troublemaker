import { getThinkingPreview } from '../ui/src/thinkingDisplay.ts';

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

const mediumThinking = 'I am checking the current workspace state and comparing it against the recent issue list before making a small UI change.';
const mediumPreview = getThinkingPreview(mediumThinking);
assert(!mediumPreview.isTruncated, 'medium thinking text is not aggressively truncated');
assert(mediumPreview.text === mediumThinking, 'medium thinking text stays intact');

const longThinking = Array.from({ length: 20 }, (_, i) => `line ${i + 1}: considering a detailed part of the plan`).join('\n');
const longPreview = getThinkingPreview(longThinking);
assert(longPreview.isTruncated, 'very long thinking text still gets a collapsed preview');
assert(!longPreview.text.endsWith('...'), 'collapsed thinking preview does not append ellipsis');
assert(longPreview.text.split('\n').length <= 8, 'collapsed thinking preview respects the line budget');

const wordyThinking = 'word '.repeat(180).trim();
const wordyPreview = getThinkingPreview(wordyThinking);
assert(wordyPreview.isTruncated, 'single-line overlong thinking text gets a preview');
assert(wordyPreview.text.length <= 600, 'single-line preview respects the character budget');
assert(!wordyPreview.text.endsWith('...'), 'single-line preview does not append ellipsis');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
