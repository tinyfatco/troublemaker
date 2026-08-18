import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderSafeMarkdown } from '../ui/src/safeMarkdown.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const html = renderSafeMarkdown(`
# Safe heading

<script>globalThis.pwned = true</script>
<img src=x onerror="globalThis.pwned = true" style="position:fixed">
<iframe src="https://attacker.example"></iframe>
<form action="https://attacker.example"><input name="secret"></form>
[unsafe](javascript:alert(1))
`, dom.window as any);
const safeLink = renderSafeMarkdown('[safe](https://tinyfat.com/)', dom.window as any);

assert.match(html, /<h1>Safe heading<\/h1>/);
assert.match(safeLink, /href="https:\/\/tinyfat\.com\/"/);
assert.doesNotMatch(html, /<script|<img|onerror\s*=|href="javascript:|style=|<iframe|<form|<input/i);

console.log('markdown xss sanitization ok');
