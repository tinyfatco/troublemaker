import * as log from "../log.js";

export interface HostDeliveryReceipt {
	url: string;
	token: string;
	leaseToken: string;
}

export interface HostReceiptProgress {
	/**
	 * Report that the durable delivery has entered its runtime route. Bridges
	 * may release the next ordered message after this point without waiting for
	 * the full agent turn to finish.
	 */
	markRunning(): Promise<void>;
}

export interface HostReceiptOptions<T = unknown> {
	/**
	 * Most host deliveries report running immediately. Ordered collaboration
	 * bridges can defer it until the adapter has actually routed the event.
	 */
	deferRunning?: boolean;
	/** Persist terminal receipt intent after work succeeds and before reporting completion. */
	beforeCompleted?: (result: T, receipt: HostDeliveryReceipt) => Promise<void> | void;
	/** Clear persisted terminal receipt intent only after Hostd acknowledges completion. */
	afterCompleted?: (result: T, receipt: HostDeliveryReceipt) => Promise<void> | void;
}

export function isValidHostReceipt(value: unknown): value is HostDeliveryReceipt {
	if (!value || typeof value !== "object") return false;
	const receipt = value as Partial<HostDeliveryReceipt>;
	if (typeof receipt.url !== "string" || typeof receipt.token !== "string" || typeof receipt.leaseToken !== "string") {
		return false;
	}
	try {
		const url = new URL(receipt.url);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
	} catch {
		return false;
	}
}

export async function reportHostReceipt(receipt: HostDeliveryReceipt, status: string, error?: string): Promise<void> {
	const response = await fetch(receipt.url, {
		method: "POST",
		redirect: "error",
		headers: {
			authorization: `Bearer ${receipt.token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			status,
			lease_token: receipt.leaseToken,
			...(error ? { error: error.slice(0, 1000) } : {}),
		}),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`host receipt returned HTTP ${response.status}`);
}

export async function withHostReceipt<T>(
	rawReceipt: unknown,
	work: (progress: HostReceiptProgress) => Promise<T>,
	options: HostReceiptOptions<T> = {},
): Promise<T> {
	if (!isValidHostReceipt(rawReceipt)) {
		return await work({ markRunning: async () => {} });
	}
	const receipt = rawReceipt;
	let runningReport: Promise<void> | null = null;
	const progress: HostReceiptProgress = {
		markRunning: () => {
			runningReport ??= reportHostReceipt(receipt, "running");
			return runningReport;
		},
	};
	if (!options.deferRunning) await progress.markRunning();
	const timer = setInterval(() => {
		void reportHostReceipt(receipt, "heartbeat").catch((error) => {
			log.logWarning("Host delivery heartbeat failed", error instanceof Error ? error.message : String(error));
		});
	}, 30_000);
	timer.unref();
	let workCompleted = false;
	try {
		const result = await work(progress);
		workCompleted = true;
		await options.beforeCompleted?.(result, receipt);
		await progress.markRunning();
		await reportHostReceipt(receipt, "completed");
		await options.afterCompleted?.(result, receipt);
		return result;
	} catch (error) {
		if (!workCompleted) {
			try {
				await reportHostReceipt(receipt, "failed", error instanceof Error ? error.message : String(error));
			} catch (receiptError) {
				log.logWarning(
					"Host delivery failure receipt failed",
					receiptError instanceof Error ? receiptError.message : String(receiptError),
				);
			}
		}
		throw error;
	} finally {
		clearInterval(timer);
	}
}
