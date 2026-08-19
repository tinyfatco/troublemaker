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
				issuerSecrets: {
					"crawdad-cf": EDGE_SECRET,
					"fat-platform": `${EDGE_SECRET}-fat`,
				},
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
	store.ensurePrincipal("example-principal", undefined, "Example principal");
	store.ensureProject("example-principal", "intake", "Intake");
	store.bindRoute({
		source: "phone",
		providerThreadId: "example-thread",
		principalHash: "example-principal",
		projectSlug: "intake",
		targetId: TARGET.id,
		contextId: CONTEXT_ID,
	});
	store.upsertPhoneConversation({
		threadTarget: "phone-example",
		provider: "example",
		providerThreadId: "example-thread",
		principalHash: "example-principal",
		targetId: TARGET.id,
		contextId: CONTEXT_ID,
		contactCiphertext: "sealed-example-contact",
		contactLastFour: "0123",
	});
	const changes = [];
	const pumps = [];
	const mcp = new HostMcp({
		config: config(),
		store,
		routingKey: Buffer.alloc(32, 7),
		runtime: { async ensureOciContext() { return { port: 32000 }; } },
		onContextChanged: async (contextId) => { changes.push(contextId); },
		onEventQueued: () => { pumps.push("pump"); },
	});
	return { directory, store, mcp, changes, pumps };
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

