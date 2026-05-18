import { WebAdapter } from '../src/adapters/web.ts';

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

function fakeWriter() {
	const events: Record<string, unknown>[] = [];
	return {
		events,
		send(event: Record<string, unknown>) {
			events.push(event);
		},
	};
}

const adapter = new WebAdapter({ workingDir: process.cwd() });
const scopedWriter = fakeWriter();
const staleWriter = fakeWriter();
const internals = adapter as unknown as {
	pendingWriters: Map<string, { send(event: Record<string, unknown>): void }>;
	writerScope: {
		run<T>(store: { channelId: string; writer: { send(event: Record<string, unknown>): void } }, callback: () => T): T;
	};
};

internals.pendingWriters.set('web', staleWriter);

internals.writerScope.run({ channelId: 'web', writer: scopedWriter }, () => {
	const ctx = adapter.createContext({
		type: 'dm',
		channel: 'web',
		ts: '1',
		user: 'web-user',
		text: 'run a tool',
	}, {} as any);

	ctx.emitContentBlock?.({ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: { path: 'README.md' } });
});

assert(scopedWriter.events.length === 1, 'request-scoped writer receives structured tool events');
assert(staleWriter.events.length === 0, 'stale channel writer does not receive scoped tool events');
assert(scopedWriter.events[0]?.type === 'toolCall', 'structured tool event is forwarded unchanged');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
