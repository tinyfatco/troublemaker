/** An identity snapshot supplied by an authenticated transport, never by message text. */
export interface VerifiedSenderIdentity {
	source: "verified_ingress";
	userId: string;
	userName: string;
	displayName: string;
}

/** Only authenticated ingress code may create this provenance. Missing names stay missing. */
export function verifiedIngressSender(userId: string, userName: string, displayName: unknown): VerifiedSenderIdentity | undefined {
	return readVerifiedSenderIdentity({ source: "verified_ingress", userId, userName, displayName });
}

/** Validate persisted metadata and optionally bind it to the transport sender. */
export function readVerifiedSenderIdentity(value: unknown, userId?: string): VerifiedSenderIdentity | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const sender = value as Record<string, unknown>;
	if (sender.source !== "verified_ingress"
		|| !safeIdentityText(sender.userId)
		|| !safeIdentityText(sender.userName)
		|| !safeIdentityText(sender.displayName)
		|| (userId !== undefined && sender.userId !== userId)) return undefined;
	return {
		source: "verified_ingress",
		userId: sender.userId,
		userName: sender.userName,
		displayName: sender.displayName.trim(),
	};
}

function safeIdentityText(value: unknown): value is string {
	return typeof value === "string" && value.length <= 256 && Boolean(value.trim())
		&& !/[\u0000-\u001f\u007f]/.test(value);
}
