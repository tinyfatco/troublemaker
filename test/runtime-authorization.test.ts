import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { Type } from "typebox";
import { requireRuntimeAuthorization, RuntimeAuthorizationError } from "../src/runtime-authorization.js";
import { enforceRequiredToolLabel } from "../src/tools/tool-label.js";

const URL_ENV = "TROUBLEMAKER_RUNTIME_AUTHORIZATION_URL";
const TOKEN_ENV = "TROUBLEMAKER_RUNTIME_AUTHORIZATION_TOKEN";
const TOKEN = "example-runtime-capability-at-least-32-bytes";

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

async function withAuthorizationEnvironment(url: string | undefined, run: () => Promise<void>): Promise<void> {
	const previousUrl = process.env[URL_ENV];
	const previousToken = process.env[TOKEN_ENV];
	if (url === undefined) {
		delete process.env[URL_ENV];
		delete process.env[TOKEN_ENV];
	} else {
		process.env[URL_ENV] = url;
		process.env[TOKEN_ENV] = TOKEN;
	}
	try {
		await run();
	} finally {
		if (previousUrl === undefined) delete process.env[URL_ENV];
		else process.env[URL_ENV] = previousUrl;
		if (previousToken === undefined) delete process.env[TOKEN_ENV];
		else process.env[TOKEN_ENV] = previousToken;
	}
}

test("ordinary runtimes do not call an authorization service", async () => {
	await withAuthorizationEnvironment(undefined, async () => {
		await requireRuntimeAuthorization("model");
	});
});

test("configured runtime authorization is request-bound and exact", async () => {
	const requests: Array<{ authorization: string; body: unknown }> = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			requests.push({
				authorization: String(request.headers.authorization || ""),
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, expiresAt: new Date(Date.now() + 30_000).toISOString() }));
		});
	});
	const port = await listen(server);
	try {
		await withAuthorizationEnvironment(`http://127.0.0.1:${port}/v1/runtime/authorize`, async () => {
			await requireRuntimeAuthorization("tool");
		});
		assert.deepEqual(requests, [{
			authorization: `Bearer ${TOKEN}`,
			body: { version: "1", boundary: "tool" },
		}]);
	} finally {
		await close(server);
	}
});

test("rejected, malformed, and partially configured guards fail closed", async () => {
	const server = createServer((_request, response) => {
		response.writeHead(403, { "content-type": "application/json" });
		response.end('{"error":"revoked"}');
	});
	const port = await listen(server);
	try {
		await withAuthorizationEnvironment(`http://127.0.0.1:${port}/authorize`, async () => {
			await assert.rejects(requireRuntimeAuthorization("model"), RuntimeAuthorizationError);
		});
		const previousUrl = process.env[URL_ENV];
		const previousToken = process.env[TOKEN_ENV];
		process.env[URL_ENV] = `http://127.0.0.1:${port}/authorize`;
		delete process.env[TOKEN_ENV];
		try {
			await assert.rejects(requireRuntimeAuthorization("model"), RuntimeAuthorizationError);
		} finally {
			if (previousUrl === undefined) delete process.env[URL_ENV];
			else process.env[URL_ENV] = previousUrl;
			if (previousToken === undefined) delete process.env[TOKEN_ENV];
			else process.env[TOKEN_ENV] = previousToken;
		}
	} finally {
		await close(server);
	}
});

test("the universal tool wrapper reauthorizes before executing a tool", async () => {
	let authorized = false;
	let executed = false;
	const server = createServer((_request, response) => {
		authorized = true;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true, expiresAt: new Date(Date.now() + 30_000).toISOString() }));
	});
	const port = await listen(server);
	try {
		await withAuthorizationEnvironment(`http://127.0.0.1:${port}/authorize`, async () => {
			const tool = enforceRequiredToolLabel({
				name: "example_tool",
				label: "example_tool",
				description: "Synthetic tool",
				parameters: Type.Object({}),
				execute: async () => {
					assert.equal(authorized, true);
					executed = true;
					return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
				},
			});
			await tool.execute("call-1", { label: "Running synthetic tool" });
		});
		assert.equal(executed, true);
	} finally {
		await close(server);
	}
});
