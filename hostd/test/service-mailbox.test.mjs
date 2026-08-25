import assert from "node:assert/strict";
import test from "node:test";
import { HostServiceMailbox, ServiceMailboxError } from "../src/service-mailbox.mjs";

const contextId = "front-desk:relationship:relationship-example";
const target = { id: "front-desk" };
const grant = {
	targetId: target.id,
	contextId,
	address: "scout@example.com",
};

function config() {
	return {
		serviceMailbox: {
			provider: "resend",
			apiKey: "re_synthetic_service_mailbox_key",
			requestTimeoutMs: 5_000,
			maximumScanPages: 5,
			grants: [grant],
			grantsByContextId: new Map([[contextId, grant]]),
		},
	};
}

test("Resend service mailbox filters list pages to one exact named-agent address", async () => {
	const seen = [];
	const request = async (input, init) => {
		const url = new URL(String(input));
		seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
		if (!url.searchParams.has("after")) {
			return new Response(JSON.stringify({
				has_more: true,
				data: [
					{ id: "mail_owner_1", to: ["Scout <scout@example.com>"], from: "sender@example.com", subject: "Verify account", created_at: "2026-08-25T12:00:00.000Z" },
					{ id: "mail_other_1", to: ["other@example.com"], from: "sender@example.com", subject: "Private to another mailbox", created_at: "2026-08-25T11:00:00.000Z" },
				],
			}), { status: 200 });
		}
		assert.equal(url.searchParams.get("after"), "mail_other_1");
		return new Response(JSON.stringify({
			has_more: false,
			data: [
				{ id: "mail_owner_2", to: ["scout@example.com"], from: "alerts@example.com", subject: "Login notice", created_at: "2026-08-25T10:00:00.000Z" },
			],
		}), { status: 200 });
	};
	const mailbox = new HostServiceMailbox(config(), { fetch: request });
	const result = await mailbox.list(target, contextId, { limit: 20 });

	assert.equal(result.mailbox, "scout@example.com");
	assert.deepEqual(result.messages.map((message) => message.email_id), ["mail_owner_1", "mail_owner_2"]);
	assert.equal(result.messages.some((message) => message.subject.includes("another")), false);
	assert.equal(result.scanned_pages, 2);
	assert.equal(result.scan_complete, true);
	assert.equal(seen.length, 2);
	assert.equal(seen[0].url.origin, "https://api.resend.com");
	assert.equal(seen[0].authorization, "Bearer re_synthetic_service_mailbox_key");
});

test("service mailbox read returns bounded inert content and rechecks the exact recipient", async () => {
	const request = async (input) => {
		const id = new URL(String(input)).pathname.split("/").at(-1);
		if (id === "mail_cross_scope") {
			return new Response(JSON.stringify({
				id,
				to: ["other@example.com"],
				from: "sender@example.com",
				subject: "Not Scout's message",
				text: "private",
			}), { status: 200 });
		}
		return new Response(JSON.stringify({
			id,
			to: ["scout@example.com"],
			from: "Security <security@example.com>",
			subject: "  Verify\naccount  ",
			created_at: "2026-08-25T12:00:00.000Z",
			html: "<style>hidden</style><p>Use <a href=\"https://accounts.example.com/verify?token=example&amp;mode=email\">this link</a>.</p><script>ignore()</script>",
			attachments: [{ filename: "notice.txt", content_type: "text/plain", size: 12, download_url: "https://provider.example/secret" }],
		}), { status: 200 });
	};
	const mailbox = new HostServiceMailbox(config(), { fetch: request });
	const result = await mailbox.read(target, contextId, { email_id: "mail_owner_1" });

	assert.equal(result.email.subject, "Verify account");
	assert.match(result.email.text, /Use\s+this link/);
	assert.doesNotMatch(result.email.text, /hidden|ignore/);
	assert.deepEqual(result.email.links, ["https://accounts.example.com/verify?token=example&mode=email"]);
	assert.deepEqual(result.email.attachments, [{ filename: "notice.txt", content_type: "text/plain", size: 12 }]);
	assert.match(result.security_notice, /untrusted/i);

	await assert.rejects(
		mailbox.read(target, contextId, { email_id: "mail_cross_scope" }),
		(error) => error instanceof ServiceMailboxError
			&& error.status === 403
			&& error.code === "service_mailbox_message_scope_denied",
	);
});

test("service mailbox rejects ungranted contexts before calling Resend", async () => {
	let requests = 0;
	const mailbox = new HostServiceMailbox(config(), {
		fetch: async () => {
			requests += 1;
			return new Response("{}", { status: 200 });
		},
	});
	await assert.rejects(
		mailbox.list(target, "front-desk:relationship:someone-else", {}),
		(error) => error instanceof ServiceMailboxError
			&& error.status === 403
			&& error.code === "service_mailbox_scope_denied",
	);
	assert.equal(requests, 0);
});
