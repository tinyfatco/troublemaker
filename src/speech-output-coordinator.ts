export type SpeechOutputStatus = "queued" | "started" | "completed" | "canceled" | "failed";

export interface SpeechOutputReceipt {
	laneId: string;
	speechId: string;
	sequence: number;
	status: SpeechOutputStatus;
	at: number;
	reason?: string;
	error?: string;
}

export interface SpeechOutputExecution<T> {
	value: T;
	/** Resolves only after this output is no longer active. */
	completed: Promise<void>;
	/** Resolves only after cancellation has made this output inactive. */
	cancel: (reason: string) => Promise<void>;
}

export interface SpeechOutputRequest<T> {
	speechId: string;
	interrupt?: boolean;
	signal?: AbortSignal;
	start: (signal: AbortSignal) => Promise<SpeechOutputExecution<T>>;
}

export interface SpeechOutputStarted<T> {
	value: T;
	receipt: SpeechOutputReceipt;
	duplicate: boolean;
}

export interface SpeechOutputTicket<T> {
	laneId: string;
	speechId: string;
	duplicate: boolean;
	started: Promise<SpeechOutputStarted<T>>;
	settled: Promise<SpeechOutputReceipt>;
	cancel: (reason?: string) => void;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

interface SpeechJob<T> {
	request: SpeechOutputRequest<T>;
	controller: AbortController;
	started: Deferred<SpeechOutputStarted<T>>;
	settled: Deferred<SpeechOutputReceipt>;
	receipts: SpeechOutputReceipt[];
	execution?: SpeechOutputExecution<T>;
	cancelRequested?: string;
	cancelRequestedSignal: Deferred<void>;
	cancelPromise?: Promise<void>;
	terminal?: SpeechOutputReceipt;
	removeAbortListener?: () => void;
}

export class SpeechOutputCanceledError extends Error {
	constructor(
		public readonly speechId: string,
		public readonly reason: string,
	) {
		super(`Speech ${speechId} canceled: ${reason}`);
		this.name = "SpeechOutputCanceledError";
	}
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTerminal(status: SpeechOutputStatus): boolean {
	return status === "completed" || status === "canceled" || status === "failed";
}

/**
 * Serializes one logical speech-output lane.
 *
 * Jobs are FIFO unless a request explicitly sets `interrupt`. Interruption
 * cancels only the active utterance and places the new request at the front;
 * already queued requests keep their relative order. A speech id is idempotent
 * for the coordinator's full process lifetime; restart begins with no replay queue.
 */
export class SpeechOutputCoordinator {
	private readonly jobs = new Map<string, SpeechJob<unknown>>();
	private readonly queue: SpeechJob<unknown>[] = [];
	private readonly receiptLog: SpeechOutputReceipt[] = [];
	private active: SpeechJob<unknown> | null = null;
	private sequence = 0;
	private disposed = false;

	constructor(
		public readonly laneId: string,
		private readonly options: { maxReceipts?: number } = {},
	) {}

	enqueue<T>(request: SpeechOutputRequest<T>): SpeechOutputTicket<T> {
		if (this.disposed) throw new Error(`Speech output lane ${this.laneId} is shut down.`);
		const speechId = request.speechId.trim();
		if (!speechId) throw new Error("speechId must be non-empty.");

		const existing = this.jobs.get(speechId) as SpeechJob<T> | undefined;
		if (existing) return this.ticketFor(existing, true);

		const started = deferred<SpeechOutputStarted<T>>();
		// Queue cancellation can reject before a caller has attached its await.
		// Mark the rejection observed without changing the promise returned to callers.
		void started.promise.catch(() => {});
		const job: SpeechJob<T> = {
			request: { ...request, speechId },
			controller: new AbortController(),
			started,
			settled: deferred<SpeechOutputReceipt>(),
			cancelRequestedSignal: deferred<void>(),
			receipts: [],
		};
		this.jobs.set(speechId, job as SpeechJob<unknown>);
		this.emit(job, "queued");

		if (request.signal) {
			const onAbort = () => this.requestCancel(job, "caller_aborted");
			if (request.signal.aborted) {
				onAbort();
			} else {
				request.signal.addEventListener("abort", onAbort, { once: true });
				job.removeAbortListener = () => request.signal?.removeEventListener("abort", onAbort);
			}
		}

		if (!job.terminal) {
			if (request.interrupt && this.active) {
				this.requestCancel(this.active, `superseded_by:${speechId}`);
				let insertAt = 0;
				while (insertAt < this.queue.length && this.queue[insertAt]?.request.interrupt) insertAt += 1;
				this.queue.splice(insertAt, 0, job as SpeechJob<unknown>);
			} else {
				this.queue.push(job as SpeechJob<unknown>);
			}
			this.pump();
		}
		return this.ticketFor(job, false);
	}

	getReceipts(): SpeechOutputReceipt[] {
		return this.receiptLog.map((receipt) => ({ ...receipt }));
	}

	get activeSpeechId(): string | null {
		return this.active?.request.speechId ?? null;
	}

	get queuedSpeechIds(): string[] {
		return this.queue.map((job) => job.request.speechId);
	}

	async shutdown(reason = "lane_shutdown"): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const job of [...this.queue]) this.requestCancel(job, reason);
		if (this.active) {
			const active = this.active;
			this.requestCancel(active, reason);
			await active.settled.promise;
		}
	}

