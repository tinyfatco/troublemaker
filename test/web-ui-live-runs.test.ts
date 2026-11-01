import assert from 'node:assert/strict';
import test from 'node:test';
import {
	dropUnsettledLiveRuns,
	hasStreamingForeignRun,
	LIVE_RUN_SETTLE_TIMEOUT_MS,
	mergeLiveRuns,
	LIVE_RUN_MAX_SUCCESSOR_REFETCHES,
	nextLiveRunSettleAt,
	parseLiveRunEnvelope,
	pauseLiveRunSettleClocks,
	pruneSettledLiveRuns,
	reduceLiveRuns,
	resumeLiveRunSettleClocks,
	settleLiveRuns,
	type LiveRun,
} from '../ui/src/liveRuns.ts';
import { parseContextLine, type AwarenessEntry } from '../ui/src/types.ts';

const T0 = Date.parse('2026-11-01T03:30:00.000Z');
const NONE: ReadonlySet<string> = new Set();

function live(runId: string, source: string, event: Record<string, unknown>): string {
	return JSON.stringify({ kind: 'runtime', runId, channelId: 'c', channelLabel: `${source}:room`, source, sequence: 1, streamId: 's', id: 'e', timestamp: '2026-11-01T03:30:00.000Z', event });
}
function snapshot(text: string) {
	return { type: 'assistant_snapshot', entry: { id: 'live-assistant', type: 'message', role: 'assistant', timestamp: '2026-11-01T03:30:00.100Z', content: [{ type: 'text', text }], isStreaming: true } };
}
function complete(lastEntryId?: string) {
	return { type: 'run_complete', channelId: 'c', ...(lastEntryId ? { lastEntryId } : {}) };
}
function step(runs: LiveRun[], data: string, now = T0, durableCaughtUp = true): LiveRun[] {
	const envelope = parseLiveRunEnvelope(data);
	assert.ok(envelope, `parses ${data.slice(0, 60)}`);
	return reduceLiveRuns(runs, envelope, now, durableCaughtUp);
}
function durable(id: string, role: 'user' | 'assistant' | 'toolResult', text: string, runId?: string, at = '2026-11-01T03:30:02.000Z'): AwarenessEntry {
	return { id, type: 'message', role, timestamp: at, content: [{ type: 'text', text }], ...(runId ? { runId } : {}) };
}
const ids = (view: AwarenessEntry[]) => view.map((entry) => entry.id);
const textOf = (entry: AwarenessEntry) => (entry.content?.[0] as { text?: string } | undefined)?.text;

test('a foreign run streams as one growing transient entry', () => {
	let runs: LiveRun[] = [];
	runs = step(runs, live('r1', 'zulip', snapshot('Hel')));
	runs = step(runs, live('r1', 'zulip', snapshot('Hello th')));
	assert.equal(runs.length, 1);
	const view = mergeLiveRuns([durable('u1', 'user', 'hi')], runs, NONE);
	const tail = view.at(-1)!;
	assert.equal(tail.id, 'live-run:r1');
	assert.equal(tail.isStreaming, true);
	assert.equal(textOf(tail), 'Hello th');
	assert.equal(tail.channel, 'zulip:room');
	assert.equal(hasStreamingForeignRun(runs, NONE), true);
});

test('a live run hides only durable rows stamped with its own run id', () => {
	const runs = step([], live('r1', 'zulip', snapshot('cumulative')));
	const entries = [
		durable('old', 'assistant', 'earlier, untagged history', undefined, '2026-11-01T03:00:00.000Z'),
		durable('u1', 'user', 'question', 'r1'),
		durable('a1', 'assistant', 'r1 tool turn', 'r1'),
		durable('t1', 'toolResult', 'r1 result', 'r1'),
		durable('late', 'assistant', 'untagged row written after r1 started'),
	];
	const view = ids(mergeLiveRuns(entries, runs, NONE));
	assert.deepEqual(view, ['old', 'u1', 'late', 'live-run:r1'], 'own assistant/tool rows hidden; user, untagged and earlier rows kept');
});

