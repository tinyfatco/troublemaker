import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
