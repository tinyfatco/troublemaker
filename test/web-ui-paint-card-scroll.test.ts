import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
for (const [key, value] of Object.entries({
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
})) {
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// The component under test resolves React from ui/, so the renderer must too.
const React = await import('../ui/node_modules/react/index.js');
const { createRoot } = await import('../ui/node_modules/react-dom/client.js');
const { ChatImage } = await import('../ui/src/components/ChatImage.tsx');
const { liveFollowBehavior, nextPinnedToBottom, shouldFollowExpandingContent } = await import('../ui/src/toolExpansion.ts');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const act = (React as any).act as (fn: () => unknown) => Promise<void>;

async function renderPaintImage(result: string | null) {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	const calls = { settled: 0, missing: 0 };
	let resolve!: (value: string | null) => void;
	const pending = new Promise<string | null>((r) => { resolve = r; });
	await act(async () => {
		root.render(React.createElement(ChatImage, {
			source: { kind: 'paint', id: 'img-1' },
			alt: 'Painted canvas',
			caption: '',
			onSettled: () => { calls.settled++; },
			onMissing: () => { calls.missing++; },
			loader: () => pending,
		}));
	});
	assert.equal(calls.settled, 0, 'nothing settles while the image is still loading');
	await act(async () => { resolve(result); await pending; });
	return { container, root, calls };
}

test('a Paint card image that decodes settles exactly once', async () => {
	const { container, root, calls } = await renderPaintImage(PNG);
	const img = container.querySelector('img');
	assert.ok(img, 'image rendered once ready');
	assert.equal(calls.settled, 0, 'fetched but not yet decoded: layout has not grown yet');
	await act(async () => { img!.dispatchEvent(new dom.window.Event('load')); });
	assert.equal(calls.settled, 1, 'decode settles the layout');
	await act(async () => {
		img!.dispatchEvent(new dom.window.Event('load'));
		img!.dispatchEvent(new dom.window.Event('error'));
	});
	assert.equal(calls.settled, 1, 'repeat load/error events do not re-settle');
	assert.equal(calls.missing, 0);
	await act(async () => root.unmount());
});

test('a missing Paint card image settles exactly once and is dropped', async () => {
	const { container, root, calls } = await renderPaintImage(null);
	assert.equal(calls.missing, 1, 'card is told to drop its image area');
	assert.equal(calls.settled, 1, 'dropping the image also settles the layout');
	assert.equal(container.querySelector('img'), null);
	await act(async () => root.unmount());
});

test('settlement re-follows the bottom only for a pinned reader', () => {
	const live = { backlogDone: true, isLoadingMore: false };
	assert.equal(shouldFollowExpandingContent({ ...live, pinnedToBottom: true, nearBottom: false }), true, 'pinned reader follows even after the image pushed the bottom away');
	assert.equal(shouldFollowExpandingContent({ ...live, pinnedToBottom: false, nearBottom: true }), true, 'reader already at the bottom follows');
	assert.equal(shouldFollowExpandingContent({ ...live, pinnedToBottom: false, nearBottom: false }), false, 'reader who scrolled up is not moved');
	assert.equal(shouldFollowExpandingContent({ backlogDone: false, isLoadingMore: false, pinnedToBottom: true, nearBottom: true }), false, 'not before the backlog loads');
	assert.equal(shouldFollowExpandingContent({ backlogDone: true, isLoadingMore: true, pinnedToBottom: true, nearBottom: true }), false, 'not while older history is prepending');
});

test('a manual scroll-up before the image settles is not overridden', () => {
	let pinned = true;
	pinned = nextPinnedToBottom(pinned, /* scrollingUp */ true, /* atBottom */ false);
	assert.equal(pinned, false, 'scrolling up off the bottom unpins');
	assert.equal(shouldFollowExpandingContent({ backlogDone: true, isLoadingMore: false, pinnedToBottom: pinned, nearBottom: false }), false, 'image settling afterwards leaves the reader in place');
	pinned = nextPinnedToBottom(pinned, false, false);
	assert.equal(pinned, false, 'drifting mid-history stays unpinned');
	pinned = nextPinnedToBottom(pinned, false, true);
	assert.equal(pinned, true, 'returning to the bottom re-pins');
});

test('only a newly arrived entry or live stream snaps instantly', () => {
	assert.equal(liveFollowBehavior(false, true), 'instant', 'a just-sent card snaps');
	assert.equal(liveFollowBehavior(true, false), 'instant', 'streaming growth snaps');
	assert.equal(liveFollowBehavior(false, false), 'smooth', 'a settled update on the same entry stays smooth');
});
