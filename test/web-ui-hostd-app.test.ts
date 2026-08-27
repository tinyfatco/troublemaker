import assert from 'node:assert/strict';
import test from 'node:test';
import { hostdAppConsoleUrl, isHostdAppMode } from '../ui/src/console-api.ts';

test('detects only the authenticated Hostd app UI route', () => {
  assert.equal(isHostdAppMode('/api/troublemaker/ui'), true);
  assert.equal(isHostdAppMode('/api/troublemaker/ui/'), true);
  assert.equal(isHostdAppMode('/api/troublemaker/ui/assets/index-example.js'), true);
  assert.equal(isHostdAppMode('/agents/00000000-0000-4000-8000-000000000001/'), false);
});

test('maps the portable console contract onto the same-origin Hostd proxy', () => {
  const page = 'https://tinyfat.example/api/troublemaker/ui/?project=example-site';
  assert.equal(
    hostdAppConsoleUrl('/status', page),
    '/api/troublemaker/status?project=example-site',
  );
  assert.equal(
    hostdAppConsoleUrl('/events?limit=50&before=120', page),
    '/api/troublemaker/events?limit=50&before=120&project=example-site',
  );
  assert.equal(
    hostdAppConsoleUrl('/events/stream', page),
    '/api/troublemaker/events/stream?project=example-site',
  );
  assert.equal(
    hostdAppConsoleUrl('/messages', page),
    '/api/troublemaker/messages?project=example-site',
  );
  assert.throws(
    () => hostdAppConsoleUrl('/configure', page),
    /Unsupported Hostd app console endpoint/,
  );
});

test('does not forward an invalid project scope from the browser URL', () => {
  assert.equal(
    hostdAppConsoleUrl('/live?after=10', 'https://tinyfat.example/api/troublemaker/ui/?project=../other'),
    '/api/troublemaker/live?after=10',
  );
});
