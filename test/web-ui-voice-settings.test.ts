import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_REALTIME_VOICE,
  REALTIME_VOICE_OPTIONS,
  normalizeRealtimeVoice,
} from '../ui/src/console-api.ts';

const voiceMenu = readFileSync('ui/src/components/VoiceSettingsMenu.tsx', 'utf-8');
const consoleApi = readFileSync('ui/src/console-api.ts', 'utf-8');
const slashCommands = readFileSync('ui/src/slashCommands.ts', 'utf-8');
const inputBar = readFileSync('ui/src/components/InputBar.tsx', 'utf-8');

assert.equal(DEFAULT_REALTIME_VOICE, 'marin', 'marin is the default Realtime voice');
assert.equal(REALTIME_VOICE_OPTIONS.length, 10, 'UI exposes the supported Realtime voice set');
for (const voice of REALTIME_VOICE_OPTIONS) {
  assert.equal(normalizeRealtimeVoice(voice.name), voice.name, voice.name + ' normalizes');
  assert.match(voice.description, /\S+/, voice.name + ' has a description');
}

assert.match(consoleApi, /\/realtime\/voice'\)/, 'console API reads voice settings through Crawdad');
assert.match(consoleApi, /method:\s*'PUT'/, 'console API saves voice settings through Crawdad');
assert.match(consoleApi, /\/realtime\/voice-preview'/, 'console API brokers voice preview audio');
assert(voiceMenu.includes('aria-label={previewing ?'), 'preview buttons are accessible');
assert.match(voiceMenu, /Selected/, 'voice menu marks the selected voice');
assert.match(slashCommands, /isVoiceCommand/, 'slash command helper identifies local /voice');
assert.match(inputBar, /command === '\/settings' \|\| command === '\/voice'/, 'slash picker opens /voice locally');

console.log('web voice settings wiring ok');
