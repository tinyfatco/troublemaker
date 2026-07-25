import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGmailToolDefinitions } from "../src/tools/gmail.js";

interface SeenRequest {
	url: string;
	body: Record<string, unknown>;
	authorization: string | null;
}

const seen: SeenRequest[] = [];
const fakeFetch: typeof fetch = async (input, init) => {
	const url = String(input);
	const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
	seen.push({
		url,
		body,
		authorization: new Headers(init?.headers).get("authorization"),
	});
	if (body.query === "fail") {
		return new Response(JSON.stringify({ error: "query_invalid" }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});
	}
	return new Response(JSON.stringify({ ok: true, path: new URL(url).pathname }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
};

function text(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	assert.equal(content?.[0]?.type, "text");
	return content?.[0]?.text || "";
}

function expectedIdempotencyKey(action: "draft" | "send", toolCallId: string): string {
	return `gmail_${action}:${createHash("sha256").update(toolCallId, "utf8").digest("hex")}`;
}

assert.deepEqual(createGmailToolDefinitions({}), [], "tools stay hidden without host context");

const tools = createGmailToolDefinitions({
	baseUrl: "http://127.0.0.1:3099/",
	token: "fake-context-capability",
	contextId: "front-desk:principal:website",
	fetch: fakeFetch,
});
assert.deepEqual(tools.map((tool) => tool.name), [
	"gmail_search",
	"gmail_read",
	"gmail_draft",
	"gmail_send",
]);
const byName = new Map(tools.map((tool) => [tool.name, tool]));
assert.doesNotMatch(
	byName.get("gmail_send")!.description,
	/approval/i,
	"gmail_send should allow autonomous delivery inside the verified context",
);

const search = await byName.get("gmail_search")!.execute("search-call", {
	label: "Finding the current thread",
	query: "newer_than:30d invoice",
	limit: 4,
});
assert.equal(JSON.parse(text(search)).path, "/v1/gmail/search");
assert.deepEqual(seen.at(-1)?.body, {
	context_id: "front-desk:principal:website",
	query: "newer_than:30d invoice",
	limit: 4,
});

await byName.get("gmail_read")!.execute("read-call", {
	label: "Reading the current thread",
	thread_id: "thread-fake",
});
assert.equal(seen.at(-1)?.body.thread_id, "thread-fake");

const providerDraftCallId = `fc_${"a".repeat(36)}|call_${"b".repeat(38)}`;
assert.equal(providerDraftCallId.length, 83, "fixture matches the live provider ID shape");
await byName.get("gmail_draft")!.execute(providerDraftCallId, {
	label: "Saving a draft",
	body: "Draft body",
	to: "person@example.com",
	subject: "Example subject",
});
assert.deepEqual(seen.at(-1)?.body, {
	context_id: "front-desk:principal:website",
	idempotency_key: expectedIdempotencyKey("draft", providerDraftCallId),
	body: "Draft body",
	to: "person@example.com",
	subject: "Example subject",
});
assert.match(String(seen.at(-1)?.body.idempotency_key), /^gmail_draft:[a-f0-9]{64}$/);
assert.doesNotMatch(String(seen.at(-1)?.body.idempotency_key), /\|/);
const firstDraftKey = seen.at(-1)?.body.idempotency_key;
await byName.get("gmail_draft")!.execute(providerDraftCallId, {
	label: "Retrying the same draft call",
	body: "Draft body",
	to: "person@example.com",
	subject: "Example subject",
});
assert.equal(seen.at(-1)?.body.idempotency_key, firstDraftKey, "a provider retry keeps one stable key");

const providerUpdateCallId = `fc_${"c".repeat(36)}|call_${"d".repeat(38)}`;
await byName.get("gmail_draft")!.execute(providerUpdateCallId, {
	label: "Updating a draft",
	body: "Updated body",
	draft_id: "draft-fake",
});
assert.deepEqual(seen.at(-1)?.body, {
	context_id: "front-desk:principal:website",
	idempotency_key: expectedIdempotencyKey("draft", providerUpdateCallId),
	body: "Updated body",
	draft_id: "draft-fake",
});
assert.notEqual(seen.at(-1)?.body.idempotency_key, firstDraftKey, "distinct provider calls stay distinct");

const providerSendCallId = `fc_${"e".repeat(36)}|call_${"f".repeat(38)}`;
await byName.get("gmail_send")!.execute(providerSendCallId, {
	label: "Sending the saved draft",
	draft_id: "draft-fake",
});
assert.deepEqual(seen.at(-1)?.body, {
	context_id: "front-desk:principal:website",
	idempotency_key: expectedIdempotencyKey("send", providerSendCallId),
	draft_id: "draft-fake",
});
assert.match(String(seen.at(-1)?.body.idempotency_key), /^gmail_send:[a-f0-9]{64}$/);
assert.equal(seen.at(-1)?.authorization, "Bearer fake-context-capability");

const requestsBeforeMissingId = seen.length;
await assert.rejects(
	() => byName.get("gmail_draft")!.execute("", {
		label: "Rejecting a missing provider identity",
		body: "Draft body",
		to: "person@example.com",
		subject: "Example subject",
	}),
	/bounded provider tool-call ID/,
);
assert.equal(seen.length, requestsBeforeMissingId, "a missing provider identity never reaches the host");

await assert.rejects(
	() => byName.get("gmail_search")!.execute("failed-search", {
		label: "Testing a rejected search",
		query: "fail",
	}),
	/Gmail request failed \(400\): query_invalid/,
);

console.log("gmail tools: ok");
