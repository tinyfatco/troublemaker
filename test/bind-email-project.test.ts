import assert from "node:assert/strict";
import { createBindEmailProjectTool } from "../src/tools/bind-email-project.js";

async function run() {
	assert.equal(createBindEmailProjectTool({}), null);

	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const tool = createBindEmailProjectTool({
		TROUBLEMAKER_HOSTD_URL: "http://host.containers.internal:3099",
		TROUBLEMAKER_CONTEXT_ID: "front-desk:principal:intake",
		MOM_EMAIL_TOOLS_TOKEN: "scoped-token",
	}, async (input, init) => {
		calls.push({ url: String(input), init });
		return new Response(JSON.stringify({
			ok: true,
			project: "company-website",
			context: "front-desk:principal:company-website",
			appliesTo: "future turns in this Gmail thread",
		}), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	assert(tool);

	const result = await tool.execute("call-1", {
		provider_thread_id: "gmail_thread_123",
		project_slug: "company-website",
		project_name: "Company website",
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, "http://host.containers.internal:3099/v1/context/bind-project");
	assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>).authorization, "Bearer scoped-token");
	assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
		context_id: "front-desk:principal:intake",
		provider_thread_id: "gmail_thread_123",
		project_slug: "company-website",
		project_name: "Company website",
	});
	assert.match(String(result.content[0]?.text), /future turns/);
}

run().then(() => {
	console.log("bind-email-project ok");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
