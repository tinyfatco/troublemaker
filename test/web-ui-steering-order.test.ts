import assert from 'node:assert/strict';
import { mergeOptimisticEntries } from '../ui/src/optimisticEntries.js';
import {
	applyRuntimeSteeringEnvelope,
	mergeAwarenessEntries,
	parseRuntimeSteeringEnvelope,
	recordActiveStreamingContentBlockCount,
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

recordActiveStreamingContentBlockCount(streaming.content?.length || 0);
let awareness = applyRuntimeSteeringEnvelope([turnUser], accepted);

function visible(entry: AwarenessEntry): AwarenessEntry[] {
	return mergeOptimisticEntries(awareness, optimisticUser, entry);
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

console.log('web UI steering order tests passed');
