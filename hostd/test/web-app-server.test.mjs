import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { contextCapability } from "../src/security.mjs";
import { createWebAppAssertionHeaders } from "../src/web-app-auth.mjs";
import { createWebAppServer } from "../src/web-app-server.mjs";

const SECRET = "example-web-app-secret-at-least-32-bytes";
const ROUTING_KEY = Buffer.alloc(32, 7);
const SUBJECT = "00000000-0000-4000-8000-000000000001";
const EMAIL = "casey@example.com";
const CONTEXT_ID = "operator:example-principal:website";
const TARGET = {
	id: "operator",
	driver: "oci",
	inboundToken: "example-context-inbound-token",
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

function state(runtimePort, principalAliases = []) {
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
				principalAliases,
				agentName: "Operator",
			},
			sites: { previewApex: "example.com" },
			routing: {
				actorTarget: "operator",
				knownPrincipals: [{ email: EMAIL, name: "Casey", projects: [project] }],
			},
			targetsById: new Map([[TARGET.id, TARGET]]),
		},
		routingKey: ROUTING_KEY,
		router: {
			resolve(input) {
				assert.equal(input.source, "web-app");
				assert.equal(input.sender, EMAIL);
				assert.equal(input.project.slug, "website");
				return {
					targetId: TARGET.id,
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
			async ensureOciContext(target, contextId) {
				assert.equal(target, TARGET);
				assert.equal(contextId, CONTEXT_ID);
				return { port: runtimePort };
			},
		},
	};
}

function signedHeaders(method, path, body = Buffer.alloc(0), email = EMAIL) {
	return createWebAppAssertionHeaders({
		secret: SECRET,
		issuer: "example-product",
		audience: "example-hostd-web",
		method,
		path,
		body,
		subject: SUBJECT,
		email,
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
		assert.equal(session.agent.name, "Operator");
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

test("maps an exact authenticated alias to its existing canonical relationship", async () => {
	const alias = "signed-in@example.com";
	const appServer = createWebAppServer(state(65534, [{
		email: alias,
		principalEmail: EMAIL,
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