test('overlapping runs never suppress each other\'s durable entries', () => {
	let runs = step([], live('r1', 'zulip', snapshot('zulip reply')));
	runs = step(runs, live('r2', 'slack', snapshot('slack reply')));
	// r2 finished first and its durable reply landed while r1 is still running.
	runs = step(runs, live('r2', 'slack', complete('b2')));
	const entries = [
		durable('b1', 'assistant', 'slack tool turn', 'r2', '2026-11-01T03:30:01.000Z'),
		durable('b2', 'assistant', 'slack final', 'r2', '2026-11-01T03:30:03.000Z'),
	];
	const view = mergeLiveRuns(entries, runs, NONE);
	assert.deepEqual(ids(view), ['b1', 'b2', 'live-run:r1'], 'r1 being live (and earlier) does not hide r2 rows; r2 durable replaced its snapshot');
});

test('own web send is recognized only by its exact announced run id', () => {
	let runs = step([], live('w-own', 'web', snapshot('mine')));
	runs = step(runs, live('w-paint', 'web', snapshot('paint reply')));
	runs = step(runs, live('w-tab2', 'web', snapshot('other tab')));
	const owned = new Set(['w-own']);
	const view = ids(mergeLiveRuns([], runs, owned));
	assert.deepEqual(view, ['live-run:w-paint', 'live-run:w-tab2'], 'concurrent Paint / other-tab web runs stay visible while this tab streams its own');
	assert.equal(hasStreamingForeignRun(runs, new Set(['w-own', 'w-paint', 'w-tab2'])), false);
});

test('without a handshake a web run fails open and renders', () => {
	const runs = step([], live('w-unknown', 'web', snapshot('visible')));
	assert.deepEqual(ids(mergeLiveRuns([], runs, NONE)), ['live-run:w-unknown']);
});

test('voice runs are left to the voice transcript', () => {
	assert.equal(step([], live('v1', 'web-voice', snapshot('spoken'))).length, 0);
});

test('completion before the durable write keeps the settled reply until its exact successor lands', () => {
	let runs = step([], live('r1', 'zulip', snapshot('Hello there')));
	runs = step(runs, live('r1', 'zulip', complete('a-final')), T0 + 1000);
	assert.equal(runs.length, 1, 'run_complete does not delete the transient entry');
	assert.equal(hasStreamingForeignRun(runs, NONE), false, 'no longer drives streaming follow');

	// The awareness file lags: only an earlier tool turn of r1 has landed.
	let entries = [durable('u1', 'user', 'hi'), durable('a-tool', 'assistant', 'tool turn', 'r1')];
	let view = mergeLiveRuns(entries, runs, NONE);
	const tail = view.at(-1)!;
	assert.equal(tail.id, 'live-run:r1', 'reply stays on screen between the streams');
	assert.equal(tail.isStreaming, false, 'settled: cursor stops');
	assert.equal(textOf(tail), 'Hello there');
	assert.ok(!ids(view).includes('a-tool'), 'no half-duplicate from the partial durable rows');

	// A late snapshot cannot reopen the settled run.
	runs = step(runs, live('r1', 'zulip', snapshot('stale')), T0 + 1100);
	assert.equal(textOf(mergeLiveRuns(entries, runs, NONE).at(-1)!), 'Hello there');

	// The exact successor lands: full durable rows take over, nothing transient remains.
	entries = [...entries, durable('a-final', 'assistant', 'Hello there (full durable details)', 'r1')];
	view = mergeLiveRuns(entries, runs, NONE);
	assert.deepEqual(ids(view), ['u1', 'a-tool', 'a-final']);
});

