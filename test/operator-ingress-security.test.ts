import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorAdapter } from "../src/adapters/operator.js";

async function request(adapter: OperatorAdapter, init: RequestInit = {}): Promise<Response> {
	const server = createServer((incoming, outgoing) => adapter.dispatch(incoming, outgoing));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
		return await fetch(`http://127.0.0.1:${address.port}/operator/read`, init);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-operator-auth-"));
try {
	const disabled = new OperatorAdapter({ workingDir });
	assert.equal((await request(disabled)).status, 503);

	const token = "operator-inbound-token-example-32-bytes";
	const adapter = new OperatorAdapter({ workingDir, inboundToken: token });
	assert.equal((await request(adapter)).status, 401);
	assert.equal((await request(adapter, {
		headers: { "x-crawdad-dev-verified": "true" },
	})).status, 401);
	assert.equal((await request(adapter, {
		headers: { authorization: token },
	})).status, 401);
	const authorized = await request(adapter, {
		headers: { authorization: `Bearer ${token}` },
	});
	assert.equal(authorized.status, 200);
	assert.deepEqual(await authorized.json(), { lines: [], total: 0, offset: 0 });
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("operator ingress security ok");
