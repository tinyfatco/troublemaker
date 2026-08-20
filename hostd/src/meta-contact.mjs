import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

const EVENT_NAME = "Contact";
const ACTION_SOURCE = "chat";
const EVENT_ID_PATTERN = /^meta-contact:[0-9a-f]{64}$/;
const PHONE_HASH_PATTERN = /^[0-9a-f]{64}$/;
const CLAIM_KEY_PATTERN = /^meta:[0-9a-f]{64}$/;
const MARKER_CANDIDATE_PATTERN = /\[\[meta-contact:[^\]]{1,512}\]\]/g;
const MARKER_PATTERN = /^\[\[meta-contact:(v1\.[a-zA-Z0-9_-]{1,384})\.([a-zA-Z0-9_-]{43})\]\]$/;

function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(secret, value) {
	return createHmac("sha256", secret).update(value, "utf8").digest("base64url");
}

function equal(left, right) {
	const actual = Buffer.from(left);
	const expected = Buffer.from(right);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cleanMarkedMessage(messageText, markers) {
	let cleaned = messageText;
	for (const marker of markers) cleaned = cleaned.replace(marker, " ");
	return cleaned.replace(/[ \t]{2,}/g, " ").trim();
}

export function createSignedAttributionMarker({
	secret,
	campaignId,
	source = "meta",
	issuedAt = Date.now(),
	nonce = randomBytes(18).toString("base64url"),
}) {
	if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
		throw new Error("attribution signing secret must contain at least 32 bytes");
	}
	if (!/^[a-z][a-z0-9._-]{0,63}$/.test(source)) {
		throw new Error("attribution source is invalid");
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(campaignId)) {
		throw new Error("attribution campaign is invalid");
	}
	if (!/^[a-zA-Z0-9_-]{16,64}$/.test(nonce)) {
		throw new Error("attribution nonce is invalid");
	}
	const issuedAtSeconds = Math.floor(Number(issuedAt) / 1000);
	if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds <= 0) {
		throw new Error("attribution issue time is invalid");
	}
	const encoded = Buffer.from(JSON.stringify({
		v: 1,
		source,
		campaignId,
		issuedAt: issuedAtSeconds,
		nonce,
	}), "utf8").toString("base64url");
	const signed = `v1.${encoded}`;
	return `[[meta-contact:${signed}.${hmac(secret, signed)}]]`;
}

function providerEventId(provider, providerMessageId) {
	if (typeof provider !== "string" || !provider.trim()) {
		throw new Error("contact provider is required");
	}
	if (typeof providerMessageId !== "string" || !providerMessageId.trim()) {
		throw new Error("contact provider message ID is required");
	}
	return `meta-contact:${sha256(`${provider.trim().toLowerCase()}\0${providerMessageId.trim()}`)}`;
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
		this.allowedCampaignIds = new Set(config.campaignIds);
	}

	resolveAttribution({ messageText, observedAt }) {
		if (typeof messageText !== "string") return undefined;
		const markers = messageText.match(MARKER_CANDIDATE_PATTERN) ?? [];
		if (markers.length === 0) return undefined;
		const cleaned = cleanMarkedMessage(messageText, markers);
		if (markers.length !== 1 || !cleaned) return { messageText: cleaned };
		const match = markers[0].match(MARKER_PATTERN);
		if (!match || !equal(match[2], hmac(this.config.attributionSecret, match[1]))) {
			return { messageText: cleaned };
		}
		let claim;
		try {
			claim = JSON.parse(Buffer.from(match[1].slice(3), "base64url").toString("utf8"));
		} catch {
			return { messageText: cleaned };
		}
		if (
			!claim
			|| typeof claim !== "object"
			|| Array.isArray(claim)
			|| Object.keys(claim).sort().join(",") !== "campaignId,issuedAt,nonce,source,v"
			|| claim.v !== 1
			|| claim.source !== "meta"
			|| !this.allowedCampaignIds.has(claim.campaignId)
			|| !Number.isSafeInteger(claim.issuedAt)
			|| !/^[a-zA-Z0-9_-]{16,64}$/.test(claim.nonce)
		) return { messageText: cleaned };
		const observedAtSeconds = Math.floor(Number(observedAt) / 1000);
		if (
			!Number.isSafeInteger(observedAtSeconds)
			|| claim.issuedAt > observedAtSeconds + this.config.maximumFutureSkewSeconds
			|| observedAtSeconds - claim.issuedAt > this.config.maximumAttributionAgeSeconds
		) return { messageText: cleaned };
		return {
			messageText: cleaned,
			claim: {
				claimKey: `meta:${sha256(`meta\0${claim.campaignId}\0${claim.nonce}`)}`,
				source: "meta",
				campaignId: claim.campaignId,
			},
		};
	}

	createRecord({ contactAddress, provider, providerMessageId, occurredAt, attribution }) {
		if (
			attribution?.source !== "meta"
			|| !this.allowedCampaignIds.has(attribution.campaignId)
			|| !CLAIM_KEY_PATTERN.test(attribution.claimKey)
		) throw new Error("verified Meta attribution is required");
		const eventId = providerEventId(provider, providerMessageId);
		return {
			eventId,
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
