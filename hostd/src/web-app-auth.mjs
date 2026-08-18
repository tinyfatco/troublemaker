import {
	createHash,
	createHmac,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";

export const WEB_APP_ASSERTION_HEADERS = Object.freeze({
	version: "x-tinyfat-app-version",
	issuer: "x-tinyfat-app-issuer",
	audience: "x-tinyfat-app-audience",
	timestamp: "x-tinyfat-app-timestamp",
	nonce: "x-tinyfat-app-nonce",
	subject: "x-tinyfat-app-subject",
	email: "x-tinyfat-app-email",
	signature: "x-tinyfat-app-signature",
});

export class WebAppAuthError extends Error {
	constructor(message = "invalid web app assertion") {
		super(message);
		this.name = "WebAppAuthError";
		this.code = "web_app_unauthorized";
	}
}

export function webAppBodyDigest(body = Buffer.alloc(0)) {
	return createHash("sha256").update(body).digest("hex");
}

export function webAppCanonicalRequest({
	version = "1",
	issuer,
	audience,
	timestamp,
	nonce,
	method,
	path,
	bodyDigest,
	subject,
	email,
}) {
	return [
		version,
		issuer,
		audience,
		String(timestamp),
		nonce,
		method.toUpperCase(),
		path,
		bodyDigest,
		subject,
		email.toLowerCase(),
	].join("\n");
}

export function createWebAppAssertionHeaders({
	secret,
	issuer,
	audience,
	method,
	path,
	body = Buffer.alloc(0),
	subject,
	email,
	timestamp = Math.floor(Date.now() / 1000),
	nonce = randomUUID(),
}) {
	const normalizedEmail = email.trim().toLowerCase();
	const digest = webAppBodyDigest(body);
	const canonical = webAppCanonicalRequest({
		issuer,
		audience,
		timestamp,
		nonce,
		method,
		path,
		bodyDigest: digest,
		subject,
		email: normalizedEmail,
	});
	return {
		[WEB_APP_ASSERTION_HEADERS.version]: "1",
		[WEB_APP_ASSERTION_HEADERS.issuer]: issuer,
		[WEB_APP_ASSERTION_HEADERS.audience]: audience,
		[WEB_APP_ASSERTION_HEADERS.timestamp]: String(timestamp),
		[WEB_APP_ASSERTION_HEADERS.nonce]: nonce,
		[WEB_APP_ASSERTION_HEADERS.subject]: subject,
		[WEB_APP_ASSERTION_HEADERS.email]: normalizedEmail,
		[WEB_APP_ASSERTION_HEADERS.signature]: createHmac("sha256", secret)
			.update(canonical)
			.digest("hex"),
	};
}

function headerValue(headers, name) {
	const value = typeof headers.get === "function" ? headers.get(name) : headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function requiredHeader(headers, name) {
	const value = headerValue(headers, name);
	if (typeof value !== "string" || !value.trim()) throw new WebAppAuthError();
	return value.trim();
}

export class WebAppAssertionVerifier {
	constructor(config, { now = () => Date.now() } = {}) {
		this.config = config;
		this.now = now;
		this.usedNonces = new Map();
	}

	verify({ headers, method, path, body = Buffer.alloc(0) }) {
		const version = requiredHeader(headers, WEB_APP_ASSERTION_HEADERS.version);
		const issuer = requiredHeader(headers, WEB_APP_ASSERTION_HEADERS.issuer);
		const audience = requiredHeader(headers, WEB_APP_ASSERTION_HEADERS.audience);
		const timestampText = requiredHeader(headers, WEB_APP_ASSERTION_HEADERS.timestamp);
		const nonce = requiredHeader(headers, WEB_APP_ASSERTION_HEADERS.nonce);
		const subject = requiredHeader(headers, WEB_APP_ASSERTION_HEADERS.subject);
		const email = requiredHeader(headers, WEB_APP_ASSERTION_HEADERS.email).toLowerCase();
		const signature = requiredHeader(headers, WEB_APP_ASSERTION_HEADERS.signature);

		if (version !== "1" || issuer !== this.config.issuer || audience !== this.config.audience) {
			throw new WebAppAuthError();
		}
		if (!/^[A-Za-z0-9._:-]{1,256}$/.test(subject)) throw new WebAppAuthError();
		if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 320) throw new WebAppAuthError();
		if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new WebAppAuthError();
		if (!/^\d{10}$/.test(timestampText)) throw new WebAppAuthError();
		if (!/^[0-9a-f]{64}$/.test(signature)) throw new WebAppAuthError();

		const timestamp = Number(timestampText);
		const nowSeconds = Math.floor(this.now() / 1000);
		if (timestamp > nowSeconds + 5 || nowSeconds - timestamp > this.config.assertionTtlSeconds) {
			throw new WebAppAuthError();
		}

		const digest = webAppBodyDigest(body);
		const canonical = webAppCanonicalRequest({
			version,
			issuer,
			audience,
			timestamp,
			nonce,
			method,
			path,
			bodyDigest: digest,
			subject,
			email,
		});
		const expected = Buffer.from(
			createHmac("sha256", this.config.assertionSecret).update(canonical).digest("hex"),
			"utf8",
		);
		const supplied = Buffer.from(signature, "utf8");
		if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
			throw new WebAppAuthError();
		}

		this.pruneNonces(nowSeconds);
		if (method.toUpperCase() !== "GET") {
			if (this.usedNonces.has(nonce)) throw new WebAppAuthError();
			this.usedNonces.set(nonce, timestamp + this.config.assertionTtlSeconds);
		}

		return { subject, email };
	}

	pruneNonces(nowSeconds) {
		for (const [nonce, expiresAt] of this.usedNonces) {
			if (expiresAt < nowSeconds) this.usedNonces.delete(nonce);
		}
		if (this.usedNonces.size <= 10_000) return;
		const overflow = this.usedNonces.size - 10_000;
		for (const nonce of [...this.usedNonces.keys()].slice(0, overflow)) {
			this.usedNonces.delete(nonce);
		}
	}
}
