import { getModelSuggestions } from '../ui/src/modelAutocomplete.ts';

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

const models = [
  { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT 5.5', api: 'openai-codex-responses' },
  { provider: 'fireworks', id: 'accounts/fireworks/models/minimax-m2p7', name: 'MiniMax M2.7', api: 'fireworks' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', api: 'anthropic' },
  { provider: 'fireworks', id: 'accounts/fireworks/models/glm-5p2', name: 'GLM 5.2', api: 'fireworks' },
  { provider: 'fireworks', id: 'accounts/fireworks/models/glm-5p1', name: 'GLM 5.1', api: 'fireworks' },
];

assert(getModelSuggestions(models, 'gpt')[0]?.value === 'openai-codex/gpt-5.5', 'matches OpenAI model prefixes');
assert(getModelSuggestions(models, 'gptfive')[0]?.value === 'openai-codex/gpt-5.5', 'matches friendly OpenAI aliases');
assert(getModelSuggestions(models, 'minimax')[0]?.value === 'fireworks/accounts/fireworks/models/minimax-m2p7', 'matches friendly Fireworks aliases');
assert(getModelSuggestions(models, 'sonnet')[0]?.value === 'anthropic/claude-sonnet-4-6', 'matches model names and aliases');
assert(getModelSuggestions(models, '', 'fireworks/accounts/fireworks/models/glm-5p2')[0]?.value === 'fireworks/accounts/fireworks/models/glm-5p2', 'current model sorts first for empty query');
assert(getModelSuggestions(models, 'not-a-model').length === 0, 'unknown model text yields no suggestions');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