test("MCP edge replay denial survives verifier recreation and keys are issuer-specific", async () => {
	const { directory, store } = await fixture();
	try {
		const edge = config().mcp.edge;
		const body = Buffer.from("{}");
		const authorization = "Bearer tfat_mcp_example";
		const headers = {
			...createMcpEdgeAssertionHeaders({
				secret: edge.issuerSecrets["crawdad-cf"],
				issuer: "crawdad-cf",
				audience: edge.audience,
				method: "POST",
				path: "/v1/mcp/resources/example",
				body,
				authorization,
				timestamp: 2_000_000_000,
				nonce: "durable_nonce_1234567890",
			}),
			authorization,
		};
		const verify = () => new McpEdgeAssertionVerifier(edge, {
			now: () => 2_000_000_000_000,
			consumeNonce: (issuer, nonce, expiresAt) => store.consumeMcpEdgeNonce(issuer, nonce, expiresAt),
		}).verify({
			headers,
			method: "POST",
			path: "/v1/mcp/resources/example",
			body,
			allowedIssuers: ["crawdad-cf"],
		});
		assert.deepEqual(verify(), { issuer: "crawdad-cf" });
		assert.throws(verify, /invalid MCP edge assertion/);
		const wrongIssuerKey = {
			...headers,
			...createMcpEdgeAssertionHeaders({
				secret: edge.issuerSecrets["fat-platform"],
				issuer: "crawdad-cf",
				audience: edge.audience,
				method: "POST",
				path: "/v1/mcp/resources/example",
				body,
				authorization,
				timestamp: 2_000_000_000,
				nonce: "wrong_key_nonce_123456789",
			}),
		};
		assert.throws(() => new McpEdgeAssertionVerifier(edge, {
			now: () => 2_000_000_000_000,
		}).verify({
			headers: wrongIssuerKey,
			method: "POST",
			path: "/v1/mcp/resources/example",
			body,
			allowedIssuers: ["crawdad-cf"],
		}), /invalid MCP edge assertion/);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("MCP handoffs fail closed when a context owns more than one relationship route", async () => {
	const { directory, store, mcp } = await fixture();
	try {
		store.bindRoute({
			source: "gmail",
			providerThreadId: "second-thread",
			principalHash: "example-principal",
			projectSlug: "intake",
			targetId: TARGET.id,
			contextId: CONTEXT_ID,
		});
		assert.throws(
			() => mcp.createHandoff(TARGET, CONTEXT_ID, { direction: "inbound" }),
			(error) => error instanceof HostMcpError && error.code === "relationship_ambiguous",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("one-time handoffs keep tokens hashed and upstream credentials encrypted", async () => {
	const { directory, store, mcp, changes } = await fixture();
	try {
		const canceledHandoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "inbound",
			name: "Canceled handoff",
		});
		const canceledToken = new URL(canceledHandoff.url).hash.slice("#v=".length);
		await mcp.revoke(CONTEXT_ID, { direction: "handoff", id: canceledHandoff.id });
		assert.throws(() => mcp.openHandoff(canceledToken), /handoff_unavailable/);

		const inboundHandoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "inbound",
			name: "Vellum client",
		});
		const inboundToken = new URL(inboundHandoff.url).hash.slice("#v=".length);
		assert.match(inboundToken, /^tfat_one_/);
		assert.equal(JSON.stringify(store.listMcpHandoffs(CONTEXT_ID)).includes(inboundToken), false);
		assert.equal(JSON.stringify(inboundHandoff).includes("+15555550123"), false);
		const openedInbound = mcp.openHandoff(inboundToken);
		assert.equal(openedInbound.direction, "inbound");
		assert.match(openedInbound.session_token, /^tfat_session_/);
		assert.throws(() => mcp.openHandoff(inboundToken), /handoff_unavailable/);
		assert.equal(mcp.openHandoff(openedInbound.session_token).direction, "inbound");
		assert.equal(openedInbound.relationship.recipient_hint, "ending 0123");

		const inbound = await mcp.completeHandoff(openedInbound.session_token, { name: "Vellum client" });
		assert.match(inbound.api_key, /^tfat_mcp_/);
		assert.match(inbound.server_url, /^https:\/\/mcp\.example\.com\/mcp\/resources\/mcp_/);
		assert.equal(JSON.stringify(mcp.list(CONTEXT_ID)).includes(inbound.api_key), false);
		const resourceId = new URL(inbound.server_url).pathname.split("/").at(-1);
		const authenticated = mcp.authenticateInbound(resourceId, `Bearer ${inbound.api_key}`);
		assert.equal(authenticated.grant.contextId, CONTEXT_ID);
		assert.throws(() => mcp.openHandoff(inboundToken), /handoff_unavailable/);

		const outboundHandoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "outbound",
			name: "Custom Vellum",
			server_url: "https://vellum.example.com/mcp",
		});
		const outboundToken = new URL(outboundHandoff.url).hash.slice("#v=".length);
		const outboundSession = mcp.openHandoff(outboundToken).session_token;
		const outbound = await mcp.completeHandoff(outboundSession, {
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

test("an established grant fails closed if its context later becomes relationship-ambiguous", async () => {
	const { directory, store, mcp } = await fixture();
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "inbound",
			name: "Example client",
		});
		const oneTimeToken = new URL(handoff.url).hash.slice("#v=".length);
		const sessionToken = mcp.openHandoff(oneTimeToken).session_token;
		const connected = await mcp.completeHandoff(sessionToken, {});
		const resourceId = new URL(connected.server_url).pathname.split("/").at(-1);
		store.bindRoute({
			source: "gmail",
			providerThreadId: "later-route",
			principalHash: "example-principal",
			projectSlug: "intake",
			targetId: TARGET.id,
			contextId: CONTEXT_ID,
		});
		assert.throws(
			() => mcp.authenticateInbound(resourceId, `Bearer ${connected.api_key}`),
			(error) => error instanceof HostMcpError && error.code === "unauthorized",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("inbound MCP exposes only an idempotent relationship Operator instruction", async () => {
	const { directory, store, mcp, pumps } = await fixture();
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "inbound",
			name: "Ghost",
		});
		const oneTimeToken = new URL(handoff.url).hash.slice("#v=".length);
		const sessionToken = mcp.openHandoff(oneTimeToken).session_token;
		const connected = await mcp.completeHandoff(sessionToken, { name: "Ghost" });
		const resourceId = new URL(connected.server_url).pathname.split("/").at(-1);
		const authorization = `Bearer ${connected.api_key}`;
		const requestHeaders = { "content-type": "application/json" };

		const initialize = await mcp.proxyInbound({
			resourceId,
			authorization,
			requestHeaders,
			body: Buffer.from(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18" },
			})),
		});
		assert.equal(initialize.status, 200);
		assert.equal((await initialize.json()).result.serverInfo.name, "tinyfat-relationship-operator");
		assert.equal(store.listContexts().some((context) => context.status === "online"), false);

		const listed = await mcp.proxyInbound({
			resourceId,
			authorization,
			requestHeaders,
			body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })),
		});
		const tools = (await listed.json()).result.tools;
		assert.deepEqual(tools.map((tool) => tool.name), ["instruct_operator"]);
		assert.deepEqual(tools[0].inputSchema.required, ["instruction", "idempotency_key"]);
		assert.equal(JSON.stringify(tools[0]).includes("recipient"), true);
		assert.equal(JSON.stringify(tools[0].inputSchema.properties).includes("recipient"), false);

		const call = (instruction) => mcp.proxyInbound({
			resourceId,
			authorization,
			requestHeaders,
			body: Buffer.from(JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					name: "instruct_operator",
					arguments: {
						instruction,
						idempotency_key: "acceptance:ghost:0001",
					},
				},
			})),
		});
		const first = (await (await call("Send one bounded acceptance message.")).json()).result.structuredContent;
		assert.equal(first.status, "queued");
		assert.equal(first.duplicate, false);
		assert.equal(first.relationship.recipient_hint, "ending 0123");
		const event = store.getEvent(first.receipt_id);
		assert.equal(event.source, "mcp-operator");
		assert.equal(event.contextId, CONTEXT_ID);
		assert.equal(event.principalHash, "example-principal");
		assert.equal(pumps.length, 1);

		const duplicate = (await (await call("Send one bounded acceptance message.")).json()).result.structuredContent;
		assert.equal(duplicate.receipt_id, first.receipt_id);
		assert.equal(duplicate.duplicate, true);
		assert.equal(pumps.length, 1);
		const conflict = await (await call("A different instruction.")).json();
		assert.equal(conflict.error.message, "idempotency_conflict");
		const substitution = await (await mcp.proxyInbound({
			resourceId,
			authorization,
			requestHeaders,
			body: Buffer.from(JSON.stringify({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: {
					name: "instruct_operator",
					arguments: {
						instruction: "Try another recipient.",
						idempotency_key: "acceptance:ghost:0002",
						recipient: "substitution-is-forbidden",
					},
				},
			})),
		})).json();
		assert.equal(substitution.error.message, "arguments_invalid");
		assert.equal(pumps.length, 1);

		assert.equal(await mcp.revoke(CONTEXT_ID, { direction: "inbound", id: resourceId }).then(() => true), true);
		assert.equal(store.getEvent(first.receipt_id).status, "dead");
		assert.throws(
			() => mcp.authenticateInbound(resourceId, authorization),
			(error) => error instanceof HostMcpError && error.code === "unauthorized",
		);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("queued relationship instructions and receipts survive a Hostd store restart", async () => {
	const { directory, store, mcp } = await fixture();
	let reopened;
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, { direction: "inbound", name: "Ghost" });
		const oneTimeToken = new URL(handoff.url).hash.slice("#v=".length);
		const sessionToken = mcp.openHandoff(oneTimeToken).session_token;
		const connected = await mcp.completeHandoff(sessionToken, { name: "Ghost" });
		const resourceId = new URL(connected.server_url).pathname.split("/").at(-1);
		const response = await mcp.proxyInbound({
			resourceId,
			authorization: `Bearer ${connected.api_key}`,
			requestHeaders: { "content-type": "application/json" },
			body: Buffer.from(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "instruct_operator",
					arguments: {
						instruction: "Durable restart check.",
						idempotency_key: "restart-check-0001",
					},
				},
			})),
		});
		const receiptId = (await response.json()).result.structuredContent.receipt_id;
		store.close();
		reopened = new HostStore(join(directory, "state.sqlite"));
		const receipt = reopened.getMcpInstructionReceiptByEvent(receiptId);
		assert.equal(receipt.status, "queued");
		assert.equal(receipt.contextId, CONTEXT_ID);
		const claimed = reopened.claimNextEvent();
		assert.equal(claimed.id, receiptId);
		assert.equal(claimed.contextId, CONTEXT_ID);
	} finally {
		reopened?.close();
		try { store.close(); } catch {}
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
		"192.88.99.1",
		"240.0.0.1",
		"2001:0000:0000:0000:0000:0000:0000:0001",
		"2001:0db8::1",
		"2002:0a00:0001::1",
		"3fff::1",
		"64:ff9b::a00:1",
	]) {
		assert.equal(isPublicMcpAddress(address), false);
	}
	assert.equal(isPublicMcpAddress("93.184.216.34"), true);
	assert.equal(isPublicMcpAddress("2606:4700:4700::1111"), true);
	await assert.rejects(
		resolvePublicMcpDestination("https://mcp.example.com/mcp?target=other"),
		/server_url_invalid/,
	);
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
		const sessionToken = mcp.openHandoff(token).session_token;
		await assert.rejects(
			mcp.completeHandoff(sessionToken, {
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
