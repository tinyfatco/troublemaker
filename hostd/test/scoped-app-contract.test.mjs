import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	scopedAppContextDocument,
	ScopedAppContractError,
	validateScopedAppContextDocument,
	validateScopedAppEnvelope,
	validateScopedAppRenewal,
} from "../src/scoped-app-contract.mjs";

const fixture = JSON.parse(await readFile(
	new URL("./fixtures/scoped-app-v1.json", import.meta.url),
	"utf8",
));
const NOW = Date.parse("2026-09-18T05:00:15.000Z");

function clone(value) {
	return structuredClone(value);
}

function invalid(value, now = NOW) {
	assert.throws(
		() => validateScopedAppEnvelope(value, { now }),
		(error) => error instanceof ScopedAppContractError && error.code === "invalid",
	);
}

test("accepts the exact synthetic dispatch and renewal fixtures", () => {
	const send = validateScopedAppEnvelope(fixture.requests.send, { now: NOW });
	assert.equal(send.version, "vectors.v1");
	assert.equal(send.operation, "chat.send");
	assert.equal(send.scope.accountId, "synthetic-org-a");
	assert.equal(send.payload.turnId, fixture.requests.send.payload.turnId);

	const contextWrite = validateScopedAppEnvelope(fixture.requests.contextWrite, { now: NOW });
	assert.equal(contextWrite.operation, "context.write");
	assert.equal(contextWrite.payload.expectedRevision, 0);

	assert.deepEqual(
		validateScopedAppRenewal(fixture.requests.renew, { now: NOW }),
		fixture.requests.renew,
	);
});

test("rejects unknown fields, malformed scope, and lease expiry", () => {
	const extra = clone(fixture.requests.send);
	extra.scope.sessionToken = "must-not-cross-the-bridge";
	invalid(extra);

	const unknown = clone(fixture.requests.send);
	unknown.payload.extra = true;
	invalid(unknown);

	const wrongVersion = clone(fixture.requests.send);
	wrongVersion.version = "vectors.v2";
	invalid(wrongVersion);

	const badId = clone(fixture.requests.send);
	badId.scope.accountId = "../other-org";
	invalid(badId);

	invalid(fixture.requests.send, Date.parse("2026-09-18T05:00:30.000Z"));

	const longLease = clone(fixture.requests.send);
	longLease.scope.expiresAt = "2026-09-18T05:00:31.000Z";
	invalid(longLease);
});

test("enforces operation-specific constraints and exact UTF-8 context bounds", () => {
	const unreviewed = clone(fixture.requests.contextWrite);
	unreviewed.payload.reviewed = false;
	invalid(unreviewed);

	const oversize = clone(fixture.requests.contextWrite);
	oversize.payload.markdown = "é".repeat(32_769);
	invalid(oversize);

	const forgedCancel = clone(fixture.requests.send);
	forgedCancel.operation = "chat.cancel";
	invalid(forgedCancel);

	const revoke = clone(fixture.requests.send);
	revoke.operation = "scope.revoke";
	revoke.payload = { membershipId: "synthetic-member-b", membershipVersion: 7 };
	assert.equal(validateScopedAppEnvelope(revoke, { now: NOW }).operation, "scope.revoke");
});

test("context documents use exact UTF-8 bytes and reject mismatched receipts", () => {
	const document = scopedAppContextDocument("# Example\n", 3);
	assert.equal(document.revision, 3);
	assert.match(document.sha256, /^[a-f0-9]{64}$/);
	assert.deepEqual(validateScopedAppContextDocument(document), document);
	assert.throws(
		() => validateScopedAppContextDocument({ ...document, markdown: "changed" }),
		ScopedAppContractError,
	);
	assert.deepEqual(
		scopedAppContextDocument("", 0),
		fixture.responses.context,
	);
});
