import assert from 'node:assert/strict';
import { createSteeringOffsetState, mergeOptimisticEntries } from '../ui/src/optimisticEntries.js';
import {
	applyRuntimeSteeringEnvelope,
	mergeAwarenessEntries,
	parseRuntimeSteeringEnvelope,
} from '../ui/src/steeringProjection.js';
import type { AwarenessEntry } from '../ui/src/types.js';

const startedAt = '2026-10-31T12:00:00.000Z';
const turnUser: AwarenessEntry = {
	id: 'turn-user', type: 'message', timestamp: startedAt, role: 'user',
	content: [{ type: 'text', text: 'inspect the build' }], strippedText: 'inspect the build',
};
const streaming: AwarenessEntry = {
	id: 'turn-assistant', type: 'message', timestamp: startedAt, role: 'assistant', isStreaming: true,
	content: [
		{ type: 'thinking', thinking: 'checking' },
		{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: {} },
	],
};
const optimisticUser = { ...turnUser, id: 'live-turn-user' };

const accepted = parseRuntimeSteeringEnvelope(JSON.stringify({
	kind: 'runtime',
	event: {
		type: 'steering_input', id: 'steer-1', state: 'accepted', deliveryMode: 'steered',
		acceptedAt: '2026-10-31T12:00:02.000Z',
		entries: [{ channel: 'web:web-app:intake', userName: 'web user', text: 'also check tests' }],
	},
}));
assert(accepted);

const offsets = createSteeringOffsetState();
let awareness = applyRuntimeSteeringEnvelope([turnUser], accepted);

function visible(entry: AwarenessEntry): AwarenessEntry[] {
	return mergeOptimisticEntries(awareness, optimisticUser, entry, [], offsets);
}

assert.deepEqual(
	visible(streaming).map((entry) => entry.id),
	['turn-user', 'turn-assistant-slice-0-2', 'steering-steer-1-0'],
	'accepted steering renders after the content already produced',
);

const continued: AwarenessEntry = {
	...streaming,
	content: [
		...(streaming.content || []),
		{ type: 'toolResult', toolCallId: 'tool-1', result: 'ok' },
		{ type: 'text', text: 'done' },
	],
};
assert.deepEqual(
	visible(continued).map((entry) => entry.id),
	['turn-user', 'turn-assistant-slice-0-2', 'steering-steer-1-0', 'turn-assistant-slice-2-4'],
	'new streamed content stays below the steering message',
);

const consumed = parseRuntimeSteeringEnvelope(JSON.stringify({
	kind: 'runtime', event: { ...accepted.event, state: 'consumed' },
}));
assert(consumed);
awareness = applyRuntimeSteeringEnvelope(awareness, consumed);
assert.deepEqual(
	visible(continued).map((entry) => entry.id),
	['turn-user', 'turn-assistant-slice-0-2', 'steering-steer-1-0', 'turn-assistant-slice-2-4'],
	'consumption does not remove or move the steering message',
);

const durableSteering: AwarenessEntry = {
	id: 'durable-steer', type: 'message', timestamp: '2026-10-31T12:00:03.000Z', role: 'user',
	channel: 'web', userName: 'user', strippedText: 'also check tests',
	content: [{ type: 'text', text: '[2026-10-31] [web] [user]: also check tests' }],
};
awareness = mergeAwarenessEntries(awareness, [durableSteering]);
const settled = { ...continued, isStreaming: false };
const durableAssistant: AwarenessEntry = {
	...settled, id: 'durable-assistant', timestamp: '2026-10-31T12:00:04.000Z',
};
awareness = mergeAwarenessEntries(awareness, [durableAssistant]);
const finalVisible = visible(settled);
assert.deepEqual(
	finalVisible.map((entry) => entry.id),
	['turn-user', 'turn-assistant-slice-0-2', 'durable-steer', 'turn-assistant-slice-2-4'],
	'durable rows replace live rows in place without a duplicate or reorder jump',
);
assert.equal(finalVisible.filter((entry) => entry.strippedText === 'also check tests').length, 1);
assert.equal(finalVisible.find((entry) => entry.strippedText === 'also check tests')?.channel, 'web');

