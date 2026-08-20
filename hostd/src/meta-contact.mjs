import { createHash } from "node:crypto";

const EVENT_NAME = "Contact";
const ACTION_SOURCE = "chat";
const EVENT_ID_PATTERN = /^meta-contact:[0-9a-f]{64}$/;
const PHONE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const CLAIM_KEY_PATTERN = /^meta:[0-9a-f]{64}$/;

export const TINYFAT_WEBSITE_INQUIRY_INTENT = "tinyfat_website_inquiry";

function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedExactText(value) {
	return typeof value === "string" ? value.normalize("NFC").trim() : "";
}

function providerIdentity(provider, providerMessageId) {
	if (typeof provider !== "string" || !provider.trim()) {
		throw new Error("contact provider is required");
	}
	if (typeof providerMessageId !== "string" || !providerMessageId.trim()) {
		throw new Error("contact provider message ID is required");
	}
	return `${provider.trim().toLowerCase()}\0${providerMessageId.trim()}`;
}

function providerEventId(provider, providerMessageId) {
	return `meta-contact:${sha256(providerIdentity(provider, providerMessageId))}`;
}

function hashedPhone(contactAddress) {
	const digits = typeof contactAddress === "string" ? contactAddress.replace(/\D/g, "") : "";
	if (!/^[1-9]\d{7,14}$/.test(digits)) {
		throw new Error("contact address must contain an international phone number");
	}
	return sha256(digits);
}

function eventTime(occurredAt) {
	const milliseconds = Date.parse(occurredAt);
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
		throw new Error("contact occurrence time is invalid");
	}
	return Math.floor(milliseconds / 1000);
}

function assertExactEvent(eventId, payload) {
	if (!EVENT_ID_PATTERN.test(eventId) || payload?.event_id !== eventId) {
		throw new Error("Meta Contact event ID is invalid");
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Meta Contact payload is invalid");
	}
	if (Object.keys(payload).sort().join(",") !== "action_source,event_id,event_name,event_time,user_data") {
		throw new Error("Meta Contact payload contains unsupported data");
	}
	if (
		payload.event_name !== EVENT_NAME
		|| payload.action_source !== ACTION_SOURCE
		|| !Number.isSafeInteger(payload.event_time)
		|| payload.event_time <= 0
	) {
		throw new Error("Meta Contact payload is invalid");
	}
	if (
		!payload.user_data
		|| typeof payload.user_data !== "object"
		|| Array.isArray(payload.user_data)
		|| Object.keys(payload.user_data).join(",") !== "ph"
		|| !Array.isArray(payload.user_data.ph)
		|| payload.user_data.ph.length !== 1
		|| !PHONE_HASH_PATTERN.test(payload.user_data.ph[0])
	) {
		throw new Error("Meta Contact user data is invalid");
	}
}

export class MetaContactExporter {
	constructor(config, { fetchImpl = fetch } = {}) {
		this.config = config;
		this.fetch = fetchImpl;
		this.kind = "meta_contact";
		this.pollIntervalSeconds = config.pollIntervalSeconds;
		this.maximumAttempts = config.maximumAttempts;
		this.leaseSeconds = config.leaseSeconds;
		this.retryBaseSeconds = config.retryBaseSeconds;
		this.retryMaximumSeconds = config.retryMaximumSeconds;
		this.attribution = config.attribution;
	}

	resolveAttribution({ messageText, provider, providerMessageId }) {
		if (
			this.attribution?.enabled !== true
			|| this.attribution.source !== "meta"
			|| normalizedExactText(messageText) !== normalizedExactText(this.attribution.exactPrefill)
		) return undefined;
		let identity;
		try {
			identity = providerIdentity(provider, providerMessageId);
		} catch {
			return undefined;
		}
		return {
			messageText,
			claim: {
				claimKey: `meta:${sha256(`${this.attribution.source}\0${this.attribution.campaignId}\0${identity}`)}`,
				source: this.attribution.source,
				campaignId: this.attribution.campaignId,
			},
		};
	}

	createRecord({ contactAddress, provider, providerMessageId, occurredAt, attribution }) {
		if (
			this.attribution?.enabled !== true
			|| attribution?.source !== this.attribution.source
			|| attribution?.campaignId !== this.attribution.campaignId
			|| !CLAIM_KEY_PATTERN.test(attribution.claimKey)
		) throw new Error("verified Meta attribution is required");
		const eventId = providerEventId(provider, providerMessageId);
		return {
			eventId,
			operatorIntent: TINYFAT_WEBSITE_INQUIRY_INTENT,
			payload: {
				event_name: EVENT_NAME,
				event_time: eventTime(occurredAt),
				event_id: eventId,
				action_source: ACTION_SOURCE,
				user_data: { ph: [hashedPhone(contactAddress)] },
			},
		};
	}

	async deliver({ eventId, payload }) {
		assertExactEvent(eventId, payload);
		const body = { data: [payload], access_token: this.config.accessToken };
		if (this.config.testEventCode) body.test_event_code = this.config.testEventCode;

		let response;
		try {
			response = await this.fetch(
				`${this.config.apiBaseUrl}/${this.config.apiVersion}/${this.config.datasetId}/events`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(this.config.requestTimeoutMs),
				},
			);
		} catch {
			throw new Error("Meta Contact request ended without a definitive response");
		}
		if (!response.ok) {
			throw new Error(`Meta Contact delivery failed with HTTP ${response.status}`);
		}
		let result;
		try {
			result = await response.json();
		} catch {
			throw new Error("Meta Contact delivery response was malformed");
		}
		if (result?.events_received !== 1) {
			throw new Error("Meta Contact delivery was not acknowledged");
		}
		const receiptId = typeof result.fbtrace_id === "string"
			&& /^[a-zA-Z0-9_-]{1,240}$/.test(result.fbtrace_id)
			? result.fbtrace_id
			: undefined;
		return { receiptId };
	}
}
