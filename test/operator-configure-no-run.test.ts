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

const source = readFileSync('src/adapters/operator.ts', 'utf-8');

function methodBody(name: string): string {
  const start = source.search(new RegExp(`private\\s+(?:async\\s+)?${name}\\(`));
  assert(start >= 0, `${name} exists`);
  if (start < 0) return '';
  const next = source.indexOf('\n\tprivate ', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

for (const name of [
  'configureSimpleSetting',
  'configureModel',
  'configureThinkingLevel',
  'configureRealtimeVoice',
  'configureVerbose',
  'configureSpontaneity',
  'configureHeartbeatChecklist',
]) {
  assert(!methodBody(name).includes('this.triggerRun('), `${name} acknowledges without triggering an agent run`);
}

assert(methodBody('handleMessage').includes('this.triggerRun('), 'operator messages still trigger runs');
assert(methodBody('handleAssign').includes('this.triggerRun('), 'operator assignments still trigger runs');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
