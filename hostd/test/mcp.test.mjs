import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	createMcpEdgeAssertionHeaders,
	McpEdgeAssertionVerifier,
} from "../src/mcp-edge-auth.mjs";
import { ChannelControlNotifier } from "../src/channel-control-notifier.mjs";
import { createMcpEdgeServer } from "../src/mcp-edge-server.mjs";
import {
	HostMcp,
	HostMcpError,
} from "../src/mcp.mjs";
import { relationshipOperatorContextId } from "../src/relationship-context.mjs";
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
const ROUTING_KEY = Buffer.alloc(32, 7);
const TARGET = {
	id: "front-desk",
	driver: "oci",
	inboundToken: "example-inbound-token-at-least-32-bytes",
	outboundToken: "example-outbound-token-at-least-32-bytes",
};
const ROUTE = {
	targetId: TARGET.id,
	source: "phone",
	providerThreadId: "example-thread",
	principalHash: "example-principal",
	projectSlug: "intake",
};
const CONTEXT_ID = relationshipOperatorContextId(ROUTING_KEY, ROUTE);

function oneTimeToken(value) {
	const url = new URL(value);
	return url.searchParams.get("v") || new URLSearchParams(url.hash.slice(1)).get("v") || "";
}

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
		threadTarget: "phone-0123456789abcdef0123",
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
		routingKey: ROUTING_KEY,
		runtime: { async ensureOciContext() { return { port: 32000 }; } },
		onContextChanged: async (contextId) => { changes.push(contextId); },
		onEventQueued: () => { pumps.push("pump"); },
	});
	return { directory, store, mcp, changes, pumps };
}

