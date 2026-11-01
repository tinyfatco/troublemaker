import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

// Markdown sanitizes through DOMPurify, which needs a window.
(globalThis as { window?: unknown }).window = new JSDOM('').window;
const { AwarenessEntryComponent } = await import('../src/components/AwarenessEntry.tsx');
import { createElement } from 'react';
import { createSteeringOffsetState, mergeOptimisticEntries } from '../src/optimisticEntries.ts';
import { applyRuntimeSteeringEnvelope, parseRuntimeSteeringEnvelope } from '../src/steeringProjection.ts';
import type { AwarenessEntry } from '../src/types.ts';


const t0 = '2026-10-31T12:00:00.000Z';
const user: AwarenessEntry = { id: 'u', type: 'message', timestamp: t0, role: 'user',
	content: [{ type: 'text', text: 'inspect the build' }], strippedText: 'inspect the build' };
const accepted = parseRuntimeSteeringEnvelope(JSON.stringify({ kind: 'runtime', event: {
	type: 'steering_input', id: 's1', state: 'accepted', deliveryMode: 'steered', acceptedAt: '2026-10-31T12:00:02.000Z',
	entries: [{ channel: 'web', userName: 'user', text: 'also check tests' }] } }));
assert(accepted);

const before: AwarenessEntry = { id: 'a', type: 'message', timestamp: t0, role: 'assistant', isStreaming: true,
	content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { label: 'Run build' } }] };
const view = createSteeringOffsetState();
const feed = applyRuntimeSteeringEnvelope([user], accepted);
mergeOptimisticEntries(feed, { ...user, id: 'live-u' }, before, [], view); // steer accepted after 1 block

const after: AwarenessEntry = { ...before, content: [
	...before.content!,
	{ type: 'toolResult', toolCallId: 'tool-1', result: 'build ok' },
	{ type: 'text', text: 'Still working' },
] };
const parts = mergeOptimisticEntries(feed, { ...user, id: 'live-u' }, after, [], view);
const html = (entry: AwarenessEntry) => renderToStaticMarkup(createElement(AwarenessEntryComponent, { entry }));
const head = parts.find((e) => e.id === 'a-slice-0-1');
const tail = parts.find((e) => e.id === 'a-slice-1-3');
assert(head && tail, 'turn is split around the steering message');

const headHtml = html(head);
assert(headHtml.includes('tool-call-row') && !headHtml.includes('tool-call-row running'),
	'tool call before the steer resolves with its later result instead of spinning forever');
assert(!headHtml.includes('tool-spinner'), 'resolved tool shows no spinner');
assert(!headHtml.includes('waiting-spinner'), 'head slice renders no writing cursor/spinner');
assert(!/assistant-entry[^"]*streaming/.test(headHtml), 'head slice text is not marked streaming');

const tailHtml = html(tail);
assert(/assistant-entry[^"]*streaming/.test(tailHtml), 'tail slice owns the streaming text state');

// An unresolved tool before the steer still shows as running.
const pending = mergeOptimisticEntries(feed, { ...user, id: 'live-u' },
	{ ...before, content: [...before.content!, { type: 'text', text: 'thinking aloud' }] }, [], view);
const pendingHead = pending.find((e) => e.id === 'a-slice-0-1');
assert(pendingHead);
assert(html(pendingHead).includes('tool-call-row running'), 'unresolved tool before the steer still renders running');
console.log('web-ui-steering-render tests passed');
