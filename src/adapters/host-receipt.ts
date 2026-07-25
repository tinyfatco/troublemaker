import * as log from "../log.js";

export interface HostDeliveryReceipt {
	url: string;
	token: string;
	leaseToken: string;
}

function validReceipt(value: unknown): value is HostDeliveryReceipt {
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

async function report(receipt: HostDeliveryReceipt, status: string, error?: string): Promise<void> {
	const response = await fetch(receipt.url, {
		method: "POST",
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
	work: () => Promise<T>,
): Promise<T> {
	if (!validReceipt(rawReceipt)) return await work();
	const receipt = rawReceipt;
	await report(receipt, "running");
	const timer = setInterval(() => {
		void report(receipt, "heartbeat").catch((error) => {
			log.logWarning("Host delivery heartbeat failed", error instanceof Error ? error.message : String(error));
		});
	}, 30_000);
	timer.unref();
	try {
		const result = await work();
		await report(receipt, "completed");
		return result;
	} catch (error) {
		try {
			await report(receipt, "failed", error instanceof Error ? error.message : String(error));
		} catch (receiptError) {
			log.logWarning(
				"Host delivery failure receipt failed",
				receiptError instanceof Error ? receiptError.message : String(receiptError),
			);
		}
		throw error;
	} finally {
		clearInterval(timer);
	}
}
