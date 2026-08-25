import assert from "node:assert/strict";
import test from "node:test";
import {
	createWebAppAssertionHeaders,
	WebAppAssertionVerifier,
} from "../src/web-app-auth.mjs";

const NOW = Date.parse("2026-01-02T03:04:05Z");
const CONFIG = {
	assertionSecret: "example-web-app-secret-at-least-32-bytes",
	issuer: "example-product",
	audience: "example-hostd-web",
	assertionTtlSeconds: 60,
};
const IDENTITY = {
	subject: "00000000-0000-4000-8000-000000000001",
	email: "casey@example.com",
	agent: "scout",
};

function assertion(overrides = {}) {
	return createWebAppAssertionHeaders({
		secret: CONFIG.assertionSecret,
		issuer: CONFIG.issuer,
		audience: CONFIG.audience,
		...IDENTITY,
		method: "POST",
		path: "/v1/app/messages?project=website",
		body: Buffer.from('{"message":"Howdy"}'),
		timestamp: Math.floor(NOW / 1000),
		nonce: "example_nonce_0001",
		...overrides,
	});
}

test("verifies a request-bound product assertion", () => {
	const verifier = new WebAppAssertionVerifier(CONFIG, { now: () => NOW });
	assert.deepEqual(verifier.verify({
		headers: assertion(),
		method: "POST",
		path: "/v1/app/messages?project=website",
		body: Buffer.from('{"message":"Howdy"}'),
	}), IDENTITY);
});

test("rejects path, body, identity, and expiry tampering", () => {
	for (const change of [
		{ path: "/v1/app/messages?project=other" },
		{ body: Buffer.from('{"message":"Changed"}') },
		{ headers: { ...assertion(), "x-tinyfat-app-email": "other@example.com" } },
		{ headers: { ...assertion(), "x-tinyfat-app-agent": "other-agent" } },
		{
			headers: assertion({
				timestamp: Math.floor(NOW / 1000) - 61,
				nonce: "example_nonce_0002",
			}),
		},
	]) {
		const verifier = new WebAppAssertionVerifier(CONFIG, { now: () => NOW });
		assert.throws(() => verifier.verify({
			headers: change.headers ?? assertion(),
			method: "POST",
			path: change.path ?? "/v1/app/messages?project=website",
			body: change.body ?? Buffer.from('{"message":"Howdy"}'),
		}), /invalid web app assertion/);
	}
});

test("rejects a replayed assertion", () => {
	const verifier = new WebAppAssertionVerifier(CONFIG, { now: () => NOW });
	const request = {
		headers: assertion(),
		method: "POST",
		path: "/v1/app/messages?project=website",
		body: Buffer.from('{"message":"Howdy"}'),
	};
	verifier.verify(request);
	assert.throws(() => verifier.verify(request), /invalid web app assertion/);
});
