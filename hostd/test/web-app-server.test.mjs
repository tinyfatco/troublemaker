import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { contextCapability, stablePrivateKey } from "../src/security.mjs";
import { createWebAppAssertionHeaders } from "../src/web-app-auth.mjs";
import { createWebAppServer } from "../src/web-app-server.mjs";

const SECRET = "example-web-app-secret-at-least-32-bytes";
const ROUTING_KEY = Buffer.alloc(32, 7);
const SUBJECT = "00000000-0000-4000-8000-000000000001";
const EMAIL = "casey@example.com";
const CONTEXT_ID = "operator:example-principal:website";
const AGENT = {
	id: "scout",
	name: "Scout",
	slug: "scout",
	email: "scout@example.com",
	targetId: "operator",
};
const TARGET = {
	id: "operator",
	driver: "oci",
	inboundToken: "example-context-inbound-token",
	computer: { enabled: false, display: ":1", websocketPort: 6901 },
};
const SITE = {
	grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	customerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	siteId: "11111111-1111-4111-8111-111111111111",
	siteSlug: "example-business",
	artifactKinds: ["static"],
	allowedBranches: ["main"],
	previewHostname: "example-business.example.com",
};

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

function state(runtimePort, accountBindings = [{
	accountEmail: EMAIL,
	subject: SUBJECT,
	principalEmail: EMAIL,
	role: "owner",
	agent: AGENT,
}], { target = TARGET, onExternalActivityProbe } = {}) {
	const project = {
		slug: "website",
		name: "Example website",
		siteDeployments: [SITE],
	};
	return {
		config: {
			webApp: {
				host: "127.0.0.1",
				port: 3120,
				assertionSecret: SECRET,
				issuer: "example-product",
				audience: "example-hostd-web",
				assertionTtlSeconds: 60,
				maximumRequestBytes: 128 * 1024,
				defaultProject: "website",
				accountBindings,
			},
			sites: { previewApex: "example.com" },
			routing: {
				actorTarget: "operator",
				knownPrincipals: [{ email: EMAIL, name: "Casey", targetId: TARGET.id, projects: [project] }],
				knownPhonePrincipals: [],
			},
			targetsById: new Map([[target.id, target]]),
		},
		routingKey: ROUTING_KEY,
		router: {
			resolve(input) {
				assert.equal(input.source, "web-app");
				assert.equal(input.sender, EMAIL);
				assert.equal(input.project.slug, "website");
				assert.equal(input.targetId, TARGET.id);
				return {
					targetId: target.id,
					contextId: CONTEXT_ID,
					principalHash: "example-principal",
					projectSlug: "website",
				};
			},
		},
		store: {
			getContext() {
				return { status: "online" };
			},
			getContextScope() {
				return {
					principalHash: "example-principal",
					emailAddress: EMAIL,
					projectSlug: "website",
				};
			},
			getSiteRelationshipFactory() {
				return undefined;
			},
			listSiteDeploymentBindings() {
				return [];
			},
		},
		runtime: {
			setExternalActivityProbe(probe) {
				onExternalActivityProbe?.(probe);
			},
			async ensureOciContext(selectedTarget, contextId) {
				assert.equal(selectedTarget, target);
				assert.equal(contextId, CONTEXT_ID);
				return { port: runtimePort };
			},
		},
	};
}

function signedHeaders(method, path, body = Buffer.alloc(0), email = EMAIL, agent = AGENT.id) {
	return createWebAppAssertionHeaders({
		secret: SECRET,
		issuer: "example-product",
		audience: "example-hostd-web",
		method,
		path,
		body,
		subject: SUBJECT,
		email,
		agent,
	});
}

