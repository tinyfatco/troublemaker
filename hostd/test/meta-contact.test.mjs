import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	createSignedAttributionMarker,
	MetaContactExporter,
} from "../src/meta-contact.mjs";

const CONFIG = {
	datasetId: "123456789012345",
	accessToken: "synthetic-access-token-at-least-32-bytes",
	attributionSecret: "synthetic-attribution-secret-at-least-32-bytes",
	campaignIds: ["campaign-example"],
	testEventCode: "TEST12345",
	apiBaseUrl: "https://graph.facebook.com",
	apiVersion: "v25.0",
	pollIntervalSeconds: 5,
	maximumAttempts: 12,
	leaseSeconds: 60,
	retryBaseSeconds: 30,
	retryMaximumSeconds: 3600,
	requestTimeoutMs: 15_000,
	maximumAttributionAgeSeconds: 3600,
	maximumFutureSkewSeconds: 300,
};

const CONTACT = "+15555550123";
const OCCURRED_AT = "2026-08-19T12:34:56.000Z";

function digest(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function attribution() {
	return {
		claimKey: `meta:${digest("verified-claim")}`,
		source: "meta",
		campaignId: "campaign-example",
	};
}

function record(exporter) {
	return exporter.createRecord({
		contactAddress: CONTACT,
		provider: "sendly",
		providerMessageId: "provider-message-123",
		occurredAt: OCCURRED_AT,
		attribution: attribution(),
	});
}

test("accepts only one fresh signed marker for one allowlisted Meta campaign", () => {
	const exporter = new MetaContactExporter(CONFIG);
	const observedAt = Date.parse(OCCURRED_AT);
	const marker = createSignedAttributionMarker({
		secret: CONFIG.attributionSecret,
		campaignId: "campaign-example",
		issuedAt: observedAt - 1000,
		nonce: "synthetic_nonce_123456789",
	});
	const resolved = exporter.resolveAttribution({
		messageText: `Could you help with an estimate? ${marker}`,
		observedAt,
	});
	assert.equal(resolved.messageText, "Could you help with an estimate?");
	assert.equal(resolved.claim.source, "meta");
	assert.equal(resolved.claim.campaignId, "campaign-example");
	assert.match(resolved.claim.claimKey, /^meta:[0-9a-f]{64}$/);
	assert.equal(JSON.stringify(resolved).includes(marker), false);
});

test("fails closed for absent, malformed, stale, future, replay-shaped, and non-Meta markers", () => {
	const exporter = new MetaContactExporter(CONFIG);
	const observedAt = Date.parse(OCCURRED_AT);
	const marker = (overrides = {}) => createSignedAttributionMarker({
		secret: CONFIG.attributionSecret,
		campaignId: "campaign-example",
		issuedAt: observedAt,
		nonce: "synthetic_nonce_123456789",
		...overrides,
	});
	assert.equal(exporter.resolveAttribution({
		messageText: "Manual text without attribution",
		observedAt,
	}), undefined);
	const candidates = [
		"[[meta-contact:not-a-valid-marker]]",
		marker({ issuedAt: observedAt - 3_601_000 }),
		marker({ issuedAt: observedAt + 301_000 }),
		marker({ source: "another-source" }),
		marker({ campaignId: "another-campaign" }),
		`${marker()} ${marker({ nonce: "another_nonce_1234567890" })}`,
	];
	for (const candidate of candidates) {
		const resolved = exporter.resolveAttribution({
			messageText: `Please contact me ${candidate}`,
			observedAt,
		});
		assert.equal(resolved.claim, undefined);
		assert.equal(resolved.messageText.includes("meta-contact"), false);
	}
});

test("creates one standard Contact event from only provider identity, time, and hashed phone", () => {
	const exporter = new MetaContactExporter(CONFIG);
	const record = exporter.createRecord({
		contactAddress: CONTACT,
		provider: "sendly",
		providerEventId: "unused-event-wrapper-id",
		providerMessageId: "provider-message-123",
		occurredAt: OCCURRED_AT,
		attribution: attribution(),
		body: "private message content",
		conversation: "private conversation content",
		form: { private: "content" },
		clientIpAddress: "192.0.2.10",
		clientUserAgent: "private-user-agent",
		unrelatedCustomer: { phone: "+15555550999" },
	});

	const eventId = `meta-contact:${digest("sendly\0provider-message-123")}`;
	assert.deepEqual(record, {
		eventId,
		payload: {
			event_name: "Contact",
			event_time: Math.floor(Date.parse(OCCURRED_AT) / 1000),
			event_id: eventId,
			action_source: "chat",
			user_data: { ph: [digest("15555550123")] },
		},
	});
	const serialized = JSON.stringify(record);
	for (const forbidden of [
		CONTACT,
		CONTACT.slice(1),
		"private message",
		"private conversation",
		"private-user-agent",
		"192.0.2.10",
		"15555550999",
		"unused-event-wrapper-id",
	]) assert.equal(serialized.includes(forbidden), false, forbidden);

	const retry = exporter.createRecord({
		contactAddress: CONTACT,
		provider: "sendly",
		providerMessageId: "provider-message-123",
		occurredAt: OCCURRED_AT,
		attribution: attribution(),
	});
	assert.equal(retry.eventId, eventId);
	assert.deepEqual(retry.payload, record.payload);
});

test("posts the exact minimized Contact shape to the Dataset events endpoint", async () => {
	let captured;
	const exporter = new MetaContactExporter(CONFIG, {
		fetchImpl: async (url, init) => {
			captured = { url: String(url), init, body: JSON.parse(init.body) };
			return Response.json({ events_received: 1, fbtrace_id: "synthetic_trace_123" });
		},
	});
	const contact = record(exporter);
	assert.deepEqual(await exporter.deliver(contact), { receiptId: "synthetic_trace_123" });
	assert.equal(captured.url, "https://graph.facebook.com/v25.0/123456789012345/events");
	assert.equal(captured.init.method, "POST");
	assert.deepEqual(captured.init.headers, { "content-type": "application/json" });
	assert.deepEqual(captured.body, {
		data: [contact.payload],
		access_token: CONFIG.accessToken,
		test_event_code: CONFIG.testEventCode,
	});
	assert.equal(captured.url.includes(CONFIG.accessToken), false);
	assert.deepEqual(Object.keys(captured.body.data[0].user_data), ["ph"]);
});

test("rejects expanded payloads and never retains provider error content", async () => {
	let called = false;
	const exporter = new MetaContactExporter(CONFIG, {
		fetchImpl: async () => {
			called = true;
			return new Response(`provider diagnostics ${CONTACT} private body`, { status: 503 });
		},
	});
	const contact = record(exporter);
	await assert.rejects(
		exporter.deliver({
			...contact,
			payload: { ...contact.payload, custom_data: { body: "must not leave Hostd" } },
		}),
		/contains unsupported data/,
	);
	assert.equal(called, false);
	await assert.rejects(
		exporter.deliver(contact),
		(error) => {
			assert.equal(error.message, "Meta Contact delivery failed with HTTP 503");
			assert.equal(error.message.includes(CONTACT), false);
			assert.equal(error.message.includes("private body"), false);
			return true;
		},
	);
});

test("sanitizes transport failures and requires an explicit one-event acknowledgement", async () => {
	const contact = record(new MetaContactExporter(CONFIG));
	const networkFailure = new MetaContactExporter(CONFIG, {
		fetchImpl: async () => { throw new Error(`network dump ${CONTACT}`); },
	});
	await assert.rejects(
		networkFailure.deliver(contact),
		/^Error: Meta Contact request ended without a definitive response$/,
	);
	const missingAck = new MetaContactExporter(CONFIG, {
		fetchImpl: async () => Response.json({ events_received: 0 }),
	});
	await assert.rejects(missingAck.deliver(contact), /was not acknowledged/);
});
