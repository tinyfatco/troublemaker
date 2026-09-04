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

export type WorkspaceDeliveryState = "pending" | "accepted" | "completed" | "rejected";

export interface WorkspaceDeliveryReceipt {
	deliveryId: string;
	state: WorkspaceDeliveryState;
	reservedAt?: string;
	acceptedAt?: string;
	claimedAt?: string;
	completedAt?: string;
	rejectedAt?: string;
	rejectionReason?: string;
}

type StoredWorkspaceDelivery = Omit<WorkspaceDeliveryReceipt, "deliveryId">;

/**
 * Host-owned replay guard used by inbound transports. A pending reservation is
 * durable dedupe authority only; it is not delivery success. Acceptance and
 * completion are explicit monotonic transitions, and rejection is terminal for
 * the exact delivery identity.
 */
export class WorkspaceDeliveryLedger {
	private deliveries?: Map<string, StoredWorkspaceDelivery>;

	constructor(
		private readonly path: string,
		private readonly unreadableMessage: string,
	) {}

	has(deliveryId: string): boolean {
		return this.load().has(deliveryId);
	}

	receipt(deliveryId: string): WorkspaceDeliveryReceipt | undefined {
		const stored = this.load().get(deliveryId);
		return stored ? { deliveryId, ...stored } : undefined;
	}

	receipts(deliveryIds: readonly string[]): WorkspaceDeliveryReceipt[] {
		// Receipt readers may be distinct from the adapter that owns transitions.
		// Reload so reconnect reconciliation observes durable cross-reader changes.
		this.deliveries = undefined;
		const deliveries = this.load();
		return deliveryIds.flatMap((deliveryId) => {
			const stored = deliveries.get(deliveryId);
			return stored ? [{ deliveryId, ...stored }] : [];
		});
	}

	/** Reserve an identity before asynchronous admission without claiming success. */
	reserve(deliveryId: string): boolean {
		const deliveries = this.load();
		if (deliveries.has(deliveryId)) return false;
		const reservedAt = new Date().toISOString();
		this.append({ deliveryId, reservedAt });
		deliveries.set(deliveryId, { state: "pending", reservedAt });
		return true;
	}

	/** Mark an exact pending reservation accepted by its authoritative route. */
	accept(deliveryId: string): boolean {
		const deliveries = this.load();
		const existing = deliveries.get(deliveryId);
		if (existing?.state !== "pending") return false;
		const acceptedAt = new Date().toISOString();
		this.append({ deliveryId, acceptedAt });
		deliveries.set(deliveryId, { ...existing, state: "accepted", acceptedAt });
		return true;
	}

	/** Terminally reject one pending reservation; its identity can never be reused. */
	reject(deliveryId: string, reason: string): boolean {
		const deliveries = this.load();
		const existing = deliveries.get(deliveryId);
		if (existing?.state !== "pending") return false;
		const rejectedAt = new Date().toISOString();
		const rejectionReason = safeRejectionReason(reason);
		this.append({ deliveryId, rejectedAt, rejectionReason });
		deliveries.set(deliveryId, {
			...existing,
			state: "rejected",
			rejectedAt,
			rejectionReason,
		});
		return true;
	}

	/**
	 * Backward-compatible one-step acceptance for transports whose durable claim
	 * is already their authoritative admission boundary.
	 */
	claim(deliveryId: string): boolean {
		const deliveries = this.load();
		if (deliveries.has(deliveryId)) return false;
		const claimedAt = new Date().toISOString();
		this.append({ deliveryId, claimedAt });
		deliveries.set(deliveryId, { state: "accepted", claimedAt, acceptedAt: claimedAt });
		return true;
	}

	/** Record completion only for a previously accepted delivery. */
	complete(deliveryId: string): void {
		const deliveries = this.load();
		const existing = deliveries.get(deliveryId);
		if (existing?.state !== "accepted") return;
		const completedAt = new Date().toISOString();
		this.append({ deliveryId, completedAt });
		deliveries.set(deliveryId, { ...existing, state: "completed", completedAt });
	}

	private append(record: DeliveryLedgerRecord): void {
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
				const record = JSON.parse(line) as DeliveryLedgerRecord;
				if (typeof record.deliveryId !== "string" || !record.deliveryId) continue;
				const existing = deliveries.get(record.deliveryId);
				if (typeof record.reservedAt === "string" && !existing) {
					deliveries.set(record.deliveryId, { state: "pending", reservedAt: record.reservedAt });
					continue;
				}
				if (typeof record.claimedAt === "string" && !existing) {
					deliveries.set(record.deliveryId, {
						state: "accepted",
						claimedAt: record.claimedAt,
						acceptedAt: record.claimedAt,
					});
					continue;
				}
				if (typeof record.acceptedAt === "string" && existing?.state === "pending") {
					deliveries.set(record.deliveryId, {
						...existing,
						state: "accepted",
						acceptedAt: record.acceptedAt,
					});
					continue;
				}
				if (typeof record.rejectedAt === "string" && existing?.state === "pending") {
					deliveries.set(record.deliveryId, {
						...existing,
						state: "rejected",
						rejectedAt: record.rejectedAt,
						...(typeof record.rejectionReason === "string"
							? { rejectionReason: safeRejectionReason(record.rejectionReason) }
							: {}),
					});
					continue;
				}
				if (typeof record.completedAt === "string" && existing?.state === "accepted") {
					deliveries.set(record.deliveryId, {
						...existing,
						state: "completed",
						completedAt: record.completedAt,
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

interface DeliveryLedgerRecord {
	deliveryId: string;
	reservedAt?: string;
	acceptedAt?: string;
	claimedAt?: string;
	completedAt?: string;
	rejectedAt?: string;
	rejectionReason?: string;
}

function safeRejectionReason(reason: string): string {
	return /^[a-z0-9_:-]{1,64}$/.test(reason) ? reason : "rejected";
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
