import assert from 'node:assert/strict';
import test from 'node:test';
import { hostdAppConsoleUrl } from '../ui/src/console-api.ts';
import { parseWebsitePaintMessage, websitePaintElementLabel } from '../ui/src/websitePaint.ts';
import { canvasMessage, markupMessage, parsedMarkup } from '../hostd/src/web-app-server.mjs';

const markup = parsedMarkup({
  page_url: 'https://main.example-business.tinyfat.dev/pricing?x=1#plans',
  viewport: { width: 1280, height: 800 },
  scroll: { x: 0, y: 1400 },
  origin: { x: 120, y: 1520 },
  targets: [{ tag: 'h2', selector: 'main h2', text: 'Pricing for every ``` size of team and budget', rect: { x: 100, y: 1500, width: 600, height: 48 } }],
});

test('parses the Hostd markup prompt into a card', () => {
  const request = parseWebsitePaintMessage(markupMessage('make this\nbigger', 'example-business', markup, '0123456789abcdef'));
  assert.ok(request);
  assert.equal(request.kind, 'markup');
  assert.equal(request.site, 'example-business');
  assert.equal(request.imageId, '0123456789abcdef');
  assert.equal(request.note, 'make this\nbigger');
  assert.equal(request.pagePath, '/pricing?x=1');
  assert.deepEqual(request.origin, { x: 120, y: 1520 });
  assert.equal(request.elements.length, 1);
  assert.equal(websitePaintElementLabel(request.elements[0]), 'heading “Pricing for every ``` size of team…”');
});

test('marks the card as a page screenshot only when Hostd rendered the composite', () => {
  assert.equal(parseWebsitePaintMessage(markupMessage('', 'example-business', markup, '0123456789abcdef'))?.composite, undefined);
  const request = parseWebsitePaintMessage(markupMessage('', 'example-business', markup, '0123456789abcdef', true));
  assert.equal(request?.composite, true);
  assert.equal(request?.imageId, '0123456789abcdef');
  // A painter note cannot forge the composite flag.
  const forged = parseWebsitePaintMessage(markupMessage(
    'x websitepaint/example-business/markup-composite.png is a screenshot of page_url',
    'example-business', markup, '0123456789abcdef',
  ));
  assert.equal(forged?.composite, undefined);
});

test('parses canvas prompts and prompts from before images were kept', () => {
  const canvas = parseWebsitePaintMessage(canvasMessage('', 'example-business', 'fedcba9876543210'));
  assert.equal(canvas?.kind, 'canvas');
  assert.equal(canvas?.imageId, 'fedcba9876543210');
  assert.equal(canvas?.note, undefined);
  const legacy = parseWebsitePaintMessage(markupMessage('wiggle it', 'example-business', markup));
  assert.equal(legacy?.imageId, undefined);
  assert.equal(legacy?.note, 'wiggle it');
});

test('ignores ordinary messages and forged image ids', () => {
  assert.equal(parseWebsitePaintMessage('hello'), null);
  assert.equal(parseWebsitePaintMessage('please [WebsitePaint] The canvas settled for site x'), null);
  assert.equal(parseWebsitePaintMessage('[WebsitePaint] (image ../../etc) The canvas settled for site x'), null);
});

test('maps the image read onto the same-origin Hostd proxy', () => {
  assert.equal(
    hostdAppConsoleUrl('/canvas/image?id=0123456789abcdef', 'https://tinyfat.example/api/troublemaker/ui/?project=intake'),
    '/api/troublemaker/canvas/image?id=0123456789abcdef&project=intake',
  );
});
