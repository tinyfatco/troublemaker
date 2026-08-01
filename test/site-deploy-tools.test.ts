import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSiteDeployToolDefinitions } from "../src/tools/site-deploy.js";

const seen: Array<{
	url: string;
	authorization: string | null;
	body: Record<string, unknown>;
}> = [];

const fakeFetch: typeof fetch = async (input, init) => {
	seen.push({
		url: String(input),
		authorization: new Headers(init?.headers).get("authorization"),
		body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
	});
	return new Response(JSON.stringify({
		ok: true,
		url: "https://feature-example.example-business.example.com/",
	}), { status: 200, headers: { "content-type": "application/json" } });
};

function text(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	assert.equal(content?.[0]?.type, "text");
	return content?.[0]?.text || "";
}

assert.deepEqual(createSiteDeployToolDefinitions({}), [], "tool stays hidden outside a Hostd context");

const tools = createSiteDeployToolDefinitions({
	baseUrl: "http://127.0.0.1:3099/",
	token: "fake-site-context-capability",
	contextId: "front-desk:principal:website",
	fetch: fakeFetch,
});
assert.deepEqual(tools.map((tool) => tool.name), ["site_deploy"]);
assert.match(tools[0].description, /preview only/i);
assert.doesNotMatch(tools[0].description, /Cloudflare credential/i);

const callId = `fc_${"a".repeat(36)}|call_${"b".repeat(38)}`;
const result = await tools[0].execute(callId, {
	label: "Deploying the reviewed branch preview",
	directory: "dist",
	branch: "feature/example",
	artifact_kind: "static",
	source_sha: "0123456789abcdef0123456789abcdef01234567",
	message: "Reviewed preview",
});
assert.equal(JSON.parse(text(result)).ok, true);
assert.deepEqual(seen[0], {
	url: "http://127.0.0.1:3099/v1/sites/deploy",
	authorization: "Bearer fake-site-context-capability",
	body: {
		context_id: "front-desk:principal:website",
		idempotency_key: `site_deploy:${createHash("sha256").update(callId, "utf8").digest("hex")}`,
		directory: "dist",
		branch: "feature/example",
		artifact_kind: "static",
		source_sha: "0123456789abcdef0123456789abcdef01234567",
		message: "Reviewed preview",
	},
});

const beforeMissingId = seen.length;
await assert.rejects(
	() => tools[0].execute("", {
		label: "Rejecting an unidentifiable deploy",
		directory: "dist",
		branch: "main",
		artifact_kind: "static",
	}),
	/bounded provider tool-call ID/,
);
assert.equal(seen.length, beforeMissingId);

console.log("site deploy tools: ok");
