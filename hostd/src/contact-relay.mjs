import { createHmac, timingSafeEqual } from "node:crypto";
import { emailAddresses } from "./security.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

const HEADERS = {
	version: "x-tinyfat-contact-version",
	submissionId: "x-tinyfat-contact-submission-id",
	email: "x-tinyfat-contact-email",
	label: "x-tinyfat-contact-label",
	signature: "x-tinyfat-contact-signature",
};

export class ContactRelayVerificationError extends Error {
	constructor(reason) {
		super(`contact relay verification failed: ${reason}`);
		this.name = "ContactRelayVerificationError";
		this.code = "contact_relay_invalid";
	}
}

export function contactRelayCanonical({ submissionId, email, encodedLabel }) {
	return ["tinyfat-contact-v1", submissionId, email, encodedLabel].join("\n");
}

function relayFailure(reason) {
	throw new ContactRelayVerificationError(reason);
}

function verifiedLabel(encoded) {
	if (typeof encoded !== "string" || encoded.length > 1000 || /[\r\n\u0000]/.test(encoded)) {
		relayFailure("label");
	}
	let decoded;
	try {
		decoded = decodeURIComponent(encoded);
	} catch {
		relayFailure("label");
	}
	const cleaned = decoded
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
	if (encodeURIComponent(cleaned) !== encoded) relayFailure("label");
	return cleaned || undefined;
}

function equalSignature(expected, received) {
	if (!HEX_SHA256.test(received)) return false;
	const expectedBytes = Buffer.from(expected, "hex");
	const receivedBytes = Buffer.from(received, "hex");
	return expectedBytes.length === receivedBytes.length
		&& timingSafeEqual(expectedBytes, receivedBytes);
}

export function resolveInboundPrincipal({ headers, sender, relays = [] }) {
	const normalizedSender = sender.trim().toLowerCase();
	const relay = relays.find((candidate) => candidate.sender === normalizedSender);
	if (!relay) {
		return {
			principalEmail: normalizedSender,
			principalLabel: undefined,
			project: undefined,
			relay: undefined,
		};
	}

	if (headers[HEADERS.version] !== "1") relayFailure("version");
	const submissionId = String(headers[HEADERS.submissionId] || "").trim();
	if (!UUID_V4.test(submissionId)) relayFailure("submission_id");
	const principalEmail = String(headers[HEADERS.email] || "").trim().toLowerCase();
	const signedAddresses = emailAddresses(principalEmail);
	if (signedAddresses.length !== 1 || signedAddresses[0] !== principalEmail) {
		relayFailure("email");
	}
	const replyTo = emailAddresses(headers["reply-to"] || "");
	if (replyTo.length !== 1 || replyTo[0] !== principalEmail) relayFailure("reply_to");

	const encodedLabel = String(headers[HEADERS.label] || "");
	const principalLabel = verifiedLabel(encodedLabel);
	const signature = String(headers[HEADERS.signature] || "").trim().toLowerCase();
	const expected = createHmac("sha256", relay.signatureSecret)
		.update(contactRelayCanonical({ submissionId, email: principalEmail, encodedLabel }), "utf8")
		.digest("hex");
	if (!equalSignature(expected, signature)) relayFailure("signature");

	return {
		principalEmail,
		principalLabel,
		project: relay.project,
		relay: {
			sender: normalizedSender,
			submissionId,
		},
	};
}
