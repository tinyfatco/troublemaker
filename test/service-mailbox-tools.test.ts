import assert from "node:assert/strict";
import { createServiceMailboxToolDefinitions } from "../src/tools/service-mailbox.js";

const seen: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
const fakeFetch: typeof fetch = async (input, init) => {
	const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
	seen.push({
		url: String(input),
		body,
		authorization: new Headers(init?.headers).get("authorization"),
	});
	if (body.email_id === "fail") {
		return new Response(JSON.stringify({ error: "email_id_invalid" }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
};

function text(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	assert.equal(content?.[0]?.type, "text");
	return content?.[0]?.text || "";
}

assert.deepEqual(createServiceMailboxToolDefinitions({}), [], "tools stay hidden without an exact Hostd grant");

const tools = createServiceMailboxToolDefinitions({
	baseUrl: "http://127.0.0.1:3099/",
	token: "fake-service-mailbox-capability",
	contextId: "front-desk:relationship:relationship-example",
	address: "scout@example.com",
	fetch: fakeFetch,
});
assert.deepEqual(tools.map((tool) => tool.name), ["service_mailbox_list", "service_mailbox_read"]);
const byName = new Map(tools.map((tool) => [tool.name, tool]));
assert.match(byName.get("service_mailbox_read")!.description, /untrusted/i);
assert.match(byName.get("service_mailbox_list")!.description, /scout@example\.com/);

const listed = await byName.get("service_mailbox_list")!.execute("list-call", {
	label: "Checking the agent inbox",
	limit: 7,
});
assert.equal(JSON.parse(text(listed)).ok, true);
assert.deepEqual(seen.at(-1), {
	url: "http://127.0.0.1:3099/v1/service-mailbox/list",
	body: {
		context_id: "front-desk:relationship:relationship-example",
		limit: 7,
	},
	authorization: "Bearer fake-service-mailbox-capability",
});

await byName.get("service_mailbox_read")!.execute("read-call", {
	label: "Reading one verification message",
	email_id: "mail_owner_1",
});
assert.deepEqual(seen.at(-1)?.body, {
	context_id: "front-desk:relationship:relationship-example",
	email_id: "mail_owner_1",
});

await assert.rejects(
	() => byName.get("service_mailbox_read")!.execute("read-failure", {
		label: "Rejecting a malformed message ID",
		email_id: "fail",
	}),
	/Service mailbox request failed \(400\): email_id_invalid/,
);

console.log("service mailbox tools: ok");
