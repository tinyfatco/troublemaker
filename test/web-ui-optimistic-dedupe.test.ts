import { getOptimisticVisibility, mergeOptimisticEntries } from '../ui/src/optimisticEntries.ts';
import type { AwarenessEntry } from '../ui/src/types.ts';

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

function user(id: string, timestamp: string, text = '/model'): AwarenessEntry {
	return {
		id,
		type: 'message',
		timestamp,
		role: 'user',
		content: [{ type: 'text', text }],
		strippedText: text,
	};
}

function assistant(id: string, timestamp: string, text = '*Current model:* fireworks/minimax-m2p5'): AwarenessEntry {
	return {
		id,
		type: 'message',
		timestamp,
		role: 'assistant',
		content: [{ type: 'text', text }],
	};
}

function streaming(id: string, timestamp: string): AwarenessEntry {
	return {
		id,
		type: 'message',
		timestamp,
		role: 'assistant',
		content: [{ type: 'text', text: '*Current model:* fireworks/minimax-m2p5' }],
		isStreaming: true,
	};
}

const firstUser = user('u1', '2026-05-18T00:01:00.000Z');
const firstAssistant = assistant('a1', '2026-05-18T00:01:04.000Z');
const secondOptimisticUser = user('live-u2', '2026-05-18T00:01:07.000Z');
const secondStreaming = streaming('live-a2', '2026-05-18T00:01:07.000Z');

const visibleDuringRepeatedTurn = getOptimisticVisibility(
	[firstUser, firstAssistant, secondOptimisticUser],
	secondOptimisticUser,
	secondStreaming,
);

assert(!visibleDuringRepeatedTurn.showUserEntry, 'real repeated /model user entry hides the optimistic user entry');
assert(visibleDuringRepeatedTurn.showStreamingEntry, 'previous assistant response does not hide the new streaming entry');

const mergedDuringRepeatedTurn = mergeOptimisticEntries(
	[firstUser, firstAssistant, secondOptimisticUser],
	secondOptimisticUser,
	secondStreaming,
);
assert(
	mergedDuringRepeatedTurn.some((entry) => entry.id === secondStreaming.id),
	'repeated /model merge keeps the live streaming assistant entry visible',
);

const mergedWithLocalSlashHistory = mergeOptimisticEntries(
	[],
	secondOptimisticUser,
	secondStreaming,
	[firstUser, firstAssistant],
);
assert(
	mergedWithLocalSlashHistory.some((entry) => entry.id === firstAssistant.id),
	'completed local slash response remains visible when no durable awareness entry exists',
);
assert(
	mergedWithLocalSlashHistory.some((entry) => entry.id === secondStreaming.id),
	'new repeated slash response renders after completed local slash history',
);

const secondAssistant = assistant('a2', '2026-05-18T00:01:09.000Z');
const visibleAfterSecondResponse = getOptimisticVisibility(
	[firstUser, firstAssistant, secondOptimisticUser, secondAssistant],
	secondOptimisticUser,
	secondStreaming,
);

assert(!visibleAfterSecondResponse.showStreamingEntry, 'assistant response after the matched user hides the streaming entry');

const recentlyCompletedUser = user('u-recent', '2026-05-18T00:02:05.000Z');
const recentlyCompletedAssistant = assistant('a-recent', '2026-05-18T00:02:06.000Z');
const rapidRepeatUser = user('live-u-rapid', '2026-05-18T00:02:07.000Z');
const rapidRepeatStreaming = streaming('live-a-rapid', '2026-05-18T00:02:07.000Z');
const visibleDuringRapidRepeat = getOptimisticVisibility(
	[recentlyCompletedUser, recentlyCompletedAssistant],
	rapidRepeatUser,
	rapidRepeatStreaming,
);

assert(visibleDuringRapidRepeat.showUserEntry, 'recent identical previous user does not hide a new rapid-repeat user');
assert(visibleDuringRapidRepeat.showStreamingEntry, 'recent identical previous assistant does not hide a new rapid-repeat response');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
