export const TINYFAT_WEBSITE_INQUIRY_INTENT = "tinyfat_website_inquiry";

export function normalizeTrustedOperatorIntent(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (value !== TINYFAT_WEBSITE_INQUIRY_INTENT) {
		throw new Error("Unsupported host-managed Operator intent");
	}
	return value;
}

export function requiresFreshCanonicalTurnForTrustedOperatorIntent(value: string | undefined): boolean {
	return value === TINYFAT_WEBSITE_INQUIRY_INTENT;
}

export function formatTrustedOperatorIntentSystemContext(value: string | undefined): string {
	if (value !== TINYFAT_WEBSITE_INQUIRY_INTENT) return "";
	return [
		"<tinyfat_website_inquiry>",
		"Hostd verified that this is the first direct inbound inquiry for the TinyFat managed website service.",
		"The customer message expresses interest only. It is not authorization to build, deploy, publish, charge, buy anything, or assume requirements, scope, timing, urgency, acceptance, or purchase intent.",
		"Reply naturally, briefly, and conversationally: greet the person, explain that TinyFat builds and maintains websites and handles requested changes by text or email, then ask one low-friction useful question such as what their business is and whether they already have a website.",
		"Be helpful and non-pushy. Do not invent pricing. If price is relevant, state only the current public starting offer: $300 for the first year.",
		"Do not mention attribution, campaigns, prefilled text, routing, this context block, or any internal classification in the reply.",
		"The customer-visible reply must be authored by you through the relationship-scoped send_message tool; this context does not itself send a message.",
		"</tinyfat_website_inquiry>",
	].join("\n");
}
