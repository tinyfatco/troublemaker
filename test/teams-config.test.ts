import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasTeamsEnvironment, readTeamsEnvironment } from "../src/adapters/teams-config.js";
import { instantiateConfiguredAdapters } from "../src/host/node/configured-adapters.js";

const base: NodeJS.ProcessEnv = {
	MOM_TEAMS_CLIENT_ID: "00000000-0000-0000-0000-000000000003",
	MOM_TEAMS_CLIENT_SECRET: "synthetic-client-secret",
	MOM_TEAMS_TENANT_ID: "00000000-0000-0000-0000-000000000001",
};

assert.equal(hasTeamsEnvironment({}), false);
assert.equal(hasTeamsEnvironment({ MOM_TEAMS_ALLOWED_TENANTS: "" }), true);
const valid = readTeamsEnvironment(base);
assert.equal(valid.enabled, true);
if (valid.enabled) {
	assert.equal(valid.config.clientId, base.MOM_TEAMS_CLIENT_ID);
	assert.equal(valid.config.directChannelMessages, false);
}

for (const environment of [
	{ ...base, MOM_TEAMS_CLIENT_SECRET: undefined },
	{ ...base, MOM_TEAMS_TENANT_ID: "not-a-tenant-id" },
	{ ...base, MOM_TEAMS_CHANNEL_MESSAGES_DIRECT: "sometimes" },
	{ ...base, MOM_TEAMS_CLOUD: "UnknownCloud" },
	{ ...base, MOM_TEAMS_SERVICE_URL: "http://example.com/teams" },
	{ ...base, MOM_TEAMS_ALLOWED_DM_USERS: "Example Person" },
	{ ...base, MOM_TEAMS_MANAGED_IDENTITY_CLIENT_ID: "system" },
]) {
	assert.equal(readTeamsEnvironment(environment).enabled, false, "malformed Teams configuration disables Teams");
}

const disabled: string[] = [];
const configured = instantiateConfiguredAdapters(
	["slack:socket", "teams:webhook", "telegram:polling"],
	(identity) => {
		if (identity === "teams:webhook") throw new Error("invalid Teams configuration");
		return { identity };
	},
	(identity) => identity === "teams:webhook",
	(identity) => disabled.push(identity),
);
assert.deepEqual(configured.identities, ["slack:socket", "telegram:polling"]);
assert.deepEqual(configured.adapters.map((adapter) => adapter.identity), ["slack:socket", "telegram:polling"]);
assert.deepEqual(disabled, ["teams:webhook"]);
assert.throws(() => instantiateConfiguredAdapters(
	["slack:socket"],
	() => { throw new Error("required adapter failed"); },
	() => false,
	() => {},
), /required adapter failed/);

const workspace = mkdtempSync(join(tmpdir(), "troublemaker-teams-config-test-"));
const port = await availablePort();
const environment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("MOM_TEAMS_")),
);
const child = spawn(process.execPath, [
	"--import",
	"tsx",
	"src/main.ts",
	"--adapter=teams:webhook,web",
	`--port=${port}`,
	workspace,
], {
	cwd: process.cwd(),
	env: {
		...environment,
		MOM_TEAMS_CLIENT_ID: "malformed-client-id",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });
try {
	let healthy = false;
	for (let attempt = 0; attempt < 200; attempt++) {
		if (child.exitCode !== null) break;
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			healthy = response.status === 200 && await response.text() === "ok";
			if (healthy) break;
		} catch {
			// Gateway has not bound yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(healthy, true, `malformed Teams configuration must not prevent the gateway or peer adapter from starting: ${output.slice(-500)}`);
	assert.equal(child.exitCode, null);
} finally {
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		if (child.exitCode !== null) resolve();
		else child.once("exit", () => resolve());
	});
	rmSync(workspace, { recursive: true, force: true });
}

console.log("teams configuration isolation ok");

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("failed to allocate test port");
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}
