import {
  getSlashCommand,
  isKnownSlashCommand,
  isSettingsCommand,
  isVoiceCommand,
  matchSlashCommands,
  parseSlashCommand,
} from '../ui/src/slashCommands.ts';

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

assert(parseSlashCommand('/settings') === '/settings', 'parses /settings');
assert(parseSlashCommand('  /model minimax') === '/model', 'parses slash command with args');
assert(parseSlashCommand('hello /settings') === null, 'ignores non-leading slash');
assert(isKnownSlashCommand('/settings'), '/settings is a known UI command');
assert(isKnownSlashCommand('/model minimax'), '/model with args is known');
assert(isKnownSlashCommand('/voice cedar'), '/voice with args is known');
assert(!isKnownSlashCommand('/verbose'), '/verbose stays removed');
assert(!isKnownSlashCommand('/made-up'), 'unknown slash command is invalid');
assert(isSettingsCommand('/settings'), 'exact /settings opens settings');
assert(!isSettingsCommand('/settings now'), '/settings with args does not open settings');
assert(isVoiceCommand('/voice'), 'exact /voice opens voice settings');
assert(!isVoiceCommand('/voice cedar'), '/voice with args stays an agent slash command');
assert(getSlashCommand('/voice')?.insertText === undefined, '/voice menu opens the local voice panel');
assert(matchSlashCommands('/se').some((item) => item.command === '/settings'), 'slash menu matches /settings');
assert(matchSlashCommands('/vo').some((item) => item.command === '/voice'), 'slash menu matches /voice');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
