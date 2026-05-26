import { readFileSync } from 'fs';
import { parseOperatorControlEvent } from '../ui/src/operatorControlEvents.ts';

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

const changed = parseOperatorControlEvent({
	channel: 'operator:control',
	userName: 'operator',
	text: '[operator configured thinking_level = "minimal"] (previously "off")',
});

assert(changed?.kind === 'configured', 'operator configured entries are parsed as control events');
assert(changed?.kind === 'configured' && changed.target === 'thinking_level', 'configured target is extracted');
assert(changed?.kind === 'configured' && changed.value === 'minimal', 'configured value is cleaned for display');
assert(changed?.kind === 'configured' && changed.previousValue === 'off', 'previous value is cleaned for display');
assert(changed?.kind === 'configured' && !changed.isNoop, 'real changes are not treated as no-op events');

const noop = parseOperatorControlEvent({
	channel: 'operator:control',
	userName: 'operator',
	text: '[operator configured thinking_level = "minimal"] (previously "minimal")',
});

assert(noop?.kind === 'configured' && noop.isNoop, 'same-value operator configure entries can be hidden');

const nonOperator = parseOperatorControlEvent({
	channel: 'web',
	userName: 'operator',
	text: '[operator configured thinking_level = "minimal"] (previously "off")',
});

assert(nonOperator === null, 'operator-looking text outside operator control is left alone');

const awarenessEntry = readFileSync('ui/src/components/AwarenessEntry.tsx', 'utf-8');
const settingsMenu = readFileSync('ui/src/components/SettingsMenu.tsx', 'utf-8');
const operatorAdapter = readFileSync('src/adapters/operator.ts', 'utf-8');

assert(awarenessEntry.includes('OperatorControlEntry'), 'awareness renderer has a dedicated operator control component');
assert(awarenessEntry.includes('operatorEvent.isNoop'), 'awareness renderer suppresses no-op configure audit rows');
assert(settingsMenu.includes('isCurrentSetting(snapshot, target, value)'), 'settings menu skips already-current writes');
assert(operatorAdapter.includes('writeConfiguredAwareness'), 'operator configure path suppresses no-op awareness writes centrally');
assert(operatorAdapter.includes('changed,'), 'operator configure responses expose whether a visible change happened');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
