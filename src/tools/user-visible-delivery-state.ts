export interface UserVisibleDeliveryFailure {
	target: string;
	error: string;
}

const unresolvedFailures = new Map<string, UserVisibleDeliveryFailure>();

export function resetUserVisibleDeliveryState(): void {
	unresolvedFailures.clear();
}

export function recordUserVisibleDeliveryFailure(target: string, error: unknown): void {
	const normalizedTarget = target.trim() || "unknown";
	const message = error instanceof Error ? error.message : String(error);
	unresolvedFailures.set(normalizedTarget, {
		target: normalizedTarget,
		error: message.slice(0, 1000),
	});
}

export function recordUserVisibleDeliverySuccess(target: string): void {
	unresolvedFailures.delete(target.trim() || "unknown");
}

export function currentUserVisibleDeliveryFailure(): UserVisibleDeliveryFailure | undefined {
	return unresolvedFailures.values().next().value;
}

export function shouldSurfaceUserVisibleDeliveryFailure(
	directlyAddressed: boolean,
	yielded: boolean,
): boolean {
	return directlyAddressed && yielded && unresolvedFailures.size > 0;
}

export const USER_VISIBLE_DELIVERY_FAILURE_MESSAGE =
	"I couldn't deliver that reply, so I stopped without retrying.";

export async function surfaceUserVisibleDeliveryFailure({
	directlyAddressed,
	yielded,
	sendFinalResponse,
}: {
	directlyAddressed: boolean;
	yielded: boolean;
	sendFinalResponse: (text: string, options: { force: true }) => Promise<void>;
}): Promise<UserVisibleDeliveryFailure | undefined> {
	if (!shouldSurfaceUserVisibleDeliveryFailure(directlyAddressed, yielded)) return undefined;
	const failure = currentUserVisibleDeliveryFailure();
	if (!failure) return undefined;
	await sendFinalResponse(`_${USER_VISIBLE_DELIVERY_FAILURE_MESSAGE}_`, { force: true });
	return failure;
}

export interface DeliveryRunCompletion {
	stopReason: string;
	errorMessage?: string;
}

export async function finalizeUserVisibleDeliveryFailure({
	completion,
	directlyAddressed,
	yielded,
	sendFinalResponse,
	clearYield,
}: {
	completion: DeliveryRunCompletion;
	directlyAddressed: boolean;
	yielded: boolean;
	sendFinalResponse: (text: string, options: { force: true }) => Promise<void>;
	clearYield: () => void;
}): Promise<DeliveryRunCompletion & { failure?: UserVisibleDeliveryFailure }> {
	if (completion.stopReason === "error") return completion;
	const failure = await surfaceUserVisibleDeliveryFailure({
		directlyAddressed,
		yielded,
		sendFinalResponse,
	});
	if (!failure) return completion;
	clearYield();
	return { ...completion, failure };
}
