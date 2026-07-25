import { appendFileSync, readFileSync } from "node:fs";
import type { MomEvent, MomHandler, PlatformAdapter } from "./types.js";
import { slashCommandHandled, slashCommandPending } from "./types.js";

type QueuedWork = () => Promise<void>;

/**
 * One serial execution lane per customer collaboration channel. Transports
 * receive events differently; busy/steer/stop/command behavior is shared.
 */
export class WorkspaceChannelQueue {
	private readonly queue: Array<{ work: QueuedWork; resolve: () => void }> = [];
	private processing = false;

	constructor(private readonly onError: (error: unknown) => void) {}

	enqueue(work: QueuedWork): Promise<void> {
		let resolve!: () => void;
		const done = new Promise<void>((doneResolve) => {
			resolve = doneResolve;
		});
		this.queue.push({ work, resolve });
		void this.processNext();
		return done;
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const item = this.queue.shift()!;
		try {
			await item.work();
		} catch (error) {
			this.onError(error);
		} finally {
			item.resolve();
			this.processing = false;
			void this.processNext();
		}
	}
}

/**
 * Host-owned replay guard used by webhook transports. Completion is appended
 * only after the shared event router returns successfully.
 */
export class WorkspaceDeliveryLedger {
	private completed?: Set<string>;

	constructor(
		private readonly path: string,
		private readonly unreadableMessage: string,
	) {}

	has(deliveryId: string): boolean {
		return this.load().has(deliveryId);
	}

	complete(deliveryId: string): void {
		const ids = this.load();
		if (ids.has(deliveryId)) return;
		appendFileSync(
			this.path,
			`${JSON.stringify({ deliveryId, completedAt: new Date().toISOString() })}\n`,
			{ mode: 0o600 },
		);
		ids.add(deliveryId);
	}

	private load(): Set<string> {
		if (this.completed) return this.completed;
		const ids = new Set<string>();
		try {
			for (const line of readFileSync(this.path, "utf8").split("\n")) {
				if (!line.trim()) continue;
				const record = JSON.parse(line) as { deliveryId?: unknown };
				if (typeof record.deliveryId === "string" && record.deliveryId) {
					ids.add(record.deliveryId);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(this.unreadableMessage);
			}
		}
		this.completed = ids;
		return ids;
	}
}

export async function routeWorkspaceChannelEvent({
	handler,
	adapter,
	event,
	queue,
	awaitCompletion = false,
}: {
	handler: MomHandler;
	adapter: PlatformAdapter;
	event: MomEvent;
	queue: WorkspaceChannelQueue;
	awaitCompletion?: boolean;
}): Promise<void> {
	if (handler.resolvePendingInput(event.channel, event.text)) return;
	const command = await handler.handleSlashCommand(event, adapter);
	if (slashCommandHandled(command)) {
		if (awaitCompletion) await slashCommandPending(command);
		return;
	}
	if (event.text.toLowerCase().trim() === "stop") {
		await handler.handleStop(event.channel, adapter, event);
		return;
	}
	if (handler.isRunning(event.channel)) {
		const settled = handler.handleSteer(event, adapter);
		if (awaitCompletion) await settled;
		return;
	}
	const work = queue.enqueue(async () => {
		await handler.handleEvent(event, adapter);
	});
	if (awaitCompletion) await work;
}
