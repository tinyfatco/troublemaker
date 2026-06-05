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

type FakeWriter = {
	events: Record<string, unknown>[];
	errorSent: boolean;
	send(event: Record<string, unknown>): void;
	done(): void;
};

function fakeWriter(): FakeWriter {
	const events: Record<string, unknown>[] = [];
	return {
		events,
		errorSent: false,
		send(event: Record<string, unknown>) {
			if (event.type === "error") this.errorSent = true;
			events.push(event);
		},
		done() {},
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

const errorAdapter = new WebAdapter({ workingDir: process.cwd() });
const errorWriter = fakeWriter();
const errorInternals = errorAdapter as unknown as {
	processMessage(payload: {
		message: string;
		channelId: string;
		user: string;
		userName: string;
		freshContext: boolean;
	}, writer: FakeWriter): Promise<void>;
};

errorAdapter.setHandler({
	isRunning: () => false,
	handleSlashCommand: async () => false,
	handleSteer: () => {},
	handleStop: async () => {},
	resolvePendingInput: () => false,
	handleEvent: async () => ({
		stopReason: 'error',
		errorMessage: 'No API key found for openai-codex.',
	}),
} as any);

await errorInternals.processMessage({
	message: 'hello',
	channelId: 'web',
	user: 'web-user',
	userName: 'user',
	freshContext: false,
}, errorWriter);

const errorEvents = errorWriter.events.filter((event) => event.type === 'error');
assert(errorEvents.length === 1, 'run error result is surfaced as one SSE error event');
assert(errorEvents[0]?.message === 'No API key found for openai-codex.', 'run error SSE preserves the model error message');

const dedupeWriter = fakeWriter();
const webInternals = errorAdapter as unknown as {
	surfaceRunError(result: { stopReason: string; errorMessage?: string }, writer: FakeWriter): void;
};
dedupeWriter.send({ type: 'error', message: 'Already streamed' });
webInternals.surfaceRunError({ stopReason: 'error', errorMessage: 'Second error' }, dedupeWriter);
const dedupeErrors = dedupeWriter.events.filter((event) => event.type === 'error');
assert(dedupeErrors.length === 1, 'fallback run error does not duplicate an already-streamed error');
assert(dedupeErrors[0]?.message === 'Already streamed', 'deduped error keeps the originally streamed message');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