test("Hostd preserves existing handoffs while widening the one-time schema", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-mcp-handoff-migration-"));
	const path = join(directory, "state.sqlite");
	const legacy = new DatabaseSync(path);
	legacy.exec(`
		CREATE TABLE contexts (
			id TEXT PRIMARY KEY,
			target_id TEXT NOT NULL,
			driver TEXT NOT NULL,
			runtime_name TEXT,
			port INTEGER,
			status TEXT NOT NULL,
			created_at TEXT NOT NULL,
			last_seen_at TEXT NOT NULL
		);
		INSERT INTO contexts(
			id, target_id, driver, status, created_at, last_seen_at
		) VALUES (
			'legacy-context', 'front-desk', 'oci', 'stopped',
			'2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z'
		);
		CREATE TABLE mcp_handoffs (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			target_id TEXT NOT NULL,
			context_id TEXT NOT NULL,
			direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound', 'either')),
			display_name TEXT NOT NULL,
			upstream_url TEXT,
			allowed_auth_json TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
				CHECK(status IN ('pending', 'completed', 'expired', 'revoked')),
			result_id TEXT,
			opened_at TEXT,
			completed_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		INSERT INTO mcp_handoffs(
			id, token_hash, target_id, context_id, direction, display_name,
			allowed_auth_json, expires_at, status, created_at, updated_at
		) VALUES (
			'legacy-handoff', 'legacy-token-hash', 'front-desk', 'legacy-context',
			'inbound', 'Legacy handoff', '[]', '2099-01-01T00:00:00.000Z',
			'pending', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z'
		);
	`);
	legacy.close();
	let store;
	try {
		store = new HostStore(path);
		assert.equal(store.getMcpHandoff("legacy-handoff").displayName, "Legacy handoff");
		const schema = store.database.prepare(`
			SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mcp_handoffs'
		`).get().sql;
		assert.match(schema, /'bidirectional'/);
		assert.equal(
			store.database.prepare("SELECT COUNT(*) AS count FROM mcp_handoffs").get().count,
			1,
		);
	} finally {
		store?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

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

test("legacy phone custody is atomically rehomed into one relationship Operator context", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-mcp-rehome-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const legacyContextId = "front-desk:example-principal:intake";
	try {
		store.createContext({
			id: legacyContextId,
			targetId: TARGET.id,
			driver: "oci",
			runtimeName: "legacy-runtime",
			port: 32001,
		});
		store.ensurePrincipal(ROUTE.principalHash, undefined, "Example principal");
		store.ensureProject(ROUTE.principalHash, ROUTE.projectSlug, "Intake");
		store.bindRoute({ ...ROUTE, contextId: legacyContextId });
		store.upsertPhoneConversation({
			threadTarget: "phone-legacy",
			provider: "example",
			providerThreadId: ROUTE.providerThreadId,
			principalHash: ROUTE.principalHash,
			targetId: TARGET.id,
			contextId: legacyContextId,
			contactCiphertext: "sealed-example-contact",
			contactLastFour: "0123",
		});
		const relationship = store.bindMcpRelationship({
			...ROUTE,
			contextId: legacyContextId,
			profile: "relationship-operator-v1",
			recipientHint: "ending 0123",
		});
		store.upsertEvent({
			id: "legacy-event",
			source: "phone",
			providerMessageId: "legacy-provider-message",
			providerThreadId: ROUTE.providerThreadId,
			principalHash: ROUTE.principalHash,
			targetId: TARGET.id,
			contextId: legacyContextId,
			payload: { message: { body: "historical" } },
		});
		store.setMeta("scheduler:draining", "true");

		const runtime = {
			async rehomeStoppedContext(target, fromContextId, toContextId, options) {
				return {
					...store.rehomeContext({
						fromContextId,
						toContextId,
						targetId: target.id,
						runtimeName: "relationship-runtime",
						relationshipId: options.relationshipId,
					}),
					workspaceMoved: true,
					retainedStoppedRuntime: "legacy-runtime",
				};
			},
		};
		const scheduledConfig = config();
		scheduledConfig.scheduledWakes = { mode: "host", contextIds: [legacyContextId] };
		const scheduleBound = new HostMcp({
			config: scheduledConfig,
			store,
			routingKey: ROUTING_KEY,
			runtime,
		});
		await assert.rejects(
			scheduleBound.rehomeRelationshipContext(TARGET, legacyContextId),
			(error) => error instanceof HostMcpError
				&& error.code === "relationship_context_schedule_config_migration_required",
		);
		const mcp = new HostMcp({ config: config(), store, routingKey: ROUTING_KEY, runtime });
		store.startOutbox({
			idempotencyKey: "maintenance-in-progress",
			targetId: TARGET.id,
			contextId: legacyContextId,
			providerThreadId: ROUTE.providerThreadId,
		});
		await assert.rejects(
			mcp.rehomeRelationshipContext(TARGET, legacyContextId),
			(error) => error instanceof HostMcpError
				&& error.code === "relationship_context_not_stopped",
			"in-flight host-owned delivery must block custody movement",
		);
		store.failOutbox("maintenance-in-progress", "test maintenance release");
		assert.throws(
			() => mcp.assertRelationship(relationship),
			(error) => error instanceof HostMcpError && error.code === "relationship_unavailable",
			"an existing grant cannot use a legacy intake-bound relationship",
		);
		assert.throws(
			() => mcp.createHandoff(TARGET, legacyContextId, { direction: "inbound" }),
			(error) => error instanceof HostMcpError
				&& error.code === "relationship_context_migration_required",
		);
		const migrated = await mcp.rehomeRelationshipContext(TARGET, legacyContextId);
		assert.equal(migrated.migrated, true);
		assert.equal(migrated.to_context_id, CONTEXT_ID);
		assert.equal(migrated.relationship_id, relationship.id);
		assert.equal(migrated.workspace_moved, true);
		assert.equal(store.getContext(legacyContextId), undefined);
		assert.equal(store.getContext(CONTEXT_ID).port, 32001);
		assert.equal(store.getRoute(ROUTE.source, ROUTE.providerThreadId).contextId, CONTEXT_ID);
		assert.equal(store.getPhoneConversation("phone-legacy").contextId, CONTEXT_ID);
		assert.equal(store.getEvent("legacy-event").contextId, CONTEXT_ID);
		assert.equal(store.getOutbox("maintenance-in-progress").contextId, CONTEXT_ID);
		assert.equal(store.getMcpRelationship(relationship.id).contextId, CONTEXT_ID);
		assert.equal(store.listContextRehomes().length, 1);
		assert.equal(store.listContextRehomes()[0].relationshipId, relationship.id);
		assert.equal(
			mcp.createHandoff(TARGET, CONTEXT_ID, { direction: "inbound" }).relationship.recipient_hint,
			"ending 0123",
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
		const canceledToken = oneTimeToken(canceledHandoff.url);
		await mcp.revoke(CONTEXT_ID, { direction: "handoff", id: canceledHandoff.id });
		assert.throws(() => mcp.openHandoff(canceledToken), /handoff_unavailable/);

		const inboundHandoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "inbound",
			name: "Vellum client",
		});
		const inboundToken = oneTimeToken(inboundHandoff.url);
		assert.match(inboundToken, /^tfat_one_/);
		assert.match(inboundHandoff.url, /^https:\/\/app\.example\.com\/connect\?v=tfat_one_[A-Za-z0-9_-]{24}$/);
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
		const outboundToken = oneTimeToken(outboundHandoff.url);
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

test("one bidirectional Vellum handoff atomically creates both exact-relationship connections", async () => {
	const { directory, store, mcp, changes } = await fixture();
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "bidirectional",
			name: "Example user's Vellum",
		});
		assert.match(handoff.url, /^https:\/\/app\.example\.com\/connect\?v=tfat_one_/);
		const session = mcp.openHandoff(oneTimeToken(handoff.url));
		assert.equal(session.direction, "bidirectional");
		assert.deepEqual(session.allowed_auth, ["bearer", "header"]);

		await assert.rejects(
			mcp.completeHandoff(session.session_token, {
				direction: "bidirectional",
				name: "Example user's Vellum",
				server_url: "https://vellum.example.com/mcp",
				auth_type: "header",
				header_name: "X-API-KEY",
				secret_name: "VELLUM_API_KEY",
			}),
			(error) => error instanceof HostMcpError && error.code === "secret_required",
		);
		assert.equal(store.getMcpHandoff(handoff.id).status, "pending");
		assert.equal(store.listMcpInboundGrants(CONTEXT_ID).length, 0);
		assert.equal(store.listMcpOutboundConnections(CONTEXT_ID).length, 0);

		const completed = await mcp.completeHandoff(session.session_token, {
			direction: "bidirectional",
			name: "Example user's Vellum",
			server_url: "https://vellum.example.com/mcp",
			auth_type: "header",
			header_name: "X-API-KEY",
			secret_name: "VELLUM_API_KEY",
			secret: "vellum-example-secret",
		});
		assert.equal(completed.direction, "bidirectional");
		assert.equal(completed.tool, "message_tinyfat");
		assert.match(completed.server_url, /^https:\/\/mcp\.example\.com\/mcp\/resources\/mcp_/);
		assert.match(completed.api_key, /^tfat_mcp_/);
		assert.equal(completed.upstream_server_url, "https://vellum.example.com/mcp");
		assert.equal(completed.credential_name, "VELLUM_API_KEY");
		const inbound = store.listMcpInboundGrants(CONTEXT_ID);
		const outbound = store.listMcpOutboundConnections(CONTEXT_ID);
		assert.equal(inbound.length, 1);
		assert.equal(outbound.length, 1);
		assert.equal(inbound[0].relationshipId, outbound[0].relationshipId);
		assert.equal(outbound[0].credentialName, "VELLUM_API_KEY");
		const sealed = store.getMcpOutboundConnection(CONTEXT_ID, outbound[0].id);
		assert.equal(sealed.credentialCiphertext.includes("vellum-example-secret"), false);
		assert.equal(mcp.openOutboundCredential(sealed), "vellum-example-secret");
		assert.equal(JSON.stringify(mcp.list(CONTEXT_ID)).includes("vellum-example-secret"), false);
		assert.deepEqual(changes, [CONTEXT_ID]);
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("a GitHub or config-only Vellum handoff seals the key and queues exact-context review", async () => {
	const { directory, store, mcp, changes, pumps } = await fixture();
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "bidirectional",
			name: "Vellum custom MCP",
		});
		const sessionToken = mcp.openHandoff(oneTimeToken(handoff.url)).session_token;
		const setupMaterial = "https://github.com/example/custom-vellum-mcp";
		const secretValue = "vellum-review-secret";
		const completed = await mcp.completeHandoff(sessionToken, {
			direction: "bidirectional",
			name: "Vellum custom MCP",
			secret_name: "VELLUM_API_KEY",
			auth_type: "header",
			header_name: "X-API-KEY",
			secret: secretValue,
			setup_material: setupMaterial,
		});
		assert.equal(completed.setup_status, "review_queued");
		assert.match(completed.api_key, /^tfat_mcp_/);
		assert.equal(store.listMcpOutboundConnections(CONTEXT_ID).length, 0);
		const [setup] = store.listMcpSetupRequests(CONTEXT_ID);
		assert.equal(setup.id, completed.setup_request_id);
		assert.equal(setup.status, "pending");
		assert.equal(setup.credentialName, "VELLUM_API_KEY");
		assert.equal(setup.credentialCiphertext.includes(secretValue), false);
		assert.equal(setup.setupMaterialCiphertext.includes(setupMaterial), false);
		const event = store.getEvent(setup.eventId);
		assert.equal(event.contextId, CONTEXT_ID);
		assert.equal(event.source, "mcp-operator");
		assert.equal(event.payloadJson.includes(setupMaterial), true);
		assert.equal(event.payloadJson.includes(secretValue), false);
		assert.equal(store.claimNextEvent(), null, "review waits for exact-channel projection");
		const notification = store.claimControlNotification();
		assert.equal(notification.eventId, event.id);
		store.completeControlNotification(notification.id, "zulip-review-message");
		assert.equal(store.claimNextEvent().id, event.id);
		assert.equal(JSON.stringify(mcp.list(CONTEXT_ID)).includes(secretValue), false);
		assert.equal(JSON.stringify(mcp.list(CONTEXT_ID)).includes(setupMaterial), false);
		assert.deepEqual(changes, [CONTEXT_ID]);
		assert.deepEqual(pumps, ["pump"]);
		const grantId = new URL(completed.server_url).pathname.split("/").at(-1);
		await mcp.revoke(CONTEXT_ID, { direction: "inbound", id: grantId });
		assert.equal(store.getMcpSetupRequest(CONTEXT_ID, setup.id).status, "revoked");
		assert.equal(store.getEvent(event.id).status, "dead");
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
		const token = oneTimeToken(handoff.url);
		const sessionToken = mcp.openHandoff(token).session_token;
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

test("inbound MCP exposes only an idempotent exact-context message", async () => {
	const { directory, store, mcp, pumps } = await fixture();
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, {
			direction: "inbound",
			name: "Ghost",
		});
		const token = oneTimeToken(handoff.url);
		const sessionToken = mcp.openHandoff(token).session_token;
		const connected = await mcp.completeHandoff(sessionToken, { name: "Ghost" });
		const relationship = store.getMcpRelationshipByRoute(
			ROUTE.source,
			ROUTE.providerThreadId,
			"relationship-operator-v1",
		);
		assert.deepEqual(mcp.operatorRuntimeScope(relationship), {
			relationshipId: relationship.id,
			generation: 1,
			source: "phone",
			recipientHint: "ending 0123",
			replyTarget: "phone-0123456789abcdef0123",
		});
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
		assert.deepEqual(tools.map((tool) => tool.name), ["message_tinyfat"]);
		assert.deepEqual(tools[0].inputSchema.required, ["message", "idempotency_key"]);
		assert.equal(JSON.stringify(tools[0]).includes("recipient"), true);
		assert.equal(JSON.stringify(tools[0].inputSchema.properties).includes("recipient"), false);

		const call = (message) => mcp.proxyInbound({
			resourceId,
			authorization,
			requestHeaders,
			body: Buffer.from(JSON.stringify({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: {
					name: "message_tinyfat",
					arguments: {
						message,
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
		const notification = store.getControlNotification(`mcp-operator:${event.providerMessageId}`);
		assert.equal(notification.eventId, event.id);
		assert.equal(notification.contextId, CONTEXT_ID);
		assert.equal(notification.sequence, event.awarenessSequence);
		assert.equal(notification.status, "queued");
		assert.equal(store.claimNextEvent(), null, "the Operator cannot wake before the Zulip projection");
		const sending = store.claimControlNotification();
		assert.equal(sending.id, notification.id);
		store.completeControlNotification(sending.id, "zulip-message-42");
		assert.equal(store.claimNextEvent().id, event.id);
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
					name: "message_tinyfat",
					arguments: {
						message: "Try another recipient.",
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

test("queued relationship messages and projection gates survive a Hostd store restart", async () => {
	const { directory, store, mcp } = await fixture();
	let reopened;
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, { direction: "inbound", name: "Ghost" });
		const token = oneTimeToken(handoff.url);
		const sessionToken = mcp.openHandoff(token).session_token;
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
					name: "message_tinyfat",
					arguments: {
						message: "Durable restart check.",
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
		assert.equal(reopened.claimNextEvent(), null);
		const notification = reopened.claimControlNotification();
		assert.equal(notification.eventId, receiptId);
		reopened.completeControlNotification(notification.id, "zulip-message-restart");
		const claimed = reopened.claimNextEvent();
		assert.equal(claimed.id, receiptId);
		assert.equal(claimed.contextId, CONTEXT_ID);
	} finally {
		reopened?.close();
		try { store.close(); } catch {}
		await rm(directory, { recursive: true, force: true });
	}
});

test("an ambiguous MCP projection is terminal across restart and is never replayed", async () => {
	const { directory, store, mcp } = await fixture();
	let reopened;
	try {
		const handoff = mcp.createHandoff(TARGET, CONTEXT_ID, { direction: "inbound", name: "Vellum" });
		const sessionToken = mcp.openHandoff(oneTimeToken(handoff.url)).session_token;
		const connected = await mcp.completeHandoff(sessionToken, { name: "Vellum" });
		const resourceId = new URL(connected.server_url).pathname.split("/").at(-1);
		const result = await mcp.proxyInbound({
			resourceId,
			authorization: `Bearer ${connected.api_key}`,
			requestHeaders: { "content-type": "application/json" },
			body: Buffer.from(JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "message_tinyfat",
					arguments: {
						message: "Do not replay this projection after an ambiguous restart.",
						idempotency_key: "projection-restart-0001",
					},
				},
			})),
		});
		const eventId = (await result.json()).result.structuredContent.receipt_id;
		const sending = store.claimControlNotification();
		assert.equal(sending.eventId, eventId);
		assert.equal(sending.status, "sending");
		store.close();
		reopened = new HostStore(join(directory, "state.sqlite"));
		assert.equal(reopened.getControlNotification(sending.id).status, "dead");
		assert.equal(reopened.getEvent(eventId).status, "dead");
		assert.equal(reopened.getEvent(eventId).lastError, "mcp_context_projection_ambiguous");
		assert.equal(reopened.claimControlNotification(), null);
		assert.equal(reopened.claimNextEvent(), null);
	} finally {
		reopened?.close();
		try { store.close(); } catch {}
		await rm(directory, { recursive: true, force: true });
	}
});

test("MCP projection completion wakes scheduling and a projection failure is not retried", async () => {
	const { directory, store } = await fixture();
	try {
		const event = (id) => ({
			id,
			source: "mcp-operator",
			providerMessageId: id,
			providerThreadId: "example-relationship",
			principalHash: "example-principal",
			targetId: TARGET.id,
			contextId: CONTEXT_ID,
			payload: { message: id, sender: "Vellum" },
		});
		store.upsertEventWithControlNotification(event("projection-success"));
		const projected = [];
		const notifier = new ChannelControlNotifier({
			store,
			projection: { async postEmailLedgerNotification() { return "zulip-108"; } },
			tickSeconds: 60,
			onProjected: (notification) => { projected.push(notification.eventId); },
		});
		await notifier.start();
		await notifier.stop();
		assert.deepEqual(projected, ["projection-success"]);
		assert.equal(store.claimNextEvent().id, "projection-success");

		store.upsertEventWithControlNotification(event("projection-failure"));
		let attempts = 0;
		const failing = new ChannelControlNotifier({
			store,
			projection: { async postEmailLedgerNotification() {
				attempts++;
				throw new Error("ambiguous Zulip failure");
			} },
			tickSeconds: 60,
			maximumAttempts: 10,
		});
		await failing.start();
		await failing.stop();
		assert.equal(attempts, 1);
		assert.equal(store.getEvent("projection-failure").status, "dead");
		assert.equal(store.getControlNotification("mcp-operator:projection-failure").status, "dead");
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
		const token = oneTimeToken(handoff.url);
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
