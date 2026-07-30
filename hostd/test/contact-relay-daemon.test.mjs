import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contactRelayCanonical } from "../src/contact-relay.mjs";
import { InboxDaemon } from "../src/daemon.mjs";
import { ContextRouter } from "../src/router.mjs";
import { HostStore } from "../src/store.mjs";

const secret = "test-contact-relay-secret-at-least-32-bytes";
const principalEmail = "person@example.com";
const encodedLabel = "Example%20Studio";

function metadata(submissionId) {
	const signature = createHmac("sha256", secret)
		.update(contactRelayCanonical({
			submissionId,
			email: principalEmail,
			encodedLabel,
		}), "utf8")
		.digest("hex");
	return {
		from: "TinyFat <noreply@example.com>",
		to: "howdy@example.com",
		"reply-to": principalEmail,
		subject: "Website inquiry",
		"x-tinyfat-contact-version": "1",
		"x-tinyfat-contact-submission-id": submissionId,
		"x-tinyfat-contact-email": principalEmail,
		"x-tinyfat-contact-label": encodedLabel,
		"x-tinyfat-contact-signature": signature,
	};
}

test("Gmail remains canonical while repeat form submissions reuse one email-scoped context", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-contact-daemon-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const target = { id: "front-desk", driver: "oci" };
	const config = {
		gmail: {
			account: "howdy@example.com",
			internalDomains: ["internal.example.com"],
			overlapSeconds: 900,
			contactRelays: [{
				sender: "noreply@example.com",
				signatureSecret: secret,
				project: { slug: "website", name: "Customer website" },
			}],
		},
		routing: { actorTarget: "front-desk", knownPrincipals: [] },
		targetsById: new Map([["front-desk", target]]),
	};
	const router = new ContextRouter(config, store, Buffer.alloc(32, 7));
	const messages = [
		{
			id: "message-one",
			threadId: "thread-one",
			submissionId: "123e4567-e89b-42d3-a456-426614174000",
		},
		{
			id: "message-two",
			threadId: "thread-two",
			submissionId: "123e4567-e89b-42d3-a456-426614174001",
		},
	];
	const markedRead = [];
	const gmail = {
		async searchMessages() {
			return messages.map(({ id, threadId }) => ({ id, threadId }));
		},
		async getMetadata(messageId) {
			const message = messages.find((candidate) => candidate.id === messageId);
			return metadata(message.submissionId);
		},
		async getThread(threadId) {
			return [{
				id: messages.find((candidate) => candidate.threadId === threadId).id,
				from: "noreply@example.com",
				to: "howdy@example.com",
				replyTo: principalEmail,
				subject: "Website inquiry",
				body: "Please help with our website.",
			}];
		},
		async markRead(messageId) {
			markedRead.push(messageId);
		},
	};
	store.setMeta("gmail:last_successful_poll_at", "2026-07-24T12:00:00.000Z");
	const daemon = new InboxDaemon({ config, store, gmail, router });

	try {
		const result = await daemon.pollOnce();
		assert.equal(result.queued, 2);
		assert.deepEqual(markedRead.sort(), ["message-one", "message-two"]);
		const first = store.getEventByProviderMessage("gmail", "message-one");
		const second = store.getEventByProviderMessage("gmail", "message-two");
		assert.equal(first.contextId, second.contextId);
		assert.match(first.contextId, /^front-desk:[a-f0-9]{24}:website$/);
		const payload = JSON.parse(first.payloadJson);
		assert.equal(payload.sender, principalEmail);
		assert.equal(payload.relay.submissionId, messages[0].submissionId);
		assert.equal(store.getPrincipal(first.principalHash).displayLabel, "Example Studio");
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
