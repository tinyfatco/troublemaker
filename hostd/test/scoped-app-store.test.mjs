import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ScopedAppStore,
	ScopedAppStoreError,
	scopedAppScopeKeys,
} from "../src/scoped-app-store.mjs";

const ROUTING_KEY = Buffer.alloc(32, 11);
const TARGET_ID = "example-agent";
const SCOPE_A = {
	leaseId: "6f77f5fa-9375-4341-801c-f17e7814fa70",
	accountId: "example-org-a",
	userId: "example-user-a",
	membershipId: "example-member-a",
	membershipVersion: 1,
	role: "member",
	authorizedAt: "2026-09-18T05:00:00.000Z",
	expiresAt: "2026-09-18T05:00:30.000Z",
};
const SCOPE_B = {
	...SCOPE_A,
	leaseId: "a90313c5-a6ec-42a9-a273-8e0a7711ad42",
	userId: "example-user-b",
	membershipId: "example-member-b",
};

async function fixture(options) {
	const directory = await mkdtemp(join(tmpdir(), "scoped-app-store-"));
	const store = new ScopedAppStore(join(directory, "state.sqlite"), options);
	return {
		directory,
		store,
		close: async () => {
			store.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("derives isolated opaque context custody for each user and organization", () => {
	const a = scopedAppScopeKeys(ROUTING_KEY, TARGET_ID, SCOPE_A);
	const b = scopedAppScopeKeys(ROUTING_KEY, TARGET_ID, SCOPE_B);
	const otherOrganization = scopedAppScopeKeys(ROUTING_KEY, TARGET_ID, {
		...SCOPE_A,
		accountId: "example-org-b",
	});
	assert.notEqual(a.contextId, b.contextId);
	assert.notEqual(a.contextId, otherOrganization.contextId);
	assert.notEqual(a.accountKey, otherOrganization.accountKey);
	assert.doesNotMatch(JSON.stringify(a), /example-org|example-user|example-member/);
});

test("membership versions and revocation tombstones fail closed", async () => {
	const subject = await fixture();
	try {
		const keys = scopedAppScopeKeys(ROUTING_KEY, TARGET_ID, SCOPE_A);
		assert.deepEqual(subject.store.acceptMembership(keys.accountKey, keys.membershipKey, 1), {
			accepted: true,
			membershipVersion: 1,
		});
		assert.deepEqual(subject.store.revokeMembership(keys.accountKey, keys.membershipKey, 1), {
			revoked: true,
		});
		assert.throws(
			() => subject.store.acceptMembership(keys.accountKey, keys.membershipKey, 1),
			(error) => error instanceof ScopedAppStoreError && error.code === "scope_revoked",
		);
		assert.deepEqual(subject.store.acceptMembership(keys.accountKey, keys.membershipKey, 2), {
			accepted: true,
			membershipVersion: 2,
		});
		assert.throws(
			() => subject.store.acceptMembership(keys.accountKey, keys.membershipKey, 1),
			(error) => error instanceof ScopedAppStoreError && error.code === "scope_revoked",
		);
	} finally {
		await subject.close();
	}
});

test("organization context writes are atomic compare-and-swap documents", async () => {
	const subject = await fixture();
	try {
		const keys = scopedAppScopeKeys(ROUTING_KEY, TARGET_ID, SCOPE_A);
		const initial = subject.store.readContext(keys.accountKey);
		assert.deepEqual(initial, {
			markdown: "",
			revision: 0,
			sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		});
		const written = subject.store.writeContext(keys.accountKey, "# Example organization\n", 0);
		assert.equal(written.revision, 1);
		assert.deepEqual(subject.store.readContext(keys.accountKey), written);
		assert.throws(
			() => subject.store.writeContext(keys.accountKey, "stale", 0),
			(error) => error instanceof ScopedAppStoreError && error.code === "context_revision_conflict",
		);
	} finally {
		await subject.close();
	}
});

test("request and turn replay is idempotent but conflicting reuse is rejected", async () => {
	const subject = await fixture();
	try {
		const keys = scopedAppScopeKeys(ROUTING_KEY, TARGET_ID, SCOPE_A);
		const claim = {
			requestId: "a90313c5-a6ec-42a9-a273-8e0a7711ad42",
			operation: "context.read",
			scopeKey: keys.contextId,
			body: '{"operation":"context.read"}',
		};
		assert.equal(subject.store.claimRequest(claim).claimed, true);
		const response = subject.store.completeRequest(claim.requestId, { revision: 0 });
		assert.deepEqual(response, { revision: 0 });
		assert.deepEqual(subject.store.claimRequest(claim), {
			claimed: false,
			status: "completed",
			response: { revision: 0 },
		});
		assert.throws(
			() => subject.store.claimRequest({ ...claim, body: '{"changed":true}' }),
			(error) => error instanceof ScopedAppStoreError && error.code === "request_id_conflict",
		);

		const turn = {
			contextId: keys.contextId,
			turnId: "af7c145d-c066-472b-ab05-2c63f3ebec1e",
			accountKey: keys.accountKey,
			userKey: keys.userKey,
			membershipKey: keys.membershipKey,
			membershipVersion: 1,
			text: "Help with a synthetic grant.",
			scope: SCOPE_A,
		};
		assert.equal(subject.store.startTurn(turn).duplicate, false);
		assert.equal(subject.store.startTurn(turn).duplicate, true);
		assert.throws(
			() => subject.store.startTurn({ ...turn, text: "Conflicting replay" }),
			(error) => error instanceof ScopedAppStoreError && error.code === "turn_id_conflict",
		);
		assert.deepEqual(subject.store.listEvents(keys.contextId, 0).events.map((event) => event.type), [
			"message",
			"status",
		]);
	} finally {
		await subject.close();
	}
});

test("active turn limits, bounded events, and restart recovery are durable", async () => {
	const subject = await fixture({ maximumEventsPerContext: 4, maximumActiveTurnsPerContext: 1 });
	try {
		const keys = scopedAppScopeKeys(ROUTING_KEY, TARGET_ID, SCOPE_A);
		const first = {
			contextId: keys.contextId,
			turnId: "af7c145d-c066-472b-ab05-2c63f3ebec1e",
			accountKey: keys.accountKey,
			userKey: keys.userKey,
			membershipKey: keys.membershipKey,
			membershipVersion: 1,
			text: "First",
			scope: SCOPE_A,
		};
		subject.store.startTurn(first);
		assert.throws(
			() => subject.store.startTurn({ ...first, turnId: "84e67dbd-4c0d-4885-8298-10741f03d3e0", text: "Second" }),
			(error) => error instanceof ScopedAppStoreError && error.status === 429,
		);
		subject.store.setTurnStatus(first.contextId, first.turnId, "running");
		subject.store.appendEvent(first.contextId, first.turnId, "message", "One", { role: "assistant" });
		subject.store.appendEvent(first.contextId, first.turnId, "message", "Two", { role: "assistant" });
		const recovered = subject.store.recoverInterruptedTurns();
		assert.deepEqual(recovered, [{ contextId: first.contextId, turnId: first.turnId }]);
		assert.equal(subject.store.getTurn(first.contextId, first.turnId).status, "failed");
		const events = subject.store.listEvents(first.contextId, 0).events;
		assert.equal(events.length, 4);
		assert.equal(events.at(-1).data.status, "failed");
		assert.equal(subject.store.getTurn(first.contextId, first.turnId).scopeJson, null);
	} finally {
		await subject.close();
	}
});
