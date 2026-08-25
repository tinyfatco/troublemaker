import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { relationshipOperatorContextId } from "../src/relationship-context.mjs";
import { ContextRouter } from "../src/router.mjs";
import { HostStore } from "../src/store.mjs";

function fixture(knownPrincipals = []) {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-router-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const target = { id: "front-desk", driver: "oci" };
	const config = {
		routing: { actorTarget: "front-desk", knownPrincipals },
		targetsById: new Map([["front-desk", target]]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 7));
	return {
		store,
		router,
		close() {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

test("relationship Operator identity partitions target, thread, and principal", () => {
	const routingKey = Buffer.alloc(32, 7);
	const base = {
		targetId: "front-desk",
		source: "phone",
		providerThreadId: "native-thread-one",
		principalHash: "principal-one",
		projectSlug: "intake",
	};
	const first = relationshipOperatorContextId(routingKey, base);
	assert.notEqual(first, relationshipOperatorContextId(routingKey, {
		...base,
		targetId: "another-customer",
	}));
	assert.notEqual(first, relationshipOperatorContextId(routingKey, {
		...base,
		providerThreadId: "native-thread-two",
	}));
	assert.notEqual(first, relationshipOperatorContextId(routingKey, {
		...base,
		principalHash: "principal-two",
	}));
	assert.equal(first.includes(base.providerThreadId), false);
	assert.match(first, /^front-desk:[a-f0-9]{24}:relationship-operator$/);
});

test("routes each sender to a private context and keeps native thread affinity", () => {
	const subject = fixture();
	try {
		const first = subject.router.resolve({
			source: "gmail",
			threadId: "thread-a",
			sender: "one@example.com",
		});
		const samePrincipal = subject.router.resolve({
			source: "gmail",
			threadId: "thread-b",
			sender: "ONE@example.com",
		});
		const otherPrincipal = subject.router.resolve({
			source: "gmail",
			threadId: "thread-c",
			sender: "two@example.com",
		});

		assert.equal(first.contextId, samePrincipal.contextId);
		assert.notEqual(first.principalHash, otherPrincipal.principalHash);
		assert.notEqual(first.contextId, otherPrincipal.contextId);
		assert.match(first.contextId, /^front-desk:[a-f0-9]{24}:intake$/);

		const existingThread = subject.router.resolve({
			source: "gmail",
			threadId: "thread-a",
			sender: "one@example.com",
		});
		assert.equal(existingThread.contextId, first.contextId);
	} finally {
		subject.close();
	}
});

test("routes each verified phone relationship to its own Operator context", () => {
	const subject = fixture();
	try {
		const first = subject.router.resolvePhone({
			providerThreadId: "phone-thread-one",
			contactAddress: "+15555550123",
		});
		const repeat = subject.router.resolvePhone({
			providerThreadId: "phone-thread-one",
			contactAddress: "+15555550123",
		});
		const secondRelationship = subject.router.resolvePhone({
			providerThreadId: "phone-thread-two",
			contactAddress: "+15555550123",
		});

		assert.equal(repeat.contextId, first.contextId);
		assert.notEqual(secondRelationship.contextId, first.contextId);
		assert.match(first.contextId, /^front-desk:[a-f0-9]{24}:relationship-operator$/);
		assert.match(secondRelationship.contextId, /^front-desk:[a-f0-9]{24}:relationship-operator$/);
	} finally {
		subject.close();
	}
});

test("the shared phone routes each known human to that human's named agent target", () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-phone-agent-router-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const config = {
		routing: {
			actorTarget: "front-desk",
			knownPrincipals: [],
			knownPhonePrincipals: [{ phone: "+15555550123", targetId: "scout" }],
		},
		targetsById: new Map([
			["front-desk", { id: "front-desk", driver: "oci" }],
			["scout", { id: "scout", driver: "oci" }],
		]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 7));
	try {
		const known = router.resolvePhone({
			providerThreadId: "known-human-thread",
			contactAddress: "+15555550123",
		});
		const unknown = router.resolvePhone({
			providerThreadId: "unknown-human-thread",
			contactAddress: "+15555550999",
		});
		assert.equal(known.targetId, "scout");
		assert.match(known.contextId, /^scout:/);
		assert.equal(unknown.targetId, "front-desk");
		assert.match(unknown.contextId, /^front-desk:/);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("fails closed instead of reusing a legacy phone intake context", () => {
	const subject = fixture();
	try {
		const scope = subject.router.ensurePhoneScope("+15555550123", {
			providerThreadId: "legacy-phone-thread",
		});
		subject.store.bindRoute({
			source: "phone",
			providerThreadId: "legacy-phone-thread",
			principalHash: scope.principalHash,
			projectSlug: scope.projectSlug,
			targetId: scope.targetId,
			contextId: "front-desk:legacy-principal:intake",
		});
		assert.throws(
			() => subject.router.resolvePhone({
				providerThreadId: "legacy-phone-thread",
				contactAddress: "+15555550123",
			}),
			(error) => error?.code === "relationship_context_migration_required",
		);
	} finally {
		subject.close();
	}
});

test("trusted relay project and label create one reusable email-scoped website context", () => {
	const subject = fixture();
	try {
		const first = subject.router.resolve({
			source: "gmail",
			threadId: "form-thread-one",
			sender: "owner@example.com",
			label: "Owner Studio",
			project: { slug: "website", name: "Customer website" },
		});
		const repeat = subject.router.resolve({
			source: "gmail",
			threadId: "form-thread-two",
			sender: "OWNER@example.com",
			label: "Changed label is ignored",
			project: { slug: "website", name: "Customer website" },
		});

		assert.equal(first.projectSlug, "website");
		assert.equal(first.contextId, repeat.contextId);
		assert.match(first.contextId, /:website$/);
		assert.equal(subject.store.getPrincipal(first.principalHash).displayLabel, "Owner Studio");
	} finally {
		subject.close();
	}
});

test("selects a project only when the control plane has one exact choice", () => {
	const subject = fixture([
		{
			email: "one@example.com",
			projects: [{ slug: "company-website", name: "Company website" }],
		},
		{
			email: "many@example.com",
			projects: [
				{ slug: "site-one", name: "Site one" },
				{ slug: "site-two", name: "Site two" },
			],
		},
	]);
	try {
		const one = subject.router.resolve({
			source: "gmail",
			threadId: "thread-one",
			sender: "one@example.com",
		});
		assert.equal(one.projectSlug, "company-website");
		assert.match(one.contextId, /:company-website$/);

		const ambiguous = subject.router.resolve({
			source: "gmail",
			threadId: "thread-many",
			sender: "many@example.com",
		});
		assert.equal(ambiguous.projectSlug, "intake");
		assert.match(ambiguous.contextId, /:intake$/);
	} finally {
		subject.close();
	}
});

test("materializes configured customer scopes before their first inbound message", () => {
	const subject = fixture([
		{
			email: "studio@example.com",
			name: "Example Dance Academy",
			projects: [{ slug: "website", name: "Customer website" }],
		},
		{
			email: "ambiguous@example.com",
			projects: [
				{ slug: "site-one", name: "Site one" },
				{ slug: "site-two", name: "Site two" },
			],
		},
	]);
	try {
		const scopes = subject.router.ensureKnownPrincipalScopes();
		assert.equal(scopes[0].name, "Example Dance Academy");
		assert.match(scopes[0].contextId, /^front-desk:[a-f0-9]{24}:website$/);
		assert.match(scopes[1].contextId, /^front-desk:[a-f0-9]{24}:intake$/);

		const routed = subject.router.resolve({
			source: "gmail",
			threadId: "future-reply",
			sender: "studio@example.com",
		});
		assert.equal(routed.contextId, scopes[0].contextId);
	} finally {
		subject.close();
	}
});

test("fails closed when an unbound sender appears on an existing native thread", () => {
	const subject = fixture();
	try {
		const owner = subject.router.resolve({
			source: "gmail",
			threadId: "thread-sensitive",
			sender: "owner@example.com",
		});
		assert.throws(
			() => subject.router.resolve({
				source: "gmail",
				threadId: "thread-sensitive",
				sender: "stranger@example.com",
			}),
			(error) => error?.code === "route_participant_denied",
		);
		assert.equal(
			subject.store.getRoute("gmail", "thread-sensitive").contextId,
			owner.contextId,
			"a denied sender cannot rebind the native thread",
		);
	} finally {
		subject.close();
	}
});
