import { isAbsolute, join } from "node:path";
import type { OwnerPushContextVerifier } from "../../console/owner-push.js";
import { createAppleOwnerPushTransportFromEnvironment } from "./apple-owner-push-transport.js";
import { OwnerPushRuntime } from "./owner-push-runtime.js";
import { OwnerPushStore } from "./owner-push-store.js";

export interface OwnerPushBootstrapOptions {
	workingDir: string;
	contextVerifier: OwnerPushContextVerifier;
	env?: Record<string, string | undefined>;
}

export interface OwnerPushDeployment {
	runtime: OwnerPushRuntime;
	producerToken: string;
}

/**
 * Guarded deployment composition. No partial APNs configuration advertises or
 * registers owner push; a complete protected transport and exact context
 * verifier are required before this returns a runtime.
 */
export function createOwnerPushRuntimeFromEnvironment(
	options: OwnerPushBootstrapOptions,
): OwnerPushRuntime | undefined {
	const env = options.env ?? process.env;
	const transport = createAppleOwnerPushTransportFromEnvironment(env);
	if (!transport) return undefined;
	const configuredPath = env.TROUBLEMAKER_OWNER_PUSH_STORE_FILE?.trim();
	const path = configuredPath || join(options.workingDir, "protected", "owner-push-v1.json");
	if (!isAbsolute(path)) throw new Error("Owner push store path must be absolute");
	return new OwnerPushRuntime({
		store: new OwnerPushStore(path),
		contextVerifier: options.contextVerifier,
		transport,
	});
}

/**
 * Complete handoff consumed by a deployment facade. A runtime without an
 * independent authoritative producer credential is not operational and must
 * never drive capability advertisement.
 */
export function createOwnerPushDeploymentFromEnvironment(
	options: OwnerPushBootstrapOptions,
): OwnerPushDeployment | undefined {
	const env = options.env ?? process.env;
	const producerToken = env.TROUBLEMAKER_OWNER_PUSH_PRODUCER_TOKEN?.trim();
	const runtime = createOwnerPushRuntimeFromEnvironment(options);
	if (!runtime && !producerToken) return undefined;
	if (!runtime || !producerToken || Buffer.byteLength(producerToken, "utf8") < 32) {
		throw new Error("Owner push deployment configuration is incomplete");
	}
	return { runtime, producerToken };
}
