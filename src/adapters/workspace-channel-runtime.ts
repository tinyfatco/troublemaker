import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
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
 * Host-owned replay guard used by webhook transports. A durable claim prevents
 * an accepted agent turn from being launched twice across a resident restart;
 * completion remains separately auditable after the event router returns.
 */
export class WorkspaceDeliveryLedger {
	private deliveries?: Map<string, "claimed" | "completed">;

	constructor(
		private readonly path: string,
		private readonly unreadableMessage: string,
	) {}

	has(deliveryId: string): boolean {
		return this.load().has(deliveryId);
	}

	/**
	 * Durably claim a delivery before the transport acknowledges it. Agent turns
	 * can survive a resident restart independently, so replaying an accepted turn
	 * is more dangerous than retaining an incomplete claim for reconciliation.
	 */
	claim(deliveryId: string): boolean {
		const deliveries = this.load();
		if (deliveries.has(deliveryId)) return false;
		this.append({
			deliveryId,
			claimedAt: new Date().toISOString(),
		});
		deliveries.set(deliveryId, "claimed");
		return true;
	}

	complete(deliveryId: string): void {
		const deliveries = this.load();
		if (deliveries.get(deliveryId) === "completed") return;
		this.append({
			deliveryId,
			completedAt: new Date().toISOString(),
		});
		deliveries.set(deliveryId, "completed");
	}

	private append(record: { deliveryId: string; claimedAt?: string; completedAt?: string }): void {
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	}

	private load(): Map<string, "claimed" | "completed"> {
		if (this.deliveries) return this.deliveries;
		const deliveries = new Map<string, "claimed" | "completed">();
		try {
			for (const line of readFileSync(this.path, "utf8").split("\n")) {
				if (!line.trim()) continue;
				const record = JSON.parse(line) as {
					deliveryId?: unknown;
					claimedAt?: unknown;
					completedAt?: unknown;
				};
				if (typeof record.deliveryId === "string" && record.deliveryId) {
					deliveries.set(
						record.deliveryId,
						typeof record.completedAt === "string" ? "completed" : "claimed",
					);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(this.unreadableMessage);
			}
		}
		this.deliveries = deliveries;
		return deliveries;
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
