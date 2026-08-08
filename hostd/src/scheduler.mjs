export class EventScheduler {
	constructor({ config, store, runtime }) {
		this.config = config;
		this.store = store;
		this.runtime = runtime;
		this.pumping = false;
		this.reaping = false;
		this.lastReconciledAt = 0;
	}

	async start() {
		const recovery = this.store.recoverExpiredEvents();
		if (recovery.recovered) console.warn(`troublemaker-hostd: recovered ${recovery.recovered} pre-running event lease(s)`);
		if (recovery.uncertain) console.warn(`troublemaker-hostd: marked ${recovery.uncertain} post-running event(s) uncertain`);
		await this.runtime.reconcile();
		await this.runtime.reconcileScheduledWakeOwnership?.();
		this.lastReconciledAt = Date.now();
		this.pump();
	}

	pump() {
		if (this.pumping) return;
		this.pumping = true;
		queueMicrotask(() => void this.runPump());
	}

	async runPump() {
		try {
			if (this.store.getMeta("scheduler:draining") === "true") return;
			while (true) {
				const event = this.store.claimNextEvent({
					leaseSeconds: this.config.scheduler.leaseSeconds,
					maximumAttempts: this.config.scheduler.maximumAttempts,
					maximumActiveContexts: this.config.scheduler.maxConcurrent,
				});
				if (!event) break;
				void this.accept(event);
			}
		} finally {
			this.pumping = false;
		}
	}

	async accept(event) {
		try {
			await this.runtime.acceptEvent(event);
			const accepted = this.store.acceptEvent(
				event.id,
				event.leaseToken,
				this.config.scheduler.turnLeaseSeconds,
			);
			if (accepted?.status !== "accepted" && accepted?.status !== "running" && accepted?.status !== "completed") {
				throw new Error(`event ${event.id} was not accepted under its active lease`);
			}
			console.log(`troublemaker-hostd: runtime accepted ${event.source} event ${event.id} for ${event.contextId}`);
		} catch (error) {
			this.store.failEvent(
				event.id,
				error instanceof Error ? error.message : String(error),
				event.leaseToken,
				15,
				this.config.scheduler.maximumAttempts,
			);
			console.error(
				`troublemaker-hostd: runtime acceptance failed for ${event.id}:`,
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			this.pump();
		}
	}

	receipt(eventId, leaseToken, status, error) {
		if (status === "heartbeat" || status === "running") {
			const event = this.store.heartbeatEvent(eventId, leaseToken, this.config.scheduler.turnLeaseSeconds);
			this.pump();
			return event;
		}
		if (status === "completed") {
			const event = this.store.completeEvent(eventId, leaseToken);
			this.pump();
			return event;
		}
		if (status === "failed") {
			const event = this.store.failEvent(
				eventId,
				error || "runtime reported failure",
				leaseToken,
				15,
				this.config.scheduler.maximumAttempts,
			);
			this.pump();
			return event;
		}
		throw new Error(`unsupported receipt status ${status}`);
	}

	async tick() {
		const recovery = this.store.recoverExpiredEvents();
		if (recovery.recovered) console.warn(`troublemaker-hostd: recovered ${recovery.recovered} pre-running event lease(s)`);
		if (recovery.uncertain) console.warn(`troublemaker-hostd: marked ${recovery.uncertain} post-running event(s) uncertain`);
		this.pump();
		if (this.reaping) return;
		this.reaping = true;
		try {
			if (Date.now() - this.lastReconciledAt >= 60_000) {
				await this.runtime.reconcile();
				this.lastReconciledAt = Date.now();
			}
			await this.runtime.reapIdle();
		} finally {
			this.reaping = false;
		}
	}
}
