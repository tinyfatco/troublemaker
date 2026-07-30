import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InboxDaemon } from "../src/daemon.mjs";
import { ContextRouter } from "../src/router.mjs";
import { HostStore } from "../src/store.mjs";

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-gmail-envelope-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const target = { id: "front-desk", driver: "oci" };
	const config = {
		gmail: {
			account: "howdy@inbox.example.com",
			internalDomains: ["internal.example.com"],
			overlapSeconds: 900,
			contactRelays: [],
		},
		routing: { actorTarget: "front-desk", knownPrincipals: [] },
		targetsById: new Map([["front-desk", target]]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 7));
	const markedRead = [];
	let current = [];
	let threadReads = 0;
	const gmail = {
		async searchMessages() {
			return current.toReversed().map(({ id, threadId }) => ({ id, threadId }));
		},
		async getMetadata(messageId) {
			return current.find((message) => message.id === messageId).metadata;
		},
		async getThread(threadId) {
			threadReads++;
			return current
				.filter((message) => message.threadId === threadId)
				.map((message) => ({
					id: message.id,
					...message.metadata,
					body: message.body || "",
				}));
		},
		async markRead(messageId) {
			markedRead.push(messageId);
		},
	};
	store.setMeta("gmail:last_successful_poll_at", "2026-07-24T12:00:00.000Z");
	const daemon = new InboxDaemon({ config, store, gmail, router });
	return {
		store,
		markedRead,
		get threadReads() {
			return threadReads;
		},
		async poll(messages) {
			current = messages;
			return daemon.pollOnce();
		},
		close() {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function disposition(store, messageId) {
	return store.database.prepare(`
		SELECT disposition FROM seen_messages
		WHERE source = 'gmail' AND provider_message_id = ?
	`).get(messageId)?.disposition;
}

function count(store, table) {
	return store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test("routes direct and internal-origin Gmail to the one external envelope participant", async () => {
	const subject = fixture();
	try {
		const messages = [
			{
				id: "direct-message",
				threadId: "direct-thread",
				metadata: {
					from: "Example Customer <customer@example.com>",
					to: "Howdy <howdy@inbox.example.com>",
					cc: "Support <support@internal.example.com>",
					subject: "Website help",
				},
				body: "Quoted text mentions unrelated@external.example.com but is not routing input.",
			},
			{
				id: "internal-origin-message",
				threadId: "internal-origin-thread",
				metadata: {
					from: "Owner <owner@internal.example.com>",
					to: "customer@example.com, howdy@inbox.example.com",
					cc: "Support <support@internal.example.com>",
					subject: "A direct introduction",
				},
			},
		];
		const result = await subject.poll(messages);

		assert.equal(result.queued, 2);
		assert.equal(result.quarantined, 0);
		assert.deepEqual(subject.markedRead, ["direct-message", "internal-origin-message"]);
		const direct = subject.store.getEventByProviderMessage("gmail", "direct-message");
		const internal = subject.store.getEventByProviderMessage("gmail", "internal-origin-message");
		assert.equal(direct.contextId, internal.contextId);
		assert.equal(JSON.parse(direct.payloadJson).sender, "customer@example.com");
		assert.equal(JSON.parse(internal.payloadJson).sender, "customer@example.com");
		assert.equal(subject.store.getPrincipal(direct.principalHash).emailAddress, "customer@example.com");
	} finally {
		subject.close();
	}
});

test("quarantines zero or multiple external envelope participants before creating routing state", async () => {
	const subject = fixture();
	try {
		const result = await subject.poll([
			{
				id: "no-external-message",
				threadId: "no-external-thread",
				metadata: {
					from: "\"Decoy customer@example.com\" <owner@internal.example.com>",
					to: "howdy@inbox.example.com",
					subject: "Internal note",
				},
				body: "Body-only address customer@example.com must not become identity.",
			},
			{
				id: "multiple-external-message",
				threadId: "multiple-external-thread",
				metadata: {
					from: "one@example.com",
					to: "howdy@inbox.example.com",
					cc: "two@external.example.com",
					subject: "Ambiguous participants",
				},
			},
			{
				id: "invalid-envelope-message",
				threadId: "invalid-envelope-thread",
				metadata: {
					from: "Broken <one@example.com",
					to: "howdy@inbox.example.com",
					subject: "Malformed participant",
				},
			},
		]);

		assert.equal(result.queued, 0);
		assert.equal(result.quarantined, 3);
		assert.deepEqual(subject.markedRead, []);
		assert.equal(subject.threadReads, 0);
		assert.equal(disposition(subject.store, "no-external-message"), "quarantined:gmail_external_participant_missing");
		assert.equal(disposition(subject.store, "multiple-external-message"), "quarantined:gmail_external_participant_ambiguous");
		assert.equal(disposition(subject.store, "invalid-envelope-message"), "quarantined:gmail_external_participant_invalid");
		for (const table of ["principals", "projects", "routes", "route_participants", "events"]) {
			assert.equal(count(subject.store, table), 0, `${table} must remain empty`);
		}
	} finally {
		subject.close();
	}
});

test("preserves thread affinity for an internal reply and denies an unbound external sender", async () => {
	const subject = fixture();
	const first = {
		id: "owner-message",
		threadId: "bound-thread",
		metadata: {
			from: "owner@example.com",
			to: "howdy@inbox.example.com",
			subject: "Please help",
		},
	};
	const internalReply = {
		id: "internal-reply",
		threadId: "bound-thread",
		metadata: {
			from: "support@internal.example.com",
			to: "owner@example.com, howdy@inbox.example.com",
			subject: "Re: Please help",
		},
	};
	const stranger = {
		id: "unbound-sender",
		threadId: "bound-thread",
		metadata: {
			from: "stranger@external.example.com",
			to: "howdy@inbox.example.com",
			subject: "Re: Please help",
		},
	};
	try {
		assert.equal((await subject.poll([first])).queued, 1);
		assert.equal((await subject.poll([first, internalReply])).queued, 1);
		const result = await subject.poll([first, internalReply, stranger]);

		assert.equal(result.queued, 0);
		assert.equal(result.quarantined, 1);
		assert.deepEqual(subject.markedRead, ["owner-message", "internal-reply"]);
		assert.equal(disposition(subject.store, "unbound-sender"), "quarantined:route_participant_denied");
		assert.equal(count(subject.store, "principals"), 1);
		assert.equal(count(subject.store, "routes"), 1);
		assert.equal(count(subject.store, "events"), 2);
		const ownerEvent = subject.store.getEventByProviderMessage("gmail", "owner-message");
		const replyEvent = subject.store.getEventByProviderMessage("gmail", "internal-reply");
		assert.equal(ownerEvent.contextId, replyEvent.contextId);
		assert.equal(JSON.parse(replyEvent.payloadJson).sender, "owner@example.com");
	} finally {
		subject.close();
	}
});
