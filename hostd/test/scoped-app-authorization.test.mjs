import assert from "node:assert/strict";
import test from "node:test";
import {
	bearerCapability,
	renewScopedAppScope,
	ScopedAppAuthorizationError,
} from "../src/scoped-app-authorization.mjs";

const NOW = Date.parse("2026-09-18T05:00:15.000Z");
const SCOPE = {
	leaseId: "6f77f5fa-9375-4341-801c-f17e7814fa70",
	accountId: "synthetic-org-a",
	userId: "synthetic-user-a",
	membershipId: "synthetic-member-a",
	membershipVersion: 1,
	role: "member",
	authorizedAt: "2026-09-18T05:00:00.000Z",
	expiresAt: "2026-09-18T05:00:30.000Z",
};
const CONFIG = {
	renewalUrl: "https://app.example.com/api/internal/hostd/lease/renew",
	renewalToken: "example-renewal-capability-at-least-32-bytes",
};

function response(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("recognizes dispatch and revoke capabilities without prefix acceptance", () => {
	const candidates = {
		dispatch: "example-dispatch-capability-at-least-32-bytes",
		revoke: "example-revoke-capability-at-least-32-bytes",
	};
	assert.equal(bearerCapability({ headers: { authorization: `Bearer ${candidates.dispatch}` } }, candidates), "dispatch");
	assert.equal(bearerCapability({ headers: { authorization: `Bearer ${candidates.revoke}` } }, candidates), "revoke");
	assert.equal(bearerCapability({ headers: { authorization: `Bearer ${candidates.revoke}x` } }, candidates), null);
	assert.equal(bearerCapability({ headers: { authorization: candidates.dispatch } }, candidates), null);
});

test("renews through the one fixed callback and preserves exact scope identity", async () => {
	let observed;
	const renewed = await renewScopedAppScope(CONFIG, SCOPE, {
		now: NOW,
		fetchImpl: async (url, options) => {
			observed = { url, options };
			return response({
				version: "vectors.v1",
				scope: {
					...SCOPE,
					authorizedAt: "2026-09-18T05:00:15.000Z",
					expiresAt: "2026-09-18T05:00:45.000Z",
				},
			});
		},
	});
	assert.equal(observed.url, CONFIG.renewalUrl);
	assert.equal(observed.options.redirect, "error");
	assert.equal(observed.options.authorization, undefined);
	assert.equal(observed.options.headers.authorization, `Bearer ${CONFIG.renewalToken}`);
	assert.deepEqual(JSON.parse(observed.options.body), { version: "vectors.v1", scope: SCOPE });
	assert.equal(renewed.leaseId, SCOPE.leaseId);
	assert.equal(renewed.expiresAt, "2026-09-18T05:00:45.000Z");
});

test("fails closed for rejection, mismatch, regression, and malformed responses", async () => {
	const cases = [
		async () => response({ error: "revoked" }, 403),
		async () => response({ version: "vectors.v1", scope: {
			...SCOPE,
			leaseId: "a90313c5-a6ec-42a9-a273-8e0a7711ad42",
			authorizedAt: "2026-09-18T05:00:15.000Z",
			expiresAt: "2026-09-18T05:00:45.000Z",
		} }),
		async () => response({ version: "vectors.v1", scope: {
			...SCOPE,
			authorizedAt: "2026-09-18T04:59:59.000Z",
			expiresAt: "2026-09-18T05:00:29.000Z",
		} }),
		async () => new Response("not-json", { status: 200 }),
	];
	for (const fetchImpl of cases) {
		await assert.rejects(
			renewScopedAppScope(CONFIG, SCOPE, { now: NOW, fetchImpl }),
			(error) => error instanceof ScopedAppAuthorizationError,
		);
	}
});
