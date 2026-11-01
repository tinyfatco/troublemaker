import { claimOwnWebRuns, mergeLiveRuns, parseLiveRunEnvelope, reduceLiveRuns, type LiveRun } from '../ui/src/liveRuns.ts';
import type { AwarenessEntry } from '../ui/src/types.ts';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
	if (condition) { passed++; console.log(`  ✓ ${msg}`); }
	else { failed++; console.error(`  ✗ ${msg}`); }
}

function live(runId: string, source: string, event: Record<string, unknown>, timestamp = '2026-11-01T03:30:00.000Z'): string {
	return JSON.stringify({ kind: 'runtime', runId, channelId: 'c', channelLabel: 'zulip:TinyFat crew', source, sequence: 1, streamId: 's', id: 'e', timestamp, event });
}
function snapshot(text: string) {
	return { type: 'assistant_snapshot', entry: { id: 'live-assistant', type: 'message', role: 'assistant', timestamp: '2026-11-01T03:30:00.100Z', content: [{ type: 'text', text }], isStreaming: true } };
}
function step(runs: LiveRun[], data: string): LiveRun[] {
	const envelope = parseLiveRunEnvelope(data);
	return envelope ? reduceLiveRuns(runs, envelope) : runs;
}
const userEntry: AwarenessEntry = { id: 'u1', type: 'message', role: 'user', timestamp: '2026-11-01T03:29:59.000Z', content: [{ type: 'text', text: 'hi' }], strippedText: 'hi' };
const durableReply: AwarenessEntry = { id: 'a1', type: 'message', role: 'assistant', timestamp: '2026-11-01T03:30:02.000Z', content: [{ type: 'text', text: 'Hello there' }] };
const olderReply: AwarenessEntry = { id: 'a0', type: 'message', role: 'assistant', timestamp: '2026-11-01T03:00:00.000Z', content: [{ type: 'text', text: 'earlier' }] };

console.log('Foreign-channel run streams into web chat');
let runs: LiveRun[] = [];
runs = step(runs, live('r1', 'zulip', snapshot('Hel')));
runs = step(runs, live('r1', 'zulip', snapshot('Hello th')));
assert(runs.length === 1, 'one live run per runId');
let view = mergeLiveRuns([olderReply, userEntry], runs, new Set());
const tail = view[view.length - 1];
assert(tail.id === 'live-run:r1' && tail.isStreaming === true, 'live entry is the streaming tail');
assert(tail.content?.[0]?.type === 'text' && (tail.content[0] as any).text === 'Hello th', 'text grows with each snapshot');
assert(tail.channel === 'zulip:TinyFat crew', 'live entry carries the channel label');

view = mergeLiveRuns([olderReply, userEntry, durableReply], runs, new Set());
assert(!view.some((e) => e.id === 'a1'), 'durable rows from the running turn are hidden while the cumulative snapshot shows');
assert(view.some((e) => e.id === 'a0') && view.some((e) => e.id === 'u1'), 'earlier rows and user rows stay visible');

runs = step(runs, live('r1', 'zulip', { type: 'run_complete', channelId: 'c' }));
assert(runs.length === 0, 'run_complete drops the live entry');
view = mergeLiveRuns([olderReply, userEntry, durableReply], runs, new Set());
assert(view[view.length - 1].id === 'a1', 'durable reply takes over after completion (no duplicate)');

console.log('Own web send is not double-streamed');
let own = new Set<string>();
runs = step([], live('w1', 'web', snapshot('mine')));
own = claimOwnWebRuns(runs, own, true);
view = mergeLiveRuns([userEntry], runs, own);
assert(!view.some((e) => e.id === 'live-run:w1'), 'web run seen during own POST stream is left to useWebChat');
own = claimOwnWebRuns(runs, own, false);
view = mergeLiveRuns([userEntry], runs, own);
assert(!view.some((e) => e.id === 'live-run:w1'), 'claim survives the own stream settling');

runs = step([], live('w2', 'web', snapshot('paint reply')));
own = claimOwnWebRuns(runs, new Set(), false);
assert(mergeLiveRuns([userEntry], runs, own).some((e) => e.id === 'live-run:w2'), 'web run started elsewhere (Paint / other tab) streams');

runs = step([], live('v1', 'web-voice', snapshot('spoken')));
assert(runs.length === 0, 'web-voice runs are rendered by voice chat, not here');

console.log('Robustness');
runs = step(step([], live('r2', 'slack', snapshot('x'))), JSON.stringify({ kind: 'reset', reason: 'replay_gap' }));
assert(runs.length === 0, 'reset clears live runs');
assert(parseLiveRunEnvelope('not json') === null, 'garbage ignored');
assert(parseLiveRunEnvelope(live('r3', 'zulip', { type: 'steering_input' })) === null, 'steering events are left to the steering projection');
const before: LiveRun[] = [];
assert(step(before, live('r4', 'zulip', { type: 'status', status: 'streaming' })) === before, 'status events do not churn state');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
