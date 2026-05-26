import { getOptimisticVisibility, mergeOptimisticEntries } from '../ui/src/optimisticEntries.ts';
import { parseContextLine, type AwarenessEntry } from '../ui/src/types.ts';

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

function streamingTool(id: string, timestamp: string): AwarenessEntry {
	return {
		id,
		type: 'message',
		timestamp,
		role: 'assistant',
		content: [{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: { path: 'README.md' } }],
		isStreaming: true,
	};
}

function standaloneToolResult(id: string, timestamp: string, toolCallId = 'tool-1'): AwarenessEntry {
	return {
		id,
		type: 'message',
		timestamp,
		role: 'toolResult',
		content: [{ type: 'toolResult', toolCallId, result: 'ok' }],
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

const toolFirstUser = user('u-tool', '2026-05-18T00:01:11.000Z', 'check the repo');
const earlyDurableAssistant = assistant('a-tool-durable', '2026-05-18T00:01:12.000Z', '');
const toolStreamingEntry = streamingTool('live-tool-stream', '2026-05-18T00:01:11.000Z');
const visibleDuringToolFirstRun = getOptimisticVisibility(
	[toolFirstUser, earlyDurableAssistant],
	toolFirstUser,
	toolStreamingEntry,
);

assert(
	visibleDuringToolFirstRun.showStreamingEntry,
	'active tool-call streaming remains visible even if a durable assistant entry appears after the user',
);

const settledToolEntry = { ...toolStreamingEntry, isStreaming: false };
const visibleAfterToolRun = getOptimisticVisibility(
	[toolFirstUser, earlyDurableAssistant],
	toolFirstUser,
	settledToolEntry,
);

assert(
	!visibleAfterToolRun.showStreamingEntry,
	'settled tool-call optimistic entry is hidden once durable assistant content exists',
);

const durableToolAssistant = {
	...earlyDurableAssistant,
	content: [{ type: 'toolCall' as const, id: 'tool-1', name: 'read_file', arguments: { path: 'README.md' } }],
};
const visibleAfterDurableToolArrives = getOptimisticVisibility(
	[toolFirstUser, durableToolAssistant],
	toolFirstUser,
	toolStreamingEntry,
);

assert(
	!visibleAfterDurableToolArrives.showStreamingEntry,
	'active tool-call optimistic entry is hidden once durable awareness has the same tool call',
);

const durableDifferentToolAssistant = {
	...earlyDurableAssistant,
	content: [{ type: 'toolCall' as const, id: 'tool-2', name: 'bash', arguments: { command: 'pwd' } }],
};
const visibleWithDifferentDurableTool = getOptimisticVisibility(
	[toolFirstUser, durableDifferentToolAssistant],
	toolFirstUser,
	toolStreamingEntry,
);

assert(
	visibleWithDifferentDurableTool.showStreamingEntry,
	'active tool-call optimistic entry remains visible when durable awareness has a different tool call',
);

const visibleAfterStandaloneToolResult = getOptimisticVisibility(
	[toolFirstUser, earlyDurableAssistant, standaloneToolResult('tr-tool-1', '2026-05-18T00:01:13.000Z')],
	toolFirstUser,
	toolStreamingEntry,
);

assert(
	!visibleAfterStandaloneToolResult.showStreamingEntry,
	'active tool-call optimistic entry is hidden once durable tool result covers the same tool id',
);

const visibleAfterDifferentStandaloneToolResult = getOptimisticVisibility(
	[toolFirstUser, earlyDurableAssistant, standaloneToolResult('tr-tool-2', '2026-05-18T00:01:13.000Z', 'tool-2')],
	toolFirstUser,
	toolStreamingEntry,
);

assert(
	visibleAfterDifferentStandaloneToolResult.showStreamingEntry,
	'active tool-call optimistic entry remains visible when durable tool result belongs to a different tool id',
);

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

const durableWebUserWithDeliveryContext = parseContextLine(JSON.stringify({
	type: 'message',
	id: 'u-delivery-context',
	timestamp: '2026-05-26T04:32:53.000Z',
	message: {
		role: 'user',
		content: [{
			type: 'text',
			text: '<session_context>\nCurrent channel: web\n</session_context>\n\n<delivery_context>\nMessage type: dm\n</delivery_context>\n\n[2026-05-26 04:32:52+00:00] [web] [user]: Where specifically are you seeing that?',
		}],
	},
}));

assert(
	durableWebUserWithDeliveryContext?.strippedText === 'Where specifically are you seeing that?',
	'web UI strips model context blocks before parsing durable user text',
);

const optimisticWebUser = user(
	'live-u-web',
	'2026-05-26T04:32:52.000Z',
	'Where specifically are you seeing that?',
);
const mergedWithDeliveryContext = mergeOptimisticEntries(
	durableWebUserWithDeliveryContext ? [durableWebUserWithDeliveryContext] : [],
	optimisticWebUser,
	null,
);

assert(
	!mergedWithDeliveryContext.some((entry) => entry.id === optimisticWebUser.id),
	'delivery_context durable user entry hides matching optimistic web user entry',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