test("maps an authenticated product user to one redacted Hostd workspace", async () => {
	const runtimeServer = createServer((request, response) => {
		assert.equal(request.url, "/api/v2/agents/current/messages");
		assert.equal(
			request.headers.authorization,
			`Bearer ${contextCapability(TARGET.inboundToken, "web-app", CONTEXT_ID)}`,
		);
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
				message: "Howdy",
				channelId: "web-app:website",
				source: "web",
				sourceEventType: "tinyfat_app",
			});
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end('data: {"type":"text_delta","delta":"Hello"}\n\ndata: [DONE]\n\n');
		});
	});
	const runtimePort = await listen(runtimeServer);
	const appServer = createWebAppServer(state(runtimePort));
	const appPort = await listen(appServer);
	try {
		const sessionPath = "/v1/app/session?project=website";
		const sessionResponse = await fetch(`http://127.0.0.1:${appPort}${sessionPath}`, {
			headers: signedHeaders("GET", sessionPath),
		});
		assert.equal(sessionResponse.status, 200);
		const session = await sessionResponse.json();
		assert.deepEqual(session.agent, {
			id: "scout",
			name: "Scout",
			slug: "scout",
			email: "scout@example.com",
			state: "online",
		});
		assert.equal(session.user.role, "owner");
		assert.equal(session.project.slug, "website");
		assert.deepEqual(session.sites, [{
			slug: "example-business",
			previewUrl: "https://example-business.example.com",
		}]);
		assert.doesNotMatch(JSON.stringify(session), /contextId|targetId|grantId|siteId/);

		const messagePath = "/v1/app/messages?project=website";
		const body = Buffer.from(JSON.stringify({ message: "  Howdy  ", channelId: "forged" }));
		const messageResponse = await fetch(`http://127.0.0.1:${appPort}${messagePath}`, {
			method: "POST",
			headers: {
				...signedHeaders("POST", messagePath, body),
				"content-type": "application/json",
			},
			body,
		});
		assert.equal(messageResponse.status, 200);
		assert.match(await messageResponse.text(), /text_delta/);
	} finally {
		await close(appServer);
		await close(runtimeServer);
	}
});

test("fails closed for an unconfigured email and a tampered request", async () => {
	const appServer = createWebAppServer(state(65534));
	const appPort = await listen(appServer);
	try {
		const path = "/v1/app/session";
		const unknown = await fetch(`http://127.0.0.1:${appPort}${path}`, {
			headers: signedHeaders("GET", path, Buffer.alloc(0), "unknown@example.com"),
		});
		assert.equal(unknown.status, 403);

		const headers = signedHeaders("GET", path);
		headers["x-tinyfat-app-email"] = "unknown@example.com";
		const tampered = await fetch(`http://127.0.0.1:${appPort}${path}`, { headers });
		assert.equal(tampered.status, 401);
	} finally {
		await close(appServer);
	}
});

test("maps an exact authenticated account binding to its existing canonical relationship", async () => {
	const alias = "signed-in@example.com";
	const appServer = createWebAppServer(state(65534, [{
		accountEmail: alias,
		subject: SUBJECT,
		principalEmail: EMAIL,
		role: "owner",
		agent: AGENT,
	}]));
	const appPort = await listen(appServer);
	try {
		const path = "/v1/app/session?project=website";
		const response = await fetch(`http://127.0.0.1:${appPort}${path}`, {
			headers: signedHeaders("GET", path, Buffer.alloc(0), alias),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).user.email, alias);
	} finally {
		await close(appServer);
	}
});

test("projects the web app onto one existing phone-scoped Operator context", async () => {
	const phone = "+15555550123";
	const principalHash = stablePrivateKey(ROUTING_KEY, "phone-principal", phone);
	const phoneContextId = "operator:111111111111111111111111:relationship-operator";
	const subject = state(65534, [{
		accountEmail: EMAIL,
		subject: SUBJECT,
		principalPhone: phone,
		role: "owner",
		agent: AGENT,
	}]);
	subject.config.routing.knownPhonePrincipals = [{
		phone,
		name: "Casey",
		targetId: TARGET.id,
		projects: [],
	}];
	subject.store.listRoutesForPrincipal = (source, selectedPrincipalHash, targetId) => {
		assert.equal(source, "phone");
		assert.equal(selectedPrincipalHash, principalHash);
		assert.equal(targetId, TARGET.id);
		return [{
			source: "phone",
			providerThreadId: "shared-phone-thread",
			principalHash,
			projectSlug: "intake",
			targetId: TARGET.id,
			contextId: phoneContextId,
		}];
	};
	subject.store.getContext = (contextId) => {
		assert.equal(contextId, phoneContextId);
		return { status: "online" };
	};
	subject.store.getContextScope = (contextId, targetId) => ({
		contextId,
		targetId,
		principalHash,
		emailAddress: null,
		displayLabel: "Phone •••• 0123",
		projectSlug: "intake",
	});
	const appServer = createWebAppServer(subject);
	const appPort = await listen(appServer);
	try {
		const path = "/v1/app/session?project=intake";
		const response = await fetch(`http://127.0.0.1:${appPort}${path}`, {
			headers: signedHeaders("GET", path),
		});
		assert.equal(response.status, 200);
		const session = await response.json();
		assert.equal(session.principal.channel, "phone");
		assert.equal(session.principal.email, null);
		assert.equal(session.principal.displayName, "Casey");
		assert.deepEqual(session.project, { slug: "intake", name: "Private relationship" });
		assert.deepEqual(session.projects, [{ slug: "intake", name: "Private relationship" }]);
		assert.equal(session.agent.name, "Scout");
	} finally {
		await close(appServer);
	}
});

