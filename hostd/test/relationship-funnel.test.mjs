import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	evidenceSha256,
	normalizeRelationshipProgress,
	relationshipProgressSha256,
} from "../src/relationship-funnel.mjs";
import { ContextRouter } from "../src/router.mjs";
import { createHostServer } from "../src/server.mjs";
import { contextCapability, sealPrivateValue } from "../src/security.mjs";
import { HostStore } from "../src/store.mjs";

const TARGET = {
	id: "front-desk",
	driver: "oci",
	inboundToken: "test-inbound-secret",
	outboundToken: "test-outbound-secret",
};
const ROUTING_KEY = Buffer.alloc(32, 12);

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-relationship-funnel-"));
	const database = join(directory, "state.sqlite");
	const store = new HostStore(database);
	const config = {
		routing: { actorTarget: TARGET.id, knownPrincipals: [] },
		targetsById: new Map([[TARGET.id, TARGET]]),
	};
	const router = new ContextRouter(config, store, ROUTING_KEY);
	const route = router.resolvePhone({
		providerThreadId: "provider-thread-owner",
		contactAddress: "+15555550123",
		label: "Phone •••• 0123",
	});
	store.createContext({
		id: route.contextId,
		targetId: TARGET.id,
		driver: "oci",
		runtimeName: "relationship-runtime",
		port: 32001,
	});
	const conversation = {
		threadTarget: "phone-0123456789abcdef0123",
		provider: "sendly",
		providerThreadId: route.providerThreadId,
		principalHash: route.principalHash,
		targetId: route.targetId,
		contextId: route.contextId,
		contactCiphertext: sealPrivateValue(ROUTING_KEY, "phone-contact", "+15555550123"),
		contactLastFour: "0123",
	};
	return {
		directory,
		database,
		store,
		conversation,
		close() {
			this.store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function inbound(subject, {
	id,
	providerMessageId,
	receivedAt,
	body = "PRIVATE CUSTOMER WORDING MUST NOT ENTER FUNNEL TABLES",
}) {
	return subject.store.upsertPhoneInbound({
		conversation: subject.conversation,
		event: {
			id,
			source: "phone",
			providerMessageId,
			providerThreadId: subject.conversation.providerThreadId,
			principalHash: subject.conversation.principalHash,
			targetId: subject.conversation.targetId,
			contextId: subject.conversation.contextId,
			receivedAt,
			availableAt: receivedAt,
			payload: { message: { body } },
		},
	}).event;
}

function ledgerEvent(subject, providerMessageId, body = "Provider-bound reply") {
	return {
		id: `phone_outbound:${providerMessageId}`,
		source: "phone_outbound",
		providerMessageId,
		providerThreadId: subject.conversation.providerThreadId,
		principalHash: subject.conversation.principalHash,
		targetId: subject.conversation.targetId,
		contextId: subject.conversation.contextId,
		payload: { direction: "outbound", message: { id: providerMessageId, body } },
	};
}

test("relationship progress accepts only exact close-state pairs and bounded authorities", () => {
	assert.deepEqual(normalizeRelationshipProgress({
		close_state: "request_answered",
		next_step: "await_customer_choice",
	}), {
		close_state: "request_answered",
		next_step: "await_customer_choice",
	});
	assert.throws(
		() => normalizeRelationshipProgress({
			close_state: "request_answered",
			next_step: "confirm_payment",
		}),
		/relationship_close_pair_invalid/,
	);
	assert.throws(
		() => normalizeRelationshipProgress({
			close_state: "request_answered",
			next_step: "await_customer_choice",
			milestone: "payment",
		}),
		/relationship_milestone_authority_denied/,
	);
	assert.equal(
		relationshipProgressSha256({
			close_state: "request_answered",
			next_step: "await_customer_choice",
		}),
		relationshipProgressSha256({
			close_state: "request_answered",
			next_step: "await_customer_choice",
		}),
	);
});

test("phone inbound timing is idempotent, restart-safe, and content-free", () => {
	const subject = fixture();
	const secret = "PRIVATE CUSTOMER WORDING MUST NOT ENTER FUNNEL TABLES";
	try {
		const event = inbound(subject, {
			id: "phone:inbound-one",
			providerMessageId: "inbound-one",
			receivedAt: "2026-08-31T05:00:00.000Z",
			body: secret,
		});
		inbound(subject, {
			id: event.id,
			providerMessageId: "inbound-one",
			receivedAt: "2026-08-31T05:00:00.000Z",
			body: secret,
		});
		const durableReceivedAt = event.receivedAt;
		let funnel = subject.store.getRelationshipFunnel(subject.conversation.contextId);
		assert.equal(funnel.inboundTurnCount, 1);
		assert.equal(funnel.outboundTurnCount, 0);
		assert.equal(funnel.firstInboundAt, durableReceivedAt);
		assert.equal(funnel.closeState, "inbound_received");
		assert.equal(funnel.nextStep, "reply_to_customer");
		assert.throws(
			() => subject.store.database.prepare(`
				UPDATE relationship_funnels SET next_step = 'confirm_payment' WHERE context_id = ?
			`).run(subject.conversation.contextId),
			/constraint failed/i,
			"SQLite rejects an invalid close-state and next-step pair",
		);
		assert.deepEqual(funnel.milestones.map(({ milestone, authority }) => [milestone, authority]), [
			["first_inbound", "host_inbound"],
		]);

		for (const table of [
			"relationship_funnels",
			"relationship_funnel_milestones",
			"relationship_funnel_turns",
		]) {
			const columns = subject.store.database.prepare(`PRAGMA table_info(${table})`).all()
				.map((column) => column.name);
			const contentTokens = new Set(["body", "text", "message", "payload", "contact"]);
			assert.equal(
				columns.some((column) => column.split("_").some((token) => contentTokens.has(token))),
				false,
				table,
			);
			const rows = subject.store.database.prepare(`SELECT * FROM ${table}`).all();
			assert.equal(JSON.stringify(rows).includes(secret), false, table);
		}

		subject.store.database.exec(`
			DELETE FROM relationship_funnel_turns;
			DELETE FROM relationship_funnel_milestones;
			DELETE FROM relationship_funnels;
			DELETE FROM meta WHERE key = 'relationship_funnel_backfill_v1';
		`);
		subject.store.close();
		subject.store = new HostStore(subject.database);
		funnel = subject.store.getRelationshipFunnel(subject.conversation.contextId);
		assert.equal(funnel.inboundTurnCount, 1, "restart backfill restores one durable inbound turn");
		assert.equal(funnel.firstInboundAt, durableReceivedAt);
		assert.equal(JSON.stringify(funnel).includes(secret), false);
	} finally {
		subject.close();
	}
});

test("provider completion atomically commits outbound timing, milestone evidence, and close state", () => {
	const subject = fixture();
	try {
		const first = inbound(subject, {
			id: "phone:scope-z",
			providerMessageId: "inbound-one",
			receivedAt: "2026-08-31T05:00:00.000Z",
		});
		const second = inbound(subject, {
			id: "phone:scope-a",
			providerMessageId: "inbound-two",
			receivedAt: "2026-08-31T05:00:00.400Z",
		});
		subject.store.database.prepare(`
			UPDATE events SET status = 'running', lease_token = 'exact-batch-lease',
				received_at = '2026-08-31T05:00:00.000Z'
			WHERE id IN (?, ?)
		`).run(first.id, second.id);
		const originEvents = subject.store.getActivePhoneEventScope({
			contextId: subject.conversation.contextId,
			conversation: subject.conversation,
			eventIds: [first.id, second.id],
		});
		assert.deepEqual(originEvents.map((event) => event.id), [first.id, second.id]);
		assert.equal(subject.store.getActivePhoneEventScope({
			contextId: subject.conversation.contextId,
			conversation: subject.conversation,
			eventIds: [second.id, first.id],
		}), undefined, "reordered event identities fail closed");
		assert.equal(subject.store.getActivePhoneEventScope({
			contextId: subject.conversation.contextId,
			conversation: subject.conversation,
			eventIds: [second.id],
		}), undefined, "partial event batches fail closed");

		const progress = {
			close_state: "awaiting_preview_review",
			next_step: "review_preview",
			milestone: "preview",
		};
		const idempotencyKey = "direct-batch-preview";
		subject.store.startOutbox({
			idempotencyKey,
			targetId: subject.conversation.targetId,
			contextId: subject.conversation.contextId,
			providerThreadId: subject.conversation.providerThreadId,
			originEventId: second.id,
			bodySha256: evidenceSha256("body", "concise reply"),
			progressSha256: relationshipProgressSha256(progress),
		});
		subject.store.completePhoneOutboxWithLedger(
			idempotencyKey,
			"provider-outbound-one",
			"queued",
			ledgerEvent(subject, "provider-outbound-one"),
			{ conversation: subject.conversation, originEvents, relationshipProgress: progress },
		);
		const delivery = subject.store.getOutbox(idempotencyKey);
		assert.equal(delivery.status, "completed");
		assert.equal(delivery.providerMessageId, "provider-outbound-one");
		let funnel = subject.store.getRelationshipFunnel(subject.conversation.contextId);
		assert.equal(funnel.inboundTurnCount, 2);
		assert.equal(funnel.outboundTurnCount, 1);
		assert.equal(funnel.closeState, "awaiting_preview_review");
		assert.equal(funnel.nextStep, "review_preview");
		assert.deepEqual(
			funnel.milestones.map(({ milestone, authority }) => [milestone, authority]),
			[["first_inbound", "host_inbound"], ["preview", "provider_outbound"]],
		);

		const deniedProgress = {
			close_state: "awaiting_payment_confirmation",
			next_step: "confirm_payment",
		};
		subject.store.startOutbox({
			idempotencyKey: "missing-checkout-evidence",
			targetId: subject.conversation.targetId,
			contextId: subject.conversation.contextId,
			providerThreadId: subject.conversation.providerThreadId,
			bodySha256: evidenceSha256("body", "must roll back"),
			progressSha256: relationshipProgressSha256(deniedProgress),
		});
		assert.throws(
			() => subject.store.completePhoneOutboxWithLedger(
				"missing-checkout-evidence",
				"provider-outbound-denied",
				"queued",
				ledgerEvent(subject, "provider-outbound-denied"),
				{ conversation: subject.conversation, originEvents, relationshipProgress: deniedProgress },
			),
			/relationship_close_evidence_missing/,
		);
		assert.equal(subject.store.getOutbox("missing-checkout-evidence").status, "sending");
		assert.equal(subject.store.getEventByProviderMessage("phone_outbound", "provider-outbound-denied"), undefined);
		funnel = subject.store.getRelationshipFunnel(subject.conversation.contextId);
		assert.equal(funnel.outboundTurnCount, 1);
		assert.equal(funnel.closeState, "awaiting_preview_review");

		const revokedProgress = {
			close_state: "request_answered",
			next_step: "await_customer_choice",
		};
		subject.store.startOutbox({
			idempotencyKey: "revoked-event-scope",
			targetId: subject.conversation.targetId,
			contextId: subject.conversation.contextId,
			providerThreadId: subject.conversation.providerThreadId,
			bodySha256: evidenceSha256("body", "scope changed after provider call"),
			progressSha256: relationshipProgressSha256(revokedProgress),
		});
		subject.store.database.prepare(`
			UPDATE events SET status = 'uncertain' WHERE id = ?
		`).run(first.id);
		assert.throws(
			() => subject.store.completePhoneOutboxWithLedger(
				"revoked-event-scope",
				"provider-outbound-revoked",
				"queued",
				ledgerEvent(subject, "provider-outbound-revoked"),
				{ conversation: subject.conversation, originEvents, relationshipProgress: revokedProgress },
			),
			/event scope is no longer active/,
		);
		assert.equal(subject.store.getOutbox("revoked-event-scope").status, "sending");
		assert.equal(subject.store.getEventByProviderMessage("phone_outbound", "provider-outbound-revoked"), undefined);
		funnel = subject.store.getRelationshipFunnel(subject.conversation.contextId);
		assert.equal(funnel.outboundTurnCount, 1);
		assert.equal(funnel.closeState, "awaiting_preview_review");
	} finally {
		subject.close();
	}
});

test("payment and domain completion require their narrow trusted authorities", () => {
	const subject = fixture();
	try {
		inbound(subject, {
			id: "phone:inbound-one",
			providerMessageId: "inbound-one",
			receivedAt: "2026-08-31T05:00:00.000Z",
		});
		assert.throws(
			() => subject.store.recordTrustedRelationshipMilestone({
				contextId: subject.conversation.contextId,
				milestone: "payment",
				authority: "customer_inbound",
				evidenceId: "customer-said-paid",
			}),
			/relationship_milestone_authority_denied/,
		);
		let funnel = subject.store.recordTrustedRelationshipMilestone({
			contextId: subject.conversation.contextId,
			milestone: "payment",
			authority: "payment_provider",
			evidenceId: "payment-provider-receipt-1",
			observedAt: "2026-08-31T05:02:00.000Z",
		});
		assert.equal(funnel.closeState, "awaiting_domain_intake");
		assert.equal(funnel.nextStep, "share_domain_choice");
		assert.throws(
			() => subject.store.recordTrustedRelationshipMilestone({
				contextId: subject.conversation.contextId,
				milestone: "domain_connection",
				authority: "host_operation",
				evidenceId: "host-operation-1",
			}),
			/relationship_close_evidence_missing/,
		);
		const domainIntakeEvidence = evidenceSha256(
			"relationship-milestone-v1",
			subject.conversation.contextId,
			"domain_intake",
			"phone:inbound-one",
		);
		subject.store.recordRelationshipMilestone({
			contextId: subject.conversation.contextId,
			milestone: "domain_intake",
			observedAt: "2026-08-31T05:03:00.000Z",
			authority: "customer_inbound",
			evidenceSha256: domainIntakeEvidence,
		});
		funnel = subject.store.recordTrustedRelationshipMilestone({
			contextId: subject.conversation.contextId,
			milestone: "domain_connection",
			authority: "host_operation",
			evidenceId: "host-operation-1",
			observedAt: "2026-08-31T05:04:00.000Z",
		});
		assert.equal(funnel.closeState, "awaiting_live_acceptance");
		assert.equal(funnel.nextStep, "review_live_site");
		assert.deepEqual(
			funnel.milestones
				.map(({ milestone, authority }) => [milestone, authority])
				.sort(([left], [right]) => left.localeCompare(right)),
			[
				["domain_connection", "host_operation"],
				["domain_intake", "customer_inbound"],
				["first_inbound", "host_inbound"],
				["payment", "payment_provider"],
			],
		);
	} finally {
		subject.close();
	}
});


test("direct Hostd phone replies require an exact active batch and atomically durable progress", async () => {
	const subject = fixture();
	const first = inbound(subject, {
		id: "phone:direct-one",
		providerMessageId: "direct-one",
		receivedAt: "2026-08-31T05:00:00.000Z",
	});
	const second = inbound(subject, {
		id: "phone:direct-two",
		providerMessageId: "direct-two",
		receivedAt: "2026-08-31T05:00:00.400Z",
	});
	subject.store.database.prepare(`
		UPDATE events SET status = 'running', lease_token = 'direct-server-lease'
		WHERE id IN (?, ?)
	`).run(first.id, second.id);
	const config = {
		server: {},
		scheduler: { maxConcurrent: 1, relationshipBurstMaximumMessages: 10 },
		phone: { deliveryHolds: [] },
		routing: { actorTarget: TARGET.id, knownPrincipals: [] },
		targetsById: new Map([[TARGET.id, TARGET]]),
	};
	const sends = [];
	const server = createHostServer({
		config,
		store: subject.store,
		daemon: { polling: false, controlNotifier: { wake() {} } },
		phoneGateway: {
			async sendDirect(conversation, body) {
				sends.push({ threadTarget: conversation.threadTarget, body });
				return { providerMessageId: `direct-provider-${sends.length}`, status: "queued" };
			},
		},
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address === "object");
	const endpoint = `http://127.0.0.1:${address.port}/v1/outbound/phone`;
	const post = (body) => fetch(endpoint, {
		method: "POST",
		headers: {
			authorization: `Bearer ${contextCapability(TARGET.outboundToken, "outbound", subject.conversation.contextId)}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			context_id: subject.conversation.contextId,
			thread_target: subject.conversation.threadTarget,
			agent_body: "Short, truthful reply.",
			idempotency_key: "direct-server-reply",
			...body,
		}),
	});
	const progress = {
		close_state: "awaiting_preview_review",
		next_step: "review_preview",
		milestone: "preview",
	};
	try {
		let response = await post({
			origin_event_id: second.id,
			origin_event_ids: [second.id],
			relationship_progress: progress,
		});
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "relationship_event_scope_denied" });

		response = await post({
			origin_event_id: first.id,
			origin_event_ids: [second.id, first.id],
			relationship_progress: progress,
		});
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "relationship_event_scope_denied" });

		response = await post({
			origin_event_id: second.id,
			origin_event_ids: [first.id, second.id],
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "relationship_progress_required" });

		response = await post({
			agent_body: "x".repeat(321),
			idempotency_key: "direct-overlong-reply",
			origin_event_id: second.id,
			origin_event_ids: [first.id, second.id],
			relationship_progress: progress,
		});
		assert.equal(response.status, 400, "direct relationship replies are materially bounded");
		assert.deepEqual(await response.json(), { error: "agent_body_invalid" });
		assert.equal(subject.store.getOutbox("direct-overlong-reply"), undefined);
		assert.equal(sends.length, 0);

		response = await post({
			origin_event_id: second.id,
			origin_event_ids: [first.id, second.id],
			relationship_progress: {
				close_state: "awaiting_domain_intake",
				next_step: "share_domain_choice",
			},
		});
		assert.equal(response.status, 403, "unsupported payment-dependent state is denied before send");
		assert.deepEqual(await response.json(), { error: "relationship_progress_evidence_denied" });
		assert.equal(sends.length, 0);

		response = await post({
			origin_event_id: second.id,
			origin_event_ids: [first.id, second.id],
			relationship_progress: progress,
		});
		assert.equal(response.status, 200);
		assert.deepEqual(sends, [{
			threadTarget: subject.conversation.threadTarget,
			body: "Short, truthful reply.",
		}]);
		assert.equal(subject.store.getOutbox("direct-server-reply").status, "completed");
		let funnel = subject.store.getRelationshipFunnel(subject.conversation.contextId);
		assert.equal(funnel.outboundTurnCount, 1);
		assert.equal(funnel.closeState, "awaiting_preview_review");
		assert.equal(funnel.nextStep, "review_preview");
		assert.equal(funnel.milestones.find(({ milestone }) => milestone === "preview").authority, "provider_outbound");

		response = await post({
			origin_event_id: second.id,
			origin_event_ids: [first.id, second.id],
			relationship_progress: progress,
		});
		assert.equal(response.status, 200, "an exact retry returns the provider-confirmed receipt");
		assert.equal(sends.length, 1);
		assert.equal(subject.store.getRelationshipFunnel(subject.conversation.contextId).outboundTurnCount, 1);

		response = await post({
			origin_event_id: second.id,
			origin_event_ids: [first.id, second.id],
			relationship_progress: {
				close_state: "request_answered",
				next_step: "await_customer_choice",
			},
		});
		assert.equal(response.status, 409, "the same key cannot mutate durable progress");
		assert.deepEqual(await response.json(), { error: "delivery_idempotency_conflict" });
		assert.equal(sends.length, 1);
		funnel = subject.store.getRelationshipFunnel(subject.conversation.contextId);
		assert.equal(funnel.closeState, "awaiting_preview_review");
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		subject.close();
	}
});
