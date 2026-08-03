import assert from "node:assert/strict";
import { createServer } from "node:http";
import { withHostReceipt } from "../src/adapters/host-receipt.js";

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{
	url: string;
	close(): Promise<void>;
}> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
	return {
		url: `http://127.0.0.1:${address.port}/receipt`,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}

const statuses: string[] = [];
const accepted = await listen((request, response) => {
	const chunks: Buffer[] = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => {
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status: string; error?: string };
		statuses.push(body.status);
		if (body.status === "completed_with_failure") assert.equal(body.error, "model_credential_unavailable");
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true }));
	});
});
try {
	await withHostReceipt(
		{ url: accepted.url, token: "example-token", leaseToken: "example-lease" },
		async (progress) => {
			await progress.completeWithOperationalFailure("model_credential_unavailable");
		},
	);
	assert.deepEqual(statuses, ["running", "completed_with_failure"]);
} finally {
	await accepted.close();
}

const fallbackStatuses: string[] = [];
const fallback = await listen((request, response) => {
	const chunks: Buffer[] = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => {
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status: string };
		fallbackStatuses.push(body.status);
		response.writeHead(body.status === "completed_with_failure" ? 400 : 200);
		response.end();
	});
});
try {
	await withHostReceipt(
		{ url: fallback.url, token: "example-token", leaseToken: "example-lease" },
		async (progress) => {
			await progress.completeWithOperationalFailure("model_run_error");
		},
	);
	assert.deepEqual(fallbackStatuses, ["running", "completed_with_failure", "completed"]);
	assert.equal(fallbackStatuses.includes("failed"), false);
} finally {
	await fallback.close();
}

console.log("host receipt operational failure ok");
