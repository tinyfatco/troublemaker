import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createMcpEdgeAssertionHeaders,
	McpEdgeAssertionVerifier,
} from "../src/mcp-edge-auth.mjs";
import { createMcpEdgeServer } from "../src/mcp-edge-server.mjs";
import {
	HostMcp,
	HostMcpError,
} from "../src/mcp.mjs";
import {
	isPublicMcpAddress,
	resolvePublicMcpDestination,
} from "../src/mcp-outbound.mjs";
import {
	initializeHostMcpSettings,
	mcpRuntimeVersionSuffix,
} from "../src/runtime.mjs";
import { contextCapability } from "../src/security.mjs";
import { HostStore } from "../src/store.mjs";

const EDGE_SECRET = "example-MCP-edge-assertion-secret-with-32-bytes";
const CONTEXT_ID = "front-desk:example:intake";
const TARGET = {
	id: "front-desk",
	driver: "oci",
	inboundToken: "example-inbound-token-at-least-32-bytes",
	outboundToken: "example-outbound-token-at-least-32-bytes",
};

function config() {
	return {
		company: { actor: "Example Agent" },
		server: { port: 3099 },
		targetsById: new Map([[TARGET.id, TARGET]]),
		mcp: {
			publicBaseUrl: "https://mcp.example.com/mcp",
			handoffBaseUrl: "https://app.example.com/connect",
			handoffTtlSeconds: 3600,
			maximumRequestBytes: 2 * 1024 * 1024,
			edge: {
				assertionSecret: EDGE_SECRET,
				audience: "troublemaker-hostd-mcp",
				issuers: ["crawdad-cf", "fat-platform"],
				assertionTtlSeconds: 60,
			},
		},
	};
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "hostd-mcp-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	store.createContext({
		id: CONTEXT_ID,
		targetId: TARGET.id,
		driver: "oci",
		runtimeName: "example-runtime",
		port: 32000,
	});
	const changes = [];
	const mcp = new HostMcp({
		config: config(),
		store,
		routingKey: Buffer.alloc(32, 7),
		runtime: { async ensureOciContext() { return { port: 32000 }; } },
		onContextChanged: async (contextId) => { changes.push(contextId); },
	});
	return { directory, store, mcp, changes };
}

test("MCP edge assertions bind issuer, body, bearer credential, and nonce", () => {
	const edge = config().mcp.edge;
	const verifier = new McpEdgeAssertionVerifier(edge, { now: () => 2_000_000_000_000 });
	const body = Buffer.from('{"jsonrpc":"2.0"}');
	const authorization = "Bearer tfat_mcp_example";
	const headers = {
		...createMcpEdgeAssertionHeaders({
			secret: EDGE_SECRET,
			issuer: "crawdad-cf",
			audience: edge.audience,
			method: "POST",
			path: "/v1/mcp/resources/example",
			body,
			authorization,
			timestamp: 2_000_000_000,
			nonce: "example_nonce_1234567890",
		}),
		authorization,
	};
	assert.deepEqual(verifier.verify({
		headers,
		method: "POST",
		path: "/v1/mcp/resources/example",
		body,
		allowedIssuers: ["crawdad-cf"],
	}), { issuer: "crawdad-cf" });
	assert.throws(() => verifier.verify({
		headers,
		method: "POST",
		path: "/v1/mcp/resources/example",
		body,
		allowedIssuers: ["crawdad-cf"],
	}), /invalid MCP edge assertion/);
	const altered = { ...headers, authorization: "Bearer different" };
	assert.throws(() => new McpEdgeAssertionVerifier(edge, {
		now: () => 2_000_000_000_000,
	}).verify({
		headers: altered,
		method: "POST",
		path: "/v1/mcp/resources/example",
		body,
		allowedIssuers: ["crawdad-cf"],
	}), /invalid MCP edge assertion/);
});

