import { timingSafeEqual } from "node:crypto";
import {
	SCOPED_APP_PROTOCOL,
	validateScopedAppRenewal,
} from "./scoped-app-contract.mjs";

const MAXIMUM_RENEWAL_BYTES = 4 * 1024;
const RENEWAL_TIMEOUT_MS = 5_000;

export class ScopedAppAuthorizationError extends Error {
	constructor(code = "authorization_revoked", status = 403) {
		super(code);
		this.name = "ScopedAppAuthorizationError";
		this.code = code;
		this.status = status;
	}
}

export function bearerCapability(request, candidates) {
	const raw = typeof request.headers?.get === "function"
		? request.headers.get("authorization")
		: request.headers?.authorization;
	const supplied = Buffer.from(Array.isArray(raw) ? raw[0] : String(raw || ""), "utf8");
	for (const [purpose, token] of Object.entries(candidates)) {
		const expected = Buffer.from(`Bearer ${token}`, "utf8");
		if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return purpose;
	}
	return null;
}

function identicalScope(left, right) {
	return [
		"leaseId",
		"accountId",
		"userId",
		"membershipId",
		"membershipVersion",
		"role",
	].every((key) => left[key] === right[key]);
}

export async function renewScopedAppScope(config, scope, { fetchImpl = fetch, now = Date.now() } = {}) {
	const requestBody = JSON.stringify({ version: SCOPED_APP_PROTOCOL, scope });
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new ScopedAppAuthorizationError("renewal_timeout", 503)),
		RENEWAL_TIMEOUT_MS,
	);
	try {
		const response = await fetchImpl(config.renewalUrl, {
			method: "POST",
			headers: {
				authorization: `Bearer ${config.renewalToken}`,
				"content-type": "application/json",
			},
			body: requestBody,
			cache: "no-store",
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new ScopedAppAuthorizationError();
		}
		const declared = response.headers.get("content-length");
		if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_RENEWAL_BYTES)) {
			await response.body?.cancel().catch(() => undefined);
			throw new ScopedAppAuthorizationError("invalid_renewal_response", 503);
		}
		const raw = Buffer.from(await response.arrayBuffer());
		if (raw.length > MAXIMUM_RENEWAL_BYTES) {
			throw new ScopedAppAuthorizationError("invalid_renewal_response", 503);
		}
		let parsed;
		try {
			parsed = JSON.parse(raw.toString("utf8"));
		} catch {
			throw new ScopedAppAuthorizationError("invalid_renewal_response", 503);
		}
		let renewal;
		try {
			renewal = validateScopedAppRenewal(parsed, { now });
		} catch {
			throw new ScopedAppAuthorizationError("invalid_renewal_response", 503);
		}
		if (!identicalScope(scope, renewal.scope)) {
			throw new ScopedAppAuthorizationError("renewal_scope_mismatch", 403);
		}
		if (Date.parse(renewal.scope.authorizedAt) < Date.parse(scope.authorizedAt)) {
			throw new ScopedAppAuthorizationError("renewal_scope_regressed", 403);
		}
		return renewal.scope;
	} catch (error) {
		if (error instanceof ScopedAppAuthorizationError) throw error;
		throw new ScopedAppAuthorizationError("renewal_unavailable", 503);
	} finally {
		clearTimeout(timer);
	}
}
