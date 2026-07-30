import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ContextRouter } from "../src/router.mjs";
import { createHostServer } from "../src/server.mjs";
import { contextCapability } from "../src/security.mjs";
import { HostStore } from "../src/store.mjs";

function message(id, from, to, subject, body, replyTo = "", cc = "") {
	return { id, date: "Thu, 23 Jul 2026 12:00:00 +0000", from, to, cc, bcc: "", replyTo, subject, body };
}

function fakeGmail() {
	const threads = new Map([
		["thread-owner", [message(
			"message-owner",
			"noreply@example.com",
			"agent@example.com, collaborator@example.com",
			"Owner request",
			"Hello",
			"owner@example.com",
			"reviewer@example.com",
		)]],
		["thread-stranger", [message("message-stranger", "stranger@example.com", "agent@example.com", "Other request", "Private")]],
		["thread-unbound", [message(
			"message-unbound",
			"agent@example.com",
			"owner@example.com",
			"Earlier note",
			"Earlier",
			"",
			"archive@example.com",
		)]],
		["thread-group", [message("message-group", "owner@example.com", "agent@example.com, third@example.com", "Group note", "Group")]],
	]);
	const drafts = new Map();
	const created = [];
	const updated = [];
	const sent = [];
	const uncertainSends = new Set();
	const direct = [];
	return {
		threads,
		drafts,
		created,
		updated,
		sent,
		uncertainSends,
		direct,
		searchThreads() {
			return [
				{ id: "thread-owner", date: "2026-07-23", from: "owner@example.com", subject: "Owner request", messageCount: 1 },
				{ id: "thread-stranger", date: "2026-07-23", from: "stranger@example.com", subject: "Other request", messageCount: 1 },
				{ id: "thread-unbound", date: "2026-07-22", from: "agent@example.com", subject: "Earlier note", messageCount: 1 },
				{ id: "thread-group", date: "2026-07-21", from: "owner@example.com", subject: "Group note", messageCount: 1 },
			];
		},
		getThread(threadId) {
			const thread = threads.get(threadId);
			if (!thread) throw new Error("missing fake thread");
			return thread;
		},
		createDraft(input) {
			created.push(input);
			const number = created.length;
			const draftId = `draft-${number}`;
			const threadId = input.replyToMessageId === "message-owner" ? "thread-owner" : `compose-thread-${number}`;
			drafts.set(draftId, {
				draftId,
				messageId: `draft-message-${number}`,
				threadId,
				to: [...input.to],
				cc: [...(input.cc || [])],
				bcc: [],
				replyTo: [],
				subject: input.subject,
				body: input.body,
				hasAttachments: false,
			});
			return { draftId, messageId: `draft-message-${number}`, threadId };
		},
		updateDraft(draftId, input) {
			updated.push({ draftId, ...input });
			const current = drafts.get(draftId);
			if (!current) throw new Error("missing fake draft");
			Object.assign(current, {
				to: [...input.to],
				cc: [...(input.cc || [])],
				subject: input.subject,
				body: input.body,
			});
			return { draftId, messageId: current.messageId, threadId: current.threadId };
		},
		getDraft(draftId) {
			const draft = drafts.get(draftId);
			if (!draft) throw new Error("missing fake draft");
			return { ...draft, to: [...draft.to], cc: [...draft.cc], bcc: [...draft.bcc], replyTo: [...draft.replyTo] };
		},
		deleteDraft(draftId) {
			drafts.delete(draftId);
		},
		sendDraft(draftId) {
			const draft = drafts.get(draftId);
			if (!draft) throw new Error("missing fake draft");
			sent.push(draftId);
			if (uncertainSends.has(draftId)) throw new Error("ambiguous provider result");
			return { messageId: `sent-${sent.length}`, threadId: draft.threadId };
		},
		sendThreadReply(threadId, subject, body) {
			direct.push({ threadId, subject, body });
			return { messageId: `direct-${direct.length}` };
		},
	};
}

async function listen(server) {
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
}

async function post(base, path, token, body) {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
	return { response, body: await response.json() };
}