test('a settled reply with a known successor is never dropped for being slow; lapses refetch instead', () => {
	let runs = step([], live('done', 'zulip', snapshot('settled')));
	runs = step(runs, live('done', 'zulip', complete('a-final')), T0);
	runs = step(runs, live('running', 'slack', snapshot('in flight')));
	assert.equal(nextLiveRunSettleAt(runs), T0 + LIVE_RUN_SETTLE_TIMEOUT_MS);

	let settled = settleLiveRuns(runs, T0 + LIVE_RUN_SETTLE_TIMEOUT_MS - 1);
	assert.equal(settled.refetch, false);
	assert.equal(settled.runs, runs, 'nothing due yet');

	// Each lapse refetches durable history and keeps the reply, up to the budget.
	let now = T0;
	for (let lapse = 1; lapse <= LIVE_RUN_MAX_SUCCESSOR_REFETCHES; lapse++) {
		now += LIVE_RUN_SETTLE_TIMEOUT_MS;
		settled = settleLiveRuns(runs, now);
		assert.equal(settled.refetch, true, `lapse ${lapse} asks for a history refetch`);
		runs = settled.runs;
		assert.deepEqual(runs.map((r) => r.runId), ['done', 'running'], `lapse ${lapse} keeps the settled reply`);
	}
	assert.equal(nextLiveRunSettleAt(runs), null, 'refetch budget spent: no further timer, no polling');
	settled = settleLiveRuns(runs, now + 100 * LIVE_RUN_SETTLE_TIMEOUT_MS);
	assert.equal(settled.refetch, false);
	assert.deepEqual(ids(mergeLiveRuns([durable('u1', 'user', 'hi')], settled.runs, NONE)), ['u1', 'live-run:done', 'live-run:running'], 'a stalled awareness stream never reopens the gap');

	// Only the exact successor or a server reset releases it.
	assert.deepEqual(pruneSettledLiveRuns(settled.runs, [durable('other', 'assistant', 'unrelated', 'zzz')]).map((r) => r.runId), ['done', 'running'], 'an unrelated row does not count');
	assert.deepEqual(pruneSettledLiveRuns(settled.runs, [durable('a-final', 'assistant', 'full', 'done')]).map((r) => r.runId), ['running']);
	assert.deepEqual(reduceLiveRuns(settled.runs, { kind: 'reset' }), [], 'server reset invalidates it');
});

test('a completion with no durable successor expires after its settle window', () => {
	let runs = step(step([], live('x', 'zulip', snapshot('x'))), live('x', 'zulip', complete()), T0);
	assert.equal(settleLiveRuns(runs, T0 + LIVE_RUN_SETTLE_TIMEOUT_MS - 1).runs.length, 1);
	const settled = settleLiveRuns(runs, T0 + LIVE_RUN_SETTLE_TIMEOUT_MS);
	assert.equal(settled.runs.length, 0);
	assert.equal(settled.refetch, false, 'nothing durable to fetch');
	runs = step(step([], live('y', 'zulip', snapshot('y'))), live('y', 'zulip', snapshot('y')));
	assert.deepEqual(dropUnsettledLiveRuns(runs), [], 'disconnect drops in-flight runs (replayed on reconnect)');
	assert.equal(nextLiveRunSettleAt([]), null);
});

test('completion of an unknown run is ignored', () => {
	assert.deepEqual(step([], live('ghost', 'zulip', complete('z'))), []);
});