test("one-time handoffs keep tokens hashed and upstream credentials encrypted", async () => {
	const { directory, store, mcp, changes } = await fixture();
	try {
		const inboundHandoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "inbound",
			name: "Vellum client",
		});
		const inboundToken = new URL(inboundHandoff.url).hash.slice("#v=".length);
		assert.match(inboundToken, /^tfat_one_/);
		assert.equal(JSON.stringify(store.listMcpHandoffs(CONTEXT_ID)).includes(inboundToken), false);
		assert.equal(mcp.openHandoff(inboundToken).direction, "inbound");

		const inbound = await mcp.completeHandoff(inboundToken, { name: "Vellum client" });
		assert.match(inbound.api_key, /^tfat_mcp_/);
		assert.match(inbound.server_url, /^https:\/\/mcp\.example\.com\/mcp\/resources\/mcp_/);
		assert.equal(JSON.stringify(mcp.list(CONTEXT_ID)).includes(inbound.api_key), false);
		const resourceId = new URL(inbound.server_url).pathname.split("/").at(-1);
		const authenticated = mcp.authenticateInbound(resourceId, `Bearer ${inbound.api_key}`);
		assert.equal(authenticated.grant.contextId, CONTEXT_ID);
		assert.equal(
			mcp.inboundRuntimeToken(TARGET, CONTEXT_ID),
			contextCapability(TARGET.inboundToken, "mcp-ingress", CONTEXT_ID),
		);
		assert.throws(() => mcp.openHandoff(inboundToken), /handoff_unavailable/);

		const outboundHandoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "outbound",
			name: "Custom Vellum",
			server_url: "https://vellum.example.com/mcp",
		});
		const outboundToken = new URL(outboundHandoff.url).hash.slice("#v=".length);
		const outbound = await mcp.completeHandoff(outboundToken, {
			auth_type: "bearer",
			secret: "example-upstream-secret",
		});
		const connection = store.getMcpOutboundConnection(CONTEXT_ID, mcp.list(CONTEXT_ID).outbound[0].id);
		assert.equal(connection.displayName, "Custom Vellum");
		assert.equal(connection.credentialCiphertext.includes("example-upstream-secret"), false);
		assert.equal(mcp.openOutboundCredential(connection), "example-upstream-secret");
		assert.equal(outbound.alias, connection.alias);
		assert.deepEqual(changes, [CONTEXT_ID, CONTEXT_ID]);
		assert.equal(mcpRuntimeVersionSuffix(config(), store, CONTEXT_ID).startsWith(":mcp-"), true);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Hostd-owned MCP settings preserve local entries and contain no upstream credential", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-mcp-settings-"));
	try {
		await writeFile(join(directory, "settings.json"), JSON.stringify({
			defaultThinkingLevel: "high",
			mcpServers: [{ alias: "local-tools", transport: "stdio", command: "example-tool" }],
		}));
		await initializeHostMcpSettings(directory, [{
			id: "00000000-0000-4000-8000-000000000001",
			contextId: CONTEXT_ID,
			alias: "vellum-example",
		}], {
			hostGateway: "host.example",
			serverPort: 3099,
		});
		const raw = await readFile(join(directory, "settings.json"), "utf8");
		const settings = JSON.parse(raw);
		assert.equal(settings.defaultThinkingLevel, "high");
		assert.equal(settings.mcpServers[0].alias, "local-tools");
		assert.deepEqual(settings.mcpServers[1], {
			managedBy: "hostd",
			connectionId: "00000000-0000-4000-8000-000000000001",
			alias: "vellum-example",
			transport: "http",
			url: `http://host.example:3099/v1/mcp/outbound/${encodeURIComponent(CONTEXT_ID)}/00000000-0000-4000-8000-000000000001`,
			tokenEnv: "MOM_MCP_OUTBOUND_TOKEN",
			scopes: [],
		});
		assert.equal(raw.includes("upstream-secret"), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("outbound MCP SSRF checks reject private, mixed, and rebinding destinations", async () => {
	for (const address of [
		"127.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"::1",
		"::ffff:7f00:1",
		"fd00::1",
		"fec0::1",
	]) {
		assert.equal(isPublicMcpAddress(address), false);
	}
	assert.equal(isPublicMcpAddress("93.184.216.34"), true);
	await assert.rejects(
		resolvePublicMcpDestination("https://127.0.0.1/mcp"),
		/mcp_upstream_address_denied/,
	);
	await assert.rejects(
		resolvePublicMcpDestination("https://mcp.example.com/mcp", async () => [
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.0.0.1", family: 4 },
		]),
		/mcp_upstream_address_denied/,
	);
	assert.equal((await resolvePublicMcpDestination(
		"https://mcp.example.com/mcp",
		async () => [{ address: "93.184.216.34", family: 4 }],
	)).address, "93.184.216.34");
});

test("dedicated MCP edge accepts only signed issuer-scoped requests", async () => {
	const seen = [];
	const edgeConfig = config();
	const server = createMcpEdgeServer({
		config: edgeConfig,
		mcp: {
			async proxyInbound(input) {
				seen.push(input);
				return new Response('{"jsonrpc":"2.0","result":{}}', {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		},
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const path = "/v1/mcp/resources/example-resource";
	const body = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
	const authorization = "Bearer tfat_mcp_example";
	try {
		assert.equal((await fetch(`${base}${path}`, { method: "POST", body })).status, 401);
		const response = await fetch(`${base}${path}`, {
			method: "POST",
			headers: {
				authorization,
				"content-type": "application/json",
				...createMcpEdgeAssertionHeaders({
					secret: EDGE_SECRET,
					issuer: "crawdad-cf",
					audience: edgeConfig.mcp.edge.audience,
					method: "POST",
					path,
					body,
					authorization,
				}),
			},
			body,
		});
		assert.equal(response.status, 200);
		assert.equal(seen[0].resourceId, "example-resource");
		assert.equal(seen[0].authorization, authorization);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => (
			error ? reject(error) : resolvePromise()
		)));
	}
});

test("custom auth headers cannot override transport authority", async () => {
	const { directory, store, mcp } = await fixture();
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, { direction: "outbound" });
		const token = new URL(handoff.url).hash.slice("#v=".length);
		await assert.rejects(
			mcp.completeHandoff(token, {
				server_url: "https://vellum.example.com/mcp",
				auth_type: "header",
				header_name: "Host",
				secret: "example-secret",
			}),
			(error) => error instanceof HostMcpError && error.code === "header_name_forbidden",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
