import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeChatImagePath, splitChatImages } from '../ui/src/chatImages.ts';
import { hostdAppConsoleUrl } from '../ui/src/console-api.ts';
import { isChatImagePath } from '../hostd/src/web-app-server.mjs';

test('splits workspace images out of assistant markdown', () => {
  assert.deepEqual(splitChatImages('Done!\n\n![After](websitepaint/site/after-0123456789abcdef.png)\n\nThe CTA now wiggles.'), [
    { type: 'markdown', text: 'Done!\n\n' },
    { type: 'image', path: 'websitepaint/site/after-0123456789abcdef.png', alt: 'After' },
    { type: 'markdown', text: '\n\nThe CTA now wiggles.' },
  ]);
  assert.deepEqual(splitChatImages('no images here'), [{ type: 'markdown', text: 'no images here' }]);
  assert.deepEqual(splitChatImages('![](./shots/a%20b.jpg "title")'), [{ type: 'image', path: 'shots/a b.jpg', alt: '' }]);
});

test('keeps code fences and non-workspace images as text', () => {
  const fenced = '```md\n![x](a.png)\n```\n';
  assert.deepEqual(splitChatImages(fenced), [{ type: 'markdown', text: fenced }]);
  assert.deepEqual(splitChatImages('see ![logo](https://evil.example/x.png)'), [
    { type: 'markdown', text: 'see [logo](https://evil.example/x.png)' },
  ]);
  for (const bad of ['/etc/x.png', '../x.png', '.ssh/k.png', 'a//b.png', 'x.svg', 'data:image/png;base64,AA']) {
    assert.equal(normalizeChatImagePath(bad), null, bad);
  }
});

test('the UI and Hostd agree on which paths are chat images', () => {
  for (const path of ['a.png', 'websitepaint/site/after.png', 'shots/a b (2).JPEG', '../a.png', '.a/b.png', 'a/.b.png', 'a.gif', 'a.txt']) {
    assert.equal(normalizeChatImagePath(path) === path, isChatImagePath(path), path);
  }
});

test('maps workspace image reads onto the same-origin Hostd proxy', () => {
  assert.equal(
    hostdAppConsoleUrl('/image?path=websitepaint%2Fsite%2Fafter.png', 'https://tinyfat.example/api/troublemaker/ui/?project=intake'),
    '/api/troublemaker/image?path=websitepaint%2Fsite%2Fafter.png&project=intake',
  );
});
