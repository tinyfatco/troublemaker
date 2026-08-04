import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	applyRuntimeSteeringEnvelope,
	mergeAwarenessEntries,
	parseRuntimeSteeringEnvelope,
} from '../ui/src/steeringProjection.js';
import { parseContextLine } from '../ui/src/types.js';

const acceptedPayload = JSON.stringify({
	kind: 'runtime',
	sequence: 10,
	streamId: 'stream-example',
	runId: 'run-example',
	event: {
		type: 'steering_input',
		id: 'steering-example',
		state: 'accepted',
		deliveryMode: 'steered',
		acceptedAt: '2026-08-04T12:00:01.000Z',
		entries: [{ channel: 'slack:#example', userName: 'Casey', text: 'use the accepted update' }],
	},
});
const accepted = parseRuntimeSteeringEnvelope(acceptedPayload);
assert(accepted, 'accepted runtime steering envelope parses');

const projected = applyRuntimeSteeringEnvelope([], accepted);
assert.equal(projected.length, 1, 'accepted steering appears immediately');
assert.equal(projected[0]?.steeringProjection?.state, 'accepted', 'accepted steering carries its visible queued state');
assert.equal(projected[0]?.strippedText, 'use the accepted update');

const duplicate = applyRuntimeSteeringEnvelope(projected, accepted);
assert.equal(duplicate.length, 1, 'duplicate live delivery does not add another projection');

const refreshed = applyRuntimeSteeringEnvelope([], accepted);
assert.equal(refreshed.length, 1, 'active replay restores steering after refresh');

const consumed = parseRuntimeSteeringEnvelope(JSON.stringify({
	...JSON.parse(acceptedPayload),
	sequence: 11,
	event: { ...JSON.parse(acceptedPayload).event, state: 'consumed' },
}));
assert(consumed, 'consumed runtime steering envelope parses');
const consumedEntries = applyRuntimeSteeringEnvelope(projected, consumed);
assert.equal(consumedEntries[0]?.steeringProjection?.state, 'consumed', 'consumption removes the queued marker');

const durable = parseContextLine(JSON.stringify({
	type: 'message',
	id: 'durable-example',
	timestamp: '2026-08-04T12:00:02.000Z',
	message: {
		role: 'user',
		content: [{
			type: 'text',
			text: '[2026-08-04 12:00:00+00:00] [slack:#example] [Casey]: use the accepted update',
		}],
	},
}));
assert(durable, 'canonical durable user input parses');
const reconciled = mergeAwarenessEntries(consumedEntries, [durable]);
assert.deepEqual(reconciled.map((entry) => entry.id), ['durable-example'], 'durable input replaces its consumed projection without a second user turn');

const durableFirst = mergeAwarenessEntries(projected, [durable]);
assert.equal(durableFirst.length, 2, 'canonical awareness can win the race while steering is still accepted');
const raceReconciled = applyRuntimeSteeringEnvelope(durableFirst, consumed);
assert.deepEqual(
	raceReconciled.map((entry) => entry.id),
	['durable-example'],
	'consumption removes the projection when canonical awareness arrived on the other SSE stream first',
);

const consumedBeforeSeenRefresh = [...consumedEntries, durable];
const repeatedDurableReconciliation = mergeAwarenessEntries(consumedBeforeSeenRefresh, [durable]);
assert.deepEqual(
	repeatedDurableReconciliation.map((entry) => entry.id),
	['durable-example'],
	'an already-seen durable backlog row still reconciles a consumed projection',
);

const oldDurable = { ...durable, id: 'durable-old', timestamp: '2026-08-04T11:00:00.000Z' };
const staleDuplicate = applyRuntimeSteeringEnvelope([...projected, oldDurable], consumed);
assert.deepEqual(
	staleDuplicate.map((entry) => entry.id),
	['steering-steering-example-0', 'durable-old'],
	'an old identical canonical message cannot consume a newly accepted projection',
);
assert.equal(staleDuplicate[0]?.steeringProjection?.state, 'consumed');

const acceptedTwoPayload = JSON.parse(acceptedPayload);
acceptedTwoPayload.event.id = 'steering-example-two';
acceptedTwoPayload.event.entries = [{ channel: 'slack:#example', userName: 'Jordan', text: 'second accepted update' }];
const acceptedTwo = parseRuntimeSteeringEnvelope(JSON.stringify(acceptedTwoPayload));
assert(acceptedTwo);
const consumedTwo = parseRuntimeSteeringEnvelope(JSON.stringify({
	...acceptedTwoPayload,
	event: { ...acceptedTwoPayload.event, state: 'consumed' },
}));
assert(consumedTwo);
let batchedProjections = applyRuntimeSteeringEnvelope([], accepted);
batchedProjections = applyRuntimeSteeringEnvelope(batchedProjections, acceptedTwo);
batchedProjections = applyRuntimeSteeringEnvelope(batchedProjections, consumed);
batchedProjections = applyRuntimeSteeringEnvelope(batchedProjections, consumedTwo);
const durableBatch = parseContextLine(JSON.stringify({
	type: 'message',
	id: 'durable-batch',
	timestamp: '2026-08-04T12:00:03.000Z',
	message: {
		role: 'user',
		content: [{
			type: 'text',
			text: '[2026-08-04 12:00:03+00:00] [slack:#example] [system]: Recent messages:\n[2026-08-04 12:00:00+00:00] [slack:#example] [Casey]: use the accepted update\n[2026-08-04 12:00:01+00:00] [slack:#example] [Jordan]: second accepted update',
		}],
	},
}));
assert(durableBatch);
const reconciledBatch = mergeAwarenessEntries(batchedProjections, [durableBatch]);
assert.deepEqual(
	reconciledBatch.map((entry) => entry.id),
	['durable-batch'],
	'one canonical Pi batch replaces every consumed projection without duplicate turns',
);

const dismissed = parseRuntimeSteeringEnvelope(JSON.stringify({
	...JSON.parse(acceptedPayload),
	sequence: 12,
	event: { ...JSON.parse(acceptedPayload).event, state: 'dismissed' },
}));
assert(dismissed, 'dismissed runtime steering envelope parses');
assert.equal(applyRuntimeSteeringEnvelope(projected, dismissed).length, 0, 'failed-to-consume projection is withdrawn');

assert.equal(
	parseRuntimeSteeringEnvelope(JSON.stringify({
		kind: 'runtime',
		event: { ...JSON.parse(acceptedPayload).event, state: 'rejected' },
	})),
	null,
	'rejected input cannot be parsed as an accepted projection',
);

const awarenessHook = readFileSync('ui/src/hooks/useAwarenessStream.ts', 'utf8');
assert.match(awarenessHook, /new EventSource\(awarenessStreamUrl\(\)\)/, 'existing durable awareness stream remains intact');
assert.match(awarenessHook, /new EventSource\(runtimeLiveStreamUrl\(\)\)/, 'web awareness subscribes to server-confirmed steering lifecycle');
assert.match(awarenessHook, /applyRuntimeSteeringEnvelope/, 'web awareness applies accepted and reconciled steering state');

console.log('web UI steering projection tests passed');
