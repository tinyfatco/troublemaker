import { readFileSync } from 'fs';

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

const awarenessPane = readFileSync('ui/src/components/AwarenessPane.tsx', 'utf-8');
const chatPane = readFileSync('ui/src/components/ChatPane.tsx', 'utf-8');

for (const [name, source] of [['AwarenessPane', awarenessPane], ['ChatPane', chatPane]] as const) {
  assert(source.includes('SettingsMenu'), `${name} renders the settings menu`);
  assert(source.includes('onSlashCommand={handleSlashCommand}'), `${name} wires slash command handling into InputBar`);
  assert(source.includes('onInvalidSlashCommand='), `${name} wires invalid slash feedback`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
