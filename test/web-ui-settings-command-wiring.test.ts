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
const consoleApi = readFileSync('ui/src/console-api.ts', 'utf-8');
const settingsMenu = readFileSync('ui/src/components/SettingsMenu.tsx', 'utf-8');

for (const [name, source] of [['AwarenessPane', awarenessPane], ['ChatPane', chatPane]] as const) {
  assert(source.includes('SettingsMenu'), `${name} renders the settings menu`);
  assert(source.includes('onSlashCommand={handleSlashCommand}'), `${name} wires slash command handling into InputBar`);
  assert(source.includes('onInvalidSlashCommand='), `${name} wires invalid slash feedback`);
}

assert(consoleApi.includes('OPERATOR_FETCH_TIMEOUT_MS = 75000'), 'settings calls allow full container boot retry window');
assert(consoleApi.includes("credentials: 'same-origin'"), 'console API requests include same-origin credentials');
assert(settingsMenu.includes('Settings unavailable.'), 'settings menu does not expose inert controls after load failure');
assert(settingsMenu.includes('getModelSuggestions'), 'settings menu autocompletes model names');
assert(settingsMenu.includes('role="combobox"'), 'model input exposes combobox semantics');
assert(consoleApi.includes('models?: AgentModelOption[]'), 'settings snapshot includes available models');
assert(settingsMenu.includes('applyLocalSetting'), 'settings writes resolve from the successful write without waiting on a full refresh');
assert(!settingsMenu.includes('await refresh()'), 'settings writes do not block controls on a post-save describe request');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
