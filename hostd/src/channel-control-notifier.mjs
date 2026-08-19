export class ChannelControlNotifier {
	constructor({
		store,
		projection,
		tickSeconds = 2,
		maximumAttempts = 10,
		label = "operator workspace",
		onProjected,
	}) {
		this.store = store;
		this.projection = projection;
		this.tickMilliseconds = tickSeconds * 1000;
		this.maximumAttempts = maximumAttempts;
		this.label = label;
		this.onProjected = onProjected;
		this.timer = null;
		this.currentPump = null;
		this.stopped = true;
	}

	setOnProjected(callback) {
		this.onProjected = callback;
	}

	async start() {
		this.stopped = false;
		await this.pump();
		this.timer = setInterval(() => void this.pump(), this.tickMilliseconds);
		this.timer.unref();
	}

	async stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.currentPump;
	}

	wake() {
		if (!this.stopped) queueMicrotask(() => void this.pump());
	}

	async pump() {
		if (this.stopped || this.currentPump) return this.currentPump;
		this.currentPump = this.pumpInner();
		try {
			await this.currentPump;
		} finally {
			this.currentPump = null;
		}
	}

	async pumpInner() {
		for (let count = 0; count < 25; count++) {
			const notification = this.store.claimControlNotification(this.maximumAttempts);
			if (!notification) break;
			try {
				const postId = await this.projection.postEmailLedgerNotification(notification);
				const completed = this.store.completeControlNotification(notification.id, postId);
				console.log(
					`troublemaker-hostd: projected ${notification.source} awareness event ${notification.providerMessageId} to ${this.label} for ${notification.contextId}`,
				);
				if (completed?.status === "completed") await this.onProjected?.(completed);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const failed = this.store.failControlNotification(
					notification.id,
					message,
					notification.source === "mcp-operator" ? 1 : this.maximumAttempts,
				);
				console.error(
					`troublemaker-hostd: ${this.label} projection ${notification.id} ${failed?.status ?? "failed"}: ${message}`,
				);
			}
		}
	}
}
