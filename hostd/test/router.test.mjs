import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextRouter } from "../src/router.mjs";
import { HostStore } from "../src/store.mjs";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-router-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const target = { id: "front-desk", driver: "oci" };
	const config = {
		routing: { actorTarget: "front-desk", knownPrincipals: [] },
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

		const rebound = subject.router.bindProject({
			source: "gmail",
			threadId: "thread-a",
			principalHash: first.principalHash,
			projectSlug: "company-website",
			projectName: "Company website",
		});
		assert.equal(rebound.projectSlug, "intake");
		assert.equal(rebound.nextProjectSlug, "company-website");
		assert.match(rebound.nextContextId, /:company-website$/);

		const existingThread = subject.router.resolve({
			source: "gmail",
			threadId: "thread-a",
			sender: "one@example.com",
		});
		assert.equal(existingThread.projectSlug, "company-website");
		assert.equal(existingThread.contextId, rebound.nextContextId);

		const futureThread = subject.router.resolve({
			source: "gmail",
			threadId: "thread-d",
			sender: "one@example.com",
		});
		assert.equal(futureThread.contextId, rebound.nextContextId);
	} finally {
		subject.close();
	}
});

test("a context cannot bind another principal's thread", () => {
	const subject = fixture();
	try {
		const one = subject.router.resolve({
			source: "gmail",
			threadId: "thread-one",
			sender: "one@example.com",
		});
		const two = subject.router.resolve({
			source: "gmail",
			threadId: "thread-two",
			sender: "two@example.com",
		});
		assert.throws(() => subject.router.bindProject({
			source: "gmail",
			threadId: "thread-two",
			principalHash: one.principalHash,
			projectSlug: "stolen",
		}), /does not belong/);
		assert.notEqual(one.principalHash, two.principalHash);
	} finally {
		subject.close();
	}
});
