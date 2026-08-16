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
export interface WorkspaceDeliveryReceipt {
	deliveryId: string;
	state: "accepted" | "completed";
	claimedAt?: string;
	completedAt?: string;
}

interface StoredWorkspaceDelivery {
	claimedAt?: string;
	completedAt?: string;
}

export class WorkspaceDeliveryLedger {
	private deliveries?: Map<string, StoredWorkspaceDelivery>;

	constructor(
		private readonly path: string,
		private readonly unreadableMessage: string,
	) {}

	has(deliveryId: string): boolean {
		return this.load().has(deliveryId);
	}

	/**
	 * Read current durable authority for a bounded caller-supplied set. This
	 * deliberately refreshes from disk because the gateway and adapter own
	 * separate ledger readers in the same resident process.
	 */
	receipts(deliveryIds: readonly string[]): WorkspaceDeliveryReceipt[] {
		this.deliveries = undefined;
		const deliveries = this.load();
		return deliveryIds.flatMap((deliveryId) => {
			const stored = deliveries.get(deliveryId);
			if (!stored) return [];
			return [{
				deliveryId,
				state: stored.completedAt ? "completed" : "accepted",
				...(stored.claimedAt ? { claimedAt: stored.claimedAt } : {}),
				...(stored.completedAt ? { completedAt: stored.completedAt } : {}),
			} satisfies WorkspaceDeliveryReceipt];
		});
	}

	/**
	 * Durably claim a delivery before the transport acknowledges it. Agent turns
	 * can survive a resident restart independently, so replaying an accepted turn
	 * is more dangerous than retaining an incomplete claim for reconciliation.
	 */
	claim(deliveryId: string): boolean {
		const deliveries = this.load();
		if (deliveries.has(deliveryId)) return false;
		const claimedAt = new Date().toISOString();
		this.append({
			deliveryId,
			claimedAt,
		});
		deliveries.set(deliveryId, { claimedAt });
		return true;
	}

	complete(deliveryId: string): void {
		const deliveries = this.load();
		const existing = deliveries.get(deliveryId);
		if (existing?.completedAt) return;
		const completedAt = new Date().toISOString();
		this.append({
			deliveryId,
			completedAt,
		});
		deliveries.set(deliveryId, { ...existing, completedAt });
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

	private load(): Map<string, StoredWorkspaceDelivery> {
		if (this.deliveries) return this.deliveries;
		const deliveries = new Map<string, StoredWorkspaceDelivery>();
		try {
			for (const line of readFileSync(this.path, "utf8").split("\n")) {
				if (!line.trim()) continue;
				const record = JSON.parse(line) as {
					deliveryId?: unknown;
					claimedAt?: unknown;
					completedAt?: unknown;
				};
				if (typeof record.deliveryId === "string" && record.deliveryId) {
					const existing = deliveries.get(record.deliveryId);
					deliveries.set(record.deliveryId, {
						claimedAt: typeof record.claimedAt === "string" ? record.claimedAt : existing?.claimedAt,
						completedAt: typeof record.completedAt === "string" ? record.completedAt : existing?.completedAt,
					});
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
	onAccepted,
}: {
	handler: MomHandler;
	adapter: PlatformAdapter;
	event: MomEvent;
	queue: WorkspaceChannelQueue;
	awaitCompletion?: boolean;
	/** Called once the event has entered its control, steer, or run route. */
	onAccepted?: () => void | Promise<void>;
}): Promise<void> {
	let accepted = false;
	const markAccepted = async () => {
		if (accepted) return;
		accepted = true;
		await onAccepted?.();
	};
	if (handler.resolvePendingInput(event.channel, event.text)) {
		await markAccepted();
		return;
	}
	const command = await handler.handleSlashCommand(event, adapter);
	if (slashCommandHandled(command)) {
		await markAccepted();
		if (awaitCompletion) await slashCommandPending(command);
		return;
	}
	if (event.text.toLowerCase().trim() === "stop") {
		const settled = handler.handleStop(event.channel, adapter, event);
		await markAccepted();
		await settled;
		return;
	}
	if (handler.isRunning(event.channel)) {
		const settled = handler.handleSteer(event, adapter);
		await markAccepted();
		if (awaitCompletion) await settled;
		return;
	}
	const work = queue.enqueue(async () => {
		await handler.handleEvent(event, adapter);
	});
	await markAccepted();
	if (awaitCompletion) await work;
}