test("starts the shared computer and gives human control only through an expiring owner lease", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-web-computer-"));
	const target = {
		...TARGET,
		contextsDirectory: join(directory, "contexts"),
		computer: { enabled: true, display: ":1", websocketPort: 6901 },
	};
	let stopped = 0;
	const runtimeServer = createServer((request, response) => {
		assert.equal(request.url, "/api/v2/agents/current/messages/stop");
		assert.equal(request.method, "POST");
		stopped++;
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"ok":true}');
	});
	const runtimePort = await listen(runtimeServer);
	const appServer = createWebAppServer(state(runtimePort, undefined, { target }));
	const appPort = await listen(appServer);
	try {
		const statusPath = "/v1/app/desktop/status?project=website";
		const statusResponse = await fetch(`http://127.0.0.1:${appPort}${statusPath}`, {
			headers: signedHeaders("GET", statusPath),
		});
		assert.equal(statusResponse.status, 200);
		assert.deepEqual(await statusResponse.json(), {
			state: "ready",
			control: "agent",
			expiresAt: null,
			canTakeOver: true,
		});

		const controlPath = "/v1/app/desktop/control?project=website";
		const humanBody = Buffer.from('{"mode":"human"}');
		const humanResponse = await fetch(`http://127.0.0.1:${appPort}${controlPath}`, {
			method: "POST",
			headers: {
				...signedHeaders("POST", controlPath, humanBody),
				"content-type": "application/json",
			},
			body: humanBody,
		});
		assert.equal(humanResponse.status, 200);
		const human = await humanResponse.json();
		assert.equal(human.control, "human");
		assert.ok(Date.parse(human.expiresAt) > Date.now());
		assert.equal(stopped, 1, "takeover stops an in-flight web turn before enabling input");

		const agentBody = Buffer.from('{"mode":"agent"}');
		const agentResponse = await fetch(`http://127.0.0.1:${appPort}${controlPath}`, {
			method: "POST",
			headers: {
				...signedHeaders("POST", controlPath, agentBody),
				"content-type": "application/json",
			},
			body: agentBody,
		});
		assert.equal(agentResponse.status, 200);
		assert.deepEqual(await agentResponse.json(), { control: "agent", expiresAt: null });

		const viewerBinding = [{
			accountEmail: EMAIL,
			subject: SUBJECT,
			principalEmail: EMAIL,
			role: "viewer",
			agent: AGENT,
		}];
		const viewerServer = createWebAppServer(state(runtimePort, viewerBinding, { target }));
		const viewerPort = await listen(viewerServer);
		try {
			const viewerStatusResponse = await fetch(`http://127.0.0.1:${viewerPort}${statusPath}`, {
				headers: signedHeaders("GET", statusPath),
			});
			assert.equal(viewerStatusResponse.status, 200);
			assert.equal((await viewerStatusResponse.json()).canTakeOver, false);
			const viewerBody = Buffer.from('{"mode":"human"}');
			const denied = await fetch(`http://127.0.0.1:${viewerPort}${controlPath}`, {
				method: "POST",
				headers: {
					...signedHeaders("POST", controlPath, viewerBody),
					"content-type": "application/json",
				},
				body: viewerBody,
			});
			assert.equal(denied.status, 403);
			assert.deepEqual(await denied.json(), { error: "takeover_not_allowed" });
		} finally {
			await close(viewerServer);
		}
	} finally {
		await close(appServer);
		await close(runtimeServer);
		await rm(directory, { recursive: true, force: true });
	}
});

