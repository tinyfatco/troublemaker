import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
	ContactRelayVerificationError,
	contactRelayCanonical,
	resolveInboundPrincipal,
} from "../src/contact-relay.mjs";

const secret = "test-contact-relay-secret-at-least-32-bytes";
const submissionId = "123e4567-e89b-42d3-a456-426614174000";
const email = "person@example.com";
const encodedLabel = "Caf%C3%A9%20Website";

function signedHeaders(overrides = {}) {
	const signature = createHmac("sha256", secret)
		.update(contactRelayCanonical({ submissionId, email, encodedLabel }), "utf8")
		.digest("hex");
	return {
		"x-tinyfat-contact-version": "1",
		"x-tinyfat-contact-submission-id": submissionId,
		"x-tinyfat-contact-email": email,
		"x-tinyfat-contact-label": encodedLabel,
		"x-tinyfat-contact-signature": signature,
		"reply-to": email,
		...overrides,
	};
}

const relays = [{
	sender: "noreply@example.com",
	signatureSecret: secret,
	project: { slug: "website", name: "Customer website" },
}];

test("verified contact relay supplies the Reply-To principal, label, and configured project", () => {
	assert.deepEqual(resolveInboundPrincipal({
		headers: signedHeaders(),
		sender: "noreply@example.com",
		relays,
	}), {
		principalEmail: email,
		principalLabel: "Café Website",
		project: { slug: "website", name: "Customer website" },
		relay: {
			sender: "noreply@example.com",
			submissionId,
		},
	});
});

test("matching relay sender fails closed on unsigned or mismatched identity", () => {
	assert.throws(
		() => resolveInboundPrincipal({
			headers: signedHeaders({ "x-tinyfat-contact-signature": "" }),
			sender: "noreply@example.com",
			relays,
		}),
		ContactRelayVerificationError,
	);
	assert.throws(
		() => resolveInboundPrincipal({
			headers: signedHeaders({ "reply-to": "other@example.com" }),
			sender: "noreply@example.com",
			relays,
		}),
		ContactRelayVerificationError,
	);
});

test("ordinary Gmail sender remains its own principal", () => {
	assert.deepEqual(resolveInboundPrincipal({
		headers: { from: "person@example.com" },
		sender: "person@example.com",
		relays,
	}), {
		principalEmail: "person@example.com",
		principalLabel: undefined,
		project: undefined,
		relay: undefined,
	});
});