test("Gmail tools keep search, read, draft, and send inside one verified context", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-gmail-tools-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const routingKey = Buffer.alloc(32, 7);
	const target = {
		id: "front-desk",
		driver: "oci",
		inboundToken: "fake-inbound-secret",
		outboundToken: "fake-outbound-secret",
		gmailToolsOnly: true,
	};
	const config = {
		server: {},
		gmail: {
			account: "agent@example.com",
			alwaysTo: ["operator@example.com"],
			alwaysCc: ["archive@example.com"],
		},
		mattermost: {},
		routing: { actorTarget: "front-desk", knownPrincipals: [] },
		targetsById: new Map([["front-desk", target]]),
	};
	const router = new ContextRouter(config, store, routingKey);
	const owner = router.resolve({ source: "gmail", threadId: "thread-owner", sender: "owner@example.com" });
	const stranger = router.resolve({ source: "gmail", threadId: "thread-stranger", sender: "stranger@example.com" });
	const gmail = fakeGmail();
	const server = createHostServer({ config, store, gmail, daemon: { polling: false }, routingKey });
	const base = await listen(server);
	const ownerToken = contextCapability(target.outboundToken, "outbound", owner.contextId);

	try {
		const unauthorized = await post(base, "/v1/gmail/search", "wrong", {
			context_id: owner.contextId,
			query: "newer_than:30d",
		});
		assert.equal(unauthorized.response.status, 401);

		const searched = await post(base, "/v1/gmail/search", ownerToken, {
			context_id: owner.contextId,
			query: "newer_than:30d",
			limit: 10,
		});
		assert.equal(searched.response.status, 200);
		assert.deepEqual(searched.body.threads.map((entry) => entry.thread_id), ["thread-owner", "thread-unbound"]);

		const crossRead = await post(base, "/v1/gmail/read", ownerToken, {
			context_id: owner.contextId,
			thread_id: stranger.providerThreadId,
		});
		assert.equal(crossRead.response.status, 403);
		assert.equal(crossRead.body.error, "conversation_scope_denied");

		const read = await post(base, "/v1/gmail/read", ownerToken, {
			context_id: owner.contextId,
			thread_id: "thread-unbound",
		});
		assert.equal(read.response.status, 200);
		assert.equal(read.body.messages[0].body, "Earlier");

		const direct = await post(base, "/v1/outbound/gmail", ownerToken, {
			context_id: owner.contextId,
			provider_thread_id: owner.providerThreadId,
			subject: "Re: Owner request",
			agent_body: "Bypass",
		});
		assert.equal(direct.response.status, 409);
		assert.equal(direct.body.error, "gmail_draft_required");
		assert.equal(gmail.direct.length, 0);

		const wrongContact = await post(base, "/v1/gmail/draft", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "wrong-contact",
			to: "stranger@example.com",
			subject: "Hello",
			body: "Not allowed",
		});
		assert.equal(wrongContact.response.status, 403);
		assert.equal(gmail.created.length, 0);

		const created = await post(base, "/v1/gmail/draft", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "compose-one",
			to: "owner@example.com",
			subject: "Requested follow-up",
			body: "First body",
		});
		assert.equal(created.response.status, 200);
		assert.deepEqual(created.body, {
			ok: true,
			status: "draft",
			draft_id: "draft-1",
			thread_id: "compose-thread-1",
		});
		assert.equal(gmail.created.length, 1);

		const createDuplicate = await post(base, "/v1/gmail/draft", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "compose-one",
			to: "owner@example.com",
			subject: "Requested follow-up",
			body: "Different retry body",
		});
		assert.equal(createDuplicate.response.status, 200);
		assert.equal(createDuplicate.body.duplicate, true);
		assert.equal(gmail.created.length, 1);

		const mutableAddress = await post(base, "/v1/gmail/draft", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "bad-update",
			draft_id: "draft-1",
			subject: "Changed",
			body: "Second body",
		});
		assert.equal(mutableAddress.response.status, 400);
		assert.equal(mutableAddress.body.error, "draft_update_body_only");

		const updated = await post(base, "/v1/gmail/draft", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "update-one",
			draft_id: "draft-1",
			body: "Second body",
		});
		assert.equal(updated.response.status, 200);
		assert.equal(gmail.updated.length, 1);
		assert.deepEqual(gmail.updated[0].to, ["owner@example.com", "operator@example.com"]);
		assert.deepEqual(gmail.updated[0].cc, ["archive@example.com"]);
		assert.equal(gmail.updated[0].subject, "Requested follow-up");

		gmail.drafts.get("draft-1").cc = ["third@example.com"];
		const tampered = await post(base, "/v1/gmail/send", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "send-tampered",
			draft_id: "draft-1",
		});
		assert.equal(tampered.response.status, 409);
		assert.equal(tampered.body.error, "draft_binding_changed");
		assert.equal(gmail.sent.length, 0);
		gmail.drafts.get("draft-1").cc = ["archive@example.com"];
		gmail.drafts.get("draft-1").to = ["owner@example.com"];
		const missingOwner = await post(base, "/v1/gmail/send", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "send-missing-owner",
			draft_id: "draft-1",
		});
		assert.equal(missingOwner.response.status, 409);
		assert.equal(missingOwner.body.error, "draft_binding_changed");
		assert.equal(gmail.sent.length, 0);
		gmail.drafts.get("draft-1").to = ["owner@example.com", "operator@example.com"];

		const sent = await post(base, "/v1/gmail/send", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "send-one",
			draft_id: "draft-1",
		});
		assert.equal(sent.response.status, 200);
		assert.deepEqual(sent.body, {
			ok: true,
			status: "sent",
			draft_id: "draft-1",
			message_id: "sent-1",
			thread_id: "compose-thread-1",
		});
		assert.equal(gmail.sent.length, 1);
		const ledgerEvent = store.getEventByProviderMessage("gmail_outbound", "sent-1");
		assert(ledgerEvent, "a successful provider send creates one outbound ledger event");
		assert.equal(ledgerEvent.status, "completed", "the ledger event never becomes agent work");
		assert.equal(ledgerEvent.contextId, owner.contextId);
		assert.equal(ledgerEvent.providerThreadId, "compose-thread-1");
		assert.deepEqual(JSON.parse(ledgerEvent.payloadJson), {
			direction: "outbound",
			sender: "agent@example.com",
			recipient: "owner@example.com",
			metadata: { subject: "Requested follow-up" },
			route: { projectSlug: "intake" },
			message: {
				id: "sent-1",
				threadId: "compose-thread-1",
				body: "Second body",
			},
		});
		const ledgerNotification = store.getControlNotification("gmail_outbound:sent-1");
		assert.equal(ledgerNotification?.status, "queued");
		assert.equal(ledgerNotification?.contextId, owner.contextId);

		const sentAgain = await post(base, "/v1/gmail/send", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "send-two",
			draft_id: "draft-1",
		});
		assert.equal(sentAgain.response.status, 200);
		assert.equal(sentAgain.body.duplicate, true);
		assert.equal(gmail.sent.length, 1);
		assert.equal(
			store.database.prepare("SELECT COUNT(*) AS count FROM events WHERE source = 'gmail_outbound'").get().count,
			1,
		);
		assert.equal(
			store.database.prepare("SELECT COUNT(*) AS count FROM control_notifications").get().count,
			1,
		);

		const crossReplyDraft = await post(base, "/v1/gmail/draft", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "cross-reply",
			thread_id: stranger.providerThreadId,
			body: "Nope",
		});
		assert.equal(crossReplyDraft.response.status, 403);

		const replyDraft = await post(base, "/v1/gmail/draft", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "reply-one",
			thread_id: owner.providerThreadId,
			body: "Reply body",
		});
		assert.equal(replyDraft.response.status, 200);
		assert.equal(replyDraft.body.thread_id, "thread-owner");
		assert.deepEqual(gmail.created[1], {
			to: ["owner@example.com", "operator@example.com"],
			cc: ["archive@example.com", "collaborator@example.com", "reviewer@example.com"],
			subject: "Re: Owner request",
			body: "Reply body",
			replyToMessageId: "message-owner",
		});
		assert.deepEqual(store.getGmailDraft("draft-2").ccAddresses, [
			"archive@example.com",
			"collaborator@example.com",
			"reviewer@example.com",
		]);
		assert.deepEqual(store.getGmailDraft("draft-2").toAddresses, [
			"owner@example.com",
			"operator@example.com",
		]);

		gmail.uncertainSends.add("draft-2");
		const uncertain = await post(base, "/v1/gmail/send", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "send-uncertain",
			draft_id: "draft-2",
		});
		assert.equal(uncertain.response.status, 500);
		assert.equal(gmail.sent.filter((draftId) => draftId === "draft-2").length, 1);

		const uncertainRetry = await post(base, "/v1/gmail/send", ownerToken, {
			context_id: owner.contextId,
			idempotency_key: "send-uncertain-retry",
			draft_id: "draft-2",
		});
		assert.equal(uncertainRetry.response.status, 409);
		assert.equal(uncertainRetry.body.error, "draft_send_unresolved");
		assert.equal(gmail.sent.filter((draftId) => draftId === "draft-2").length, 1);
		assert.equal(
			store.database.prepare("SELECT COUNT(*) AS count FROM events WHERE source = 'gmail_outbound'").get().count,
			1,
			"an ambiguous provider result must not claim an outbound ledger event",
		);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