	private ticketFor<T>(job: SpeechJob<T>, duplicate: boolean): SpeechOutputTicket<T> {
		const started = job.started.promise.then((result) => ({ ...result, duplicate }));
		void started.catch(() => {});
		return {
			laneId: this.laneId,
			speechId: job.request.speechId,
			duplicate,
			started,
			settled: job.settled.promise,
			cancel: (reason = "caller_canceled") => this.requestCancel(job, reason),
		};
	}

	private emit<T>(job: SpeechJob<T>, status: SpeechOutputStatus, detail: { reason?: string; error?: string } = {}): SpeechOutputReceipt {
		const receipt: SpeechOutputReceipt = Object.freeze({
			laneId: this.laneId,
			speechId: job.request.speechId,
			sequence: ++this.sequence,
			status,
			at: Date.now(),
			...detail,
		});
		job.receipts.push(receipt);
		this.receiptLog.push(receipt);
		const maxReceipts = Math.max(1, this.options.maxReceipts ?? 1024);
		if (this.receiptLog.length > maxReceipts) this.receiptLog.splice(0, this.receiptLog.length - maxReceipts);
		return receipt;
	}

	private terminalize<T>(job: SpeechJob<T>, status: Extract<SpeechOutputStatus, "completed" | "canceled" | "failed">, detail: { reason?: string; error?: string } = {}): SpeechOutputReceipt {
		if (job.terminal) return job.terminal;
		const receipt = this.emit(job, status, detail);
		job.terminal = receipt;
		job.removeAbortListener?.();
		if (status === "canceled" && job.receipts.every((entry) => entry.status !== "started")) {
			job.started.reject(new SpeechOutputCanceledError(job.request.speechId, detail.reason ?? "canceled"));
		} else if (status === "failed" && job.receipts.every((entry) => entry.status !== "started")) {
			job.started.reject(new Error(detail.error ?? `Speech ${job.request.speechId} failed.`));
		}
		job.settled.resolve(receipt);
		job.execution = undefined;
		job.request = {
			speechId: job.request.speechId,
			start: async () => { throw new Error("Terminal speech jobs cannot restart."); },
		};
		return receipt;
	}

	private requestCancel<T>(job: SpeechJob<T>, reason: string): void {
		if (job.terminal || job.cancelRequested) return;
		job.cancelRequested = reason;
		job.cancelRequestedSignal.resolve();
		job.controller.abort(new SpeechOutputCanceledError(job.request.speechId, reason));

		const queuedIndex = this.queue.indexOf(job as SpeechJob<unknown>);
		if (queuedIndex >= 0 && this.active !== job) {
			this.queue.splice(queuedIndex, 1);
			this.terminalize(job, "canceled", { reason });
			return;
		}
		if (job.execution) this.beginExecutionCancel(job);
	}

	private beginExecutionCancel<T>(job: SpeechJob<T>): Promise<void> {
		if (job.cancelPromise) return job.cancelPromise;
		const execution = job.execution;
		if (!execution) return Promise.resolve();
		job.cancelPromise = Promise.resolve(execution.cancel(job.cancelRequested ?? "canceled"))
			.catch(async () => {
				// Never release the lane merely because cancellation reporting failed.
				// The execution's completion is the fallback proof that output stopped.
				await execution.completed.catch(() => {});
			});
		return job.cancelPromise;
	}

	private pump(): void {
		if (this.active || this.disposed) return;
		const next = this.queue.shift();
		if (!next) return;
		if (next.terminal) {
			this.pump();
			return;
		}
		this.active = next;
		void this.run(next).finally(() => {
			if (this.active === next) this.active = null;
			this.pump();
		});
	}

	private async run(job: SpeechJob<unknown>): Promise<void> {
		try {
			const execution = await job.request.start(job.controller.signal);
			job.execution = execution;
			if (job.cancelRequested || job.controller.signal.aborted) {
				await this.beginExecutionCancel(job);
				this.terminalize(job, "canceled", { reason: job.cancelRequested ?? "caller_aborted" });
				return;
			}

			const startedReceipt = this.emit(job, "started");
			job.started.resolve({ value: execution.value, receipt: startedReceipt, duplicate: false });

			const completed = execution.completed.then(
				() => ({ status: "completed" as const }),
				(error) => ({ status: "failed" as const, error }),
			);
			const canceled = job.cancelRequestedSignal.promise.then(async () => {
				await this.beginExecutionCancel(job);
				return { status: "canceled" as const };
			});
			const outcome = await Promise.race([completed, canceled]);

			if (job.cancelRequested || outcome.status === "canceled") {
				this.terminalize(job, "canceled", { reason: job.cancelRequested ?? "canceled" });
			} else if (outcome.status === "failed") {
				this.terminalize(job, "failed", { error: errorMessage(outcome.error) });
			} else {
				this.terminalize(job, "completed");
			}
		} catch (error) {
			if (job.cancelRequested || job.controller.signal.aborted) {
				this.terminalize(job, "canceled", { reason: job.cancelRequested ?? "caller_aborted" });
			} else {
				this.terminalize(job, "failed", { error: errorMessage(error) });
			}
		}
	}
}

export function assertMonotonicSpeechReceipts(receipts: readonly SpeechOutputReceipt[]): void {
	let previousSequence = 0;
	const terminalBySpeechId = new Set<string>();
	for (const receipt of receipts) {
		if (receipt.sequence <= previousSequence) throw new Error("Speech receipt sequence is not strictly monotonic.");
		previousSequence = receipt.sequence;
		if (terminalBySpeechId.has(receipt.speechId)) throw new Error(`Speech ${receipt.speechId} emitted a receipt after terminal state.`);
		if (isTerminal(receipt.status)) terminalBySpeechId.add(receipt.speechId);
	}
}