test('durable entries carry their run id from context.jsonl', () => {
	const line = JSON.stringify({ type: 'message', id: 'e1', parentId: null, timestamp: '2026-11-01T03:30:02.000Z', runId: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
	assert.equal(parseContextLine(line)?.runId, 'r1');
	const untagged = JSON.stringify({ type: 'message', id: 'e0', parentId: null, timestamp: '2026-11-01T03:30:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
	assert.equal(parseContextLine(untagged)?.runId, undefined);
});

const TIMEOUT = LIVE_RUN_SETTLE_TIMEOUT_MS;

test('reconnect before the durable reply arrives: settled reply survives, then the exact successor takes over', () => {
	const history = [durable('u1', 'user', 'hi'), durable('a-tool', 'assistant', 'tool turn', 'r1')];
	let runs = step([], live('r1', 'zulip', snapshot('Final answer')));
	runs = step(runs, live('r1', 'zulip', complete('a-final')), T0);

	// Both feeds drop before the durable reply is visible.
	runs = dropUnsettledLiveRuns(runs); // /live onerror
	runs = pauseLiveRunSettleClocks(runs); // awareness onerror
	assert.equal(nextLiveRunSettleAt(runs), null, 'no timer is scheduled while the successor is demonstrably pending');
	runs = settleLiveRuns(runs, T0 + 10 * TIMEOUT).runs;
	assert.deepEqual(ids(mergeLiveRuns(history, runs, NONE)), ['u1', 'live-run:r1'], 'a long outage cannot expire the settled reply');

	// /live reconnects first: replay carries only active runs, so nothing new; settled reply kept.
	runs = reduceLiveRuns(runs, parseLiveRunEnvelope(live('r9', 'slack', snapshot('other')))!, T0 + 11 * TIMEOUT, false);
	assert.ok(runs.some((run) => run.runId === 'r1'));

	// Awareness reconnects and its refetch is settled: the bounded window restarts from now.
	const reopenedAt = T0 + 12 * TIMEOUT;
	runs = resumeLiveRunSettleClocks(runs, reopenedAt);
	assert.equal(nextLiveRunSettleAt(runs), reopenedAt + TIMEOUT);
	assert.ok(settleLiveRuns(runs, reopenedAt + TIMEOUT).runs.some((run) => run.runId === 'r1'), 'a lapse after catch-up refetches, never drops');

	// The refetch delivers the successor: settled reply pruned, durable rows take over once.
	const refetched = [...history, durable('a-final', 'assistant', 'Final answer, full details', 'r1')];
	runs = pruneSettledLiveRuns(runs, refetched);
	assert.ok(!runs.some((run) => run.runId === 'r1'));
	assert.deepEqual(ids(mergeLiveRuns(refetched, runs, NONE)), ['u1', 'a-tool', 'a-final', 'live-run:r9']);
});

test('a run completing while the durable feed is down starts no clock until it catches up', () => {
	let runs = step([], live('r1', 'zulip', snapshot('x')));
	runs = step(runs, live('r1', 'zulip', complete('a-final')), T0, false);
	assert.equal(runs[0].settleClockAt, undefined);
	assert.equal(nextLiveRunSettleAt(runs), null);
	assert.equal(settleLiveRuns(runs, T0 + 10 * TIMEOUT).refetch, false, 'nothing fires while the feed is down');
	runs = resumeLiveRunSettleClocks(runs, T0 + 10 * TIMEOUT);
	const lapse = settleLiveRuns(runs, T0 + 11 * TIMEOUT);
	assert.equal(lapse.refetch, true, 'the first lapse after catch-up refetches durable history');
	assert.equal(lapse.runs.length, 1, 'and keeps the settled reply');
});

test('reconnect after the durable reply arrived: nothing resurfaces or duplicates', () => {
	let runs = step([], live('r1', 'zulip', snapshot('Final answer')));
	runs = step(runs, live('r1', 'zulip', complete('a-final')), T0);
	const history = [durable('u1', 'user', 'hi'), durable('a-final', 'assistant', 'Final answer, full details', 'r1')];
	runs = pruneSettledLiveRuns(runs, history);
	assert.deepEqual(runs, [], 'successor observed: run forgotten');

	// Both feeds drop and reconnect; /live replays only active runs (r1 is complete, so absent).
	runs = dropUnsettledLiveRuns(pauseLiveRunSettleClocks(runs));
	runs = resumeLiveRunSettleClocks(runs, T0 + TIMEOUT);
	assert.deepEqual(ids(mergeLiveRuns(history, runs, NONE)), ['u1', 'a-final'], 'exactly one durable copy');

	// Even if the durable row later leaves the loaded window, the transient reply cannot come back.
	assert.deepEqual(ids(mergeLiveRuns([durable('u1', 'user', 'hi')], runs, NONE)), ['u1']);
});

test('old untagged durable history is never altered by live runs', () => {
	const oldHistory = [
		durable('h1', 'user', 'old q', undefined, '2026-10-01T00:00:00.000Z'),
		durable('h2', 'assistant', 'old a', undefined, '2026-10-01T00:00:01.000Z'),
		durable('h3', 'toolResult', 'old t', undefined, '2026-10-01T00:00:02.000Z'),
	];
	let runs = step([], live('r1', 'zulip', snapshot('live')));
	runs = step(runs, live('r2', 'web', snapshot('other tab')));
	const view = mergeLiveRuns(oldHistory, runs, new Set(['r2']));
	assert.deepEqual(view.slice(0, 3), oldHistory, 'same rows, same order, same objects');
});