// Earlier slices keep their own tool results and do not own the writing cursor.
{
	const parts = visible({ ...continued, isStreaming: true });
	const head = parts.find((entry) => entry.id === 'turn-assistant-slice-0-2');
	const tail = parts.find((entry) => entry.id === 'turn-assistant-slice-2-4');
	assert(head && tail);
	assert(head.content?.some((block) => block.type === 'toolResult' && block.toolCallId === 'tool-1'),
		'head slice sees the tool result that streamed after the steer');
	assert.equal(head.ownsStreamingCursor, false, 'head slice does not own the cursor');
	assert.notEqual(tail.ownsStreamingCursor, false, 'tail slice owns the cursor');
}

// Two mounted views: clearing/reconnecting one never moves or erases the other.
{
	const viewA = createSteeringOffsetState();
	const viewB = createSteeringOffsetState();
	const projected = applyRuntimeSteeringEnvelope([turnUser], accepted);
	const shortStream: AwarenessEntry = { ...streaming, content: streaming.content!.slice(0, 1) };

	const aBefore = mergeOptimisticEntries(projected, optimisticUser, streaming, [], viewA).map((e) => e.id);
	const bBefore = mergeOptimisticEntries(projected, optimisticUser, shortStream, [], viewB).map((e) => e.id);
	assert.equal(viewA.offsets.get('steer-1'), 2);
	assert.equal(viewB.offsets.get('steer-1'), 1);

	mergeOptimisticEntries(projected, null, null, [], viewA); // A's stream clears
	assert.equal(viewA.offsets.size, 0, 'cleared view drops its own offsets');
	assert.equal(viewB.offsets.get('steer-1'), 1, 'other view keeps its offset');
	assert.deepEqual(
		mergeOptimisticEntries(projected, optimisticUser, shortStream, [], viewB).map((e) => e.id),
		bBefore,
		'other view order unchanged after the first view clears',
	);
	assert.notDeepEqual(aBefore, bBefore, 'views position steering independently');
}

// Repeated turns: old durable rows (with replacesSteeringId) stay in entries,
// but the next turn resets the state so it only ever holds the active turn.
{
	const view = createSteeringOffsetState();
	let feed = applyRuntimeSteeringEnvelope([turnUser], accepted);
	mergeOptimisticEntries(feed, optimisticUser, streaming, [], view);
	feed = applyRuntimeSteeringEnvelope(feed, consumed);
	feed = mergeAwarenessEntries(feed, [durableSteering, { ...settled, id: 'durable-assistant' }]);
	assert(feed.some((entry) => entry.replacesSteeringId === 'steer-1'), 'old durable row keeps its replacement marker');

	const turn2User: AwarenessEntry = { ...turnUser, id: 'turn2-user', timestamp: '2026-10-31T12:05:00.000Z',
		strippedText: 'next thing', content: [{ type: 'text', text: 'next thing' }] };
	const turn2Stream: AwarenessEntry = { ...streaming, id: 'turn2-assistant', timestamp: '2026-10-31T12:05:00.000Z' };
	feed = [...feed, turn2User];
	const turn2 = mergeOptimisticEntries(feed, { ...turn2User, id: 'live-turn2-user' }, turn2Stream, [], view);
	assert.equal(view.turnId, 'turn2-assistant');
	assert.equal(view.offsets.size, 0, 'previous turn offsets are gone once a new turn streams');
	assert.deepEqual(turn2.slice(-2).map((entry) => entry.id), ['turn2-user', 'turn2-assistant'],
		'new turn renders whole with no leftover split');
}
console.log('web UI steering order tests passed');
