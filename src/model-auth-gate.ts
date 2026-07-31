import { isModelCredentialUnavailableError } from "./model-config.js";

export type ModelCredentialGateResult<T> =
	| { status: "prompted"; value: T }
	| { status: "credential_unavailable"; error: Error };

/**
 * Resolve the active model credential before starting a prompt. A missing or
 * expired credential is an operational outage, not assistant-authored content:
 * callers can fail quiet without creating a provider message that another
 * resident would ingest as a fresh turn. The prompt is also covered so a
 * credential that expires between preflight and dispatch has the same result.
 */
export async function runWithModelCredentialGate<T>({
	resolveCredential,
	prompt,
}: {
	resolveCredential: () => Promise<unknown>;
	prompt: () => Promise<T>;
}): Promise<ModelCredentialGateResult<T>> {
	try {
		await resolveCredential();
		return { status: "prompted", value: await prompt() };
	} catch (error) {
		if (!isModelCredentialUnavailableError(error)) throw error;
		return {
			status: "credential_unavailable",
			error: error instanceof Error ? error : new Error("Model credential unavailable"),
		};
	}
}
