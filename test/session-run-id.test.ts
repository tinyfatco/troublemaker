import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { stampRunId } from '../src/session-run-id.ts';

function persisted(file: string): Record<string, any>[] {
	return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('message entries persisted during a run carry its run id beside, not inside, the message', () => {
	const dir = mkdtempSync(join(tmpdir(), 'run-id-'));
	try {
		const file = join(dir, 'context.jsonl');
		let runId: string | null = null;
		const stamped: string[] = [];
		const sm = stampRunId(SessionManager.open(file, dir), () => runId, (entryId, id) => stamped.push(`${id}:${entryId}`));

		const before = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'outside a run' }], timestamp: 1 } as any);
		runId = 'run-a';
		const user = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 2 } as any);
		const reply = sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop', timestamp: 3 } as any);
		sm.appendThinkingLevelChange('low');
		runId = null;
		const after = sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'later' }], stopReason: 'stop', timestamp: 4 } as any);

		const byId = new Map(persisted(file).map((entry) => [entry.id, entry]));
		assert.equal(byId.get(before)?.runId, undefined, 'not stamped outside a run');
		assert.equal(byId.get(user)?.runId, 'run-a');
		assert.equal(byId.get(reply)?.runId, 'run-a');
		assert.equal(byId.get(after)?.runId, undefined);
		assert.equal(byId.get(reply)?.message.runId, undefined, 'the model-facing message is untouched');
		assert.ok([...byId.values()].filter((e) => e.type === 'thinking_level_change').every((e) => e.runId === undefined), 'only message entries are stamped');
		assert.deepEqual(stamped, [`run-a:${user}`, `run-a:${reply}`], 'reports each stamped entry so the run can name its last durable successor');

		const reopened = SessionManager.open(file, dir);
		const modelContext = reopened.buildSessionContext();
		assert.equal(modelContext.messages.length, 4, 'stamped file reloads normally');
		assert.ok(!JSON.stringify(modelContext).includes('run-a'), 'run id is render/dedup metadata only; never in model-facing context');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
