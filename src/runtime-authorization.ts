const AUTHORIZATION_URL_ENV = "TROUBLEMAKER_RUNTIME_AUTHORIZATION_URL";
const AUTHORIZATION_TOKEN_ENV = "TROUBLEMAKER_RUNTIME_AUTHORIZATION_TOKEN";
const AUTHORIZATION_TIMEOUT_MS = 5_000;
const MAXIMUM_RESPONSE_BYTES = 4 * 1024;

export type RuntimeAuthorizationBoundary = "model" | "tool" | "context" | "artifact";

export class RuntimeAuthorizationError extends Error {
	constructor() {
		super("Runtime authorization is no longer valid.");
		this.name = "RuntimeAuthorizationError";
	}
}

function authorizationConfig(environment: NodeJS.ProcessEnv = process.env): {
	url: string;
	token: string;
} | null {
	const rawUrl = environment[AUTHORIZATION_URL_ENV];
	const token = environment[AUTHORIZATION_TOKEN_ENV];
	if (!rawUrl && !token) return null;
	if (!rawUrl || !token || token.length < 32) throw new RuntimeAuthorizationError();
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new RuntimeAuthorizationError();
	}
	if (
		!["http:", "https:"].includes(url.protocol)
		|| url.username
		|| url.password
		|| url.hash
		|| url.search
	) throw new RuntimeAuthorizationError();
	return { url: url.toString(), token };
}

function linkedTimeout(signal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new RuntimeAuthorizationError()), AUTHORIZATION_TIMEOUT_MS);
	const abort = () => controller.abort(signal?.reason ?? new RuntimeAuthorizationError());
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}

function validResponse(value: unknown): value is { ok: true; expiresAt: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).length === 2
		&& record.ok === true
		&& typeof record.expiresAt === "string"
		&& Number.isFinite(Date.parse(record.expiresAt))
		&& Date.parse(record.expiresAt) > Date.now();
}

/**
 * Revalidate host-owned turn authorization immediately before a model or tool
 * boundary. Ordinary standalone runtimes leave both environment variables
 * absent and incur no network request. A partially configured or rejected
 * guard always fails closed without exposing provider response details.
 */
export async function requireRuntimeAuthorization(
	boundary: RuntimeAuthorizationBoundary,
	signal?: AbortSignal,
): Promise<void> {
	const config = authorizationConfig();
	if (!config) return;
	const linked = linkedTimeout(signal);
	try {
		const response = await fetch(config.url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${config.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ version: "1", boundary }),
			cache: "no-store",
			redirect: "error",
			signal: linked.signal,
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new RuntimeAuthorizationError();
		}
		const declared = response.headers.get("content-length");
		if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)) {
			await response.body?.cancel().catch(() => undefined);
			throw new RuntimeAuthorizationError();
		}
		const body = await response.arrayBuffer();
		if (body.byteLength > MAXIMUM_RESPONSE_BYTES) throw new RuntimeAuthorizationError();
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(body).toString("utf8"));
		} catch {
			throw new RuntimeAuthorizationError();
		}
		if (!validResponse(parsed)) throw new RuntimeAuthorizationError();
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		if (error instanceof RuntimeAuthorizationError) throw error;
		throw new RuntimeAuthorizationError();
	} finally {
		linked.cleanup();
	}
}