test("proxies only an authenticated account's desktop WebSocket and counts it as runtime activity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hostd-web-computer-socket-"));
	const target = {
		...TARGET,
		contextsDirectory: join(directory, "contexts"),
		computer: { enabled: true, display: ":1", websocketPort: 6901 },
	};
	const runtimeServer = createServer();
	const runtimeSockets = new WebSocketServer({ noServer: true });
	runtimeServer.on("upgrade", (request, socket, head) => {
		assert.equal(request.url, "/desktop/socket");
		assert.equal(
			request.headers.authorization,
			`Bearer ${contextCapability(target.inboundToken, "web-app", CONTEXT_ID)}`,
		);
		assert.equal(request.headers.cookie, undefined);
		assert.equal(request.headers.origin, undefined);
		assert.equal(request.headers["x-tinyfat-app-agent"], undefined);
		runtimeSockets.handleUpgrade(request, socket, head, (client) => {
			client.on("message", (message) => client.send(message));
		});
	});
	const runtimePort = await listen(runtimeServer);
	let activityProbe;
	const appServer = createWebAppServer(state(runtimePort, undefined, {
		target,
		onExternalActivityProbe(probe) { activityProbe = probe; },
	}));
	const appPort = await listen(appServer);
	const socketPath = "/v1/app/desktop/socket?project=website";
	const client = new WebSocket(`ws://127.0.0.1:${appPort}${socketPath}`, {
		headers: signedHeaders("GET", socketPath),
	});
	try {
		await new Promise((resolve, reject) => {
			client.once("open", resolve);
			client.once("error", reject);
		});
		assert.equal(activityProbe(CONTEXT_ID), true);
		const echoed = new Promise((resolve, reject) => {
			client.once("message", (message) => resolve(message.toString()));
			client.once("error", reject);
		});
		client.send("shared-desktop-ready");
		assert.equal(await echoed, "shared-desktop-ready");
		const closed = new Promise((resolve) => client.once("close", resolve));
		client.close();
		await closed;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(activityProbe(CONTEXT_ID), false);
	} finally {
		client.terminate();
		runtimeSockets.close();
		await close(appServer);
		await close(runtimeServer);
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects oversized or non-JSON mutations before they reach a runtime", async () => {
	const appServer = createWebAppServer(state(65534));
	const appPort = await listen(appServer);
	try {
		const path = "/v1/app/messages?project=website";
		const textBody = Buffer.from("not json");
		const unsupported = await fetch(`http://127.0.0.1:${appPort}${path}`, {
			method: "POST",
			headers: {
				...signedHeaders("POST", path, textBody),
				"content-type": "text/plain",
			},
			body: textBody,
		});
		assert.equal(unsupported.status, 415);
		assert.deepEqual(await unsupported.json(), { error: "json_required" });

		const oversizedBody = Buffer.alloc((128 * 1024) + 1, 0x61);
		const oversized = await fetch(`http://127.0.0.1:${appPort}${path}`, {
			method: "POST",
			headers: {
				...signedHeaders("POST", path, oversizedBody),
				"content-type": "application/json",
			},
			body: oversizedBody,
		});
		assert.equal(oversized.status, 413);
		assert.deepEqual(await oversized.json(), { error: "request_too_large" });
	} finally {
		await close(appServer);
	}
});

test("does not relay active content from a runtime onto the product origin", async () => {
	const runtimeServer = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end("<script>globalThis.compromised = true</script>");
	});
	const runtimePort = await listen(runtimeServer);
	const appServer = createWebAppServer(state(runtimePort));
	const appPort = await listen(appServer);
	try {
		const path = "/v1/app/status?project=website";
		const response = await fetch(`http://127.0.0.1:${appPort}${path}`, {
			headers: signedHeaders("GET", path),
		});
		assert.equal(response.status, 502);
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.deepEqual(await response.json(), { error: "invalid_upstream_response" });
	} finally {
		await close(appServer);
		await close(runtimeServer);
	}
});
