import { shouldSendAsSteering } from '../ui/src/webChatRouting.ts';

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

assert(!shouldSendAsSteering('hello', false), 'idle normal message uses normal send path');
assert(shouldSendAsSteering('hello', true), 'active normal message uses steering path');
assert(!shouldSendAsSteering('/model', true), 'active slash command still uses normal send path');
assert(!shouldSendAsSteering('  /model  ', true), 'trimmed slash command still uses normal send path');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
