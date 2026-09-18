import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextCapability } from "../src/security.mjs";
import { ScopedAppGateway } from "../src/scoped-app-gateway.mjs";
import { createScopedAppServer } from "../src/scoped-app-server.mjs";
import { ScopedAppStore, scopedAppScopeKeys } from "../src/scoped-app-store.mjs";

const DISPATCH_TOKEN = "example-dispatch-capability-at-least-32-bytes";
const REVOKE_TOKEN = "example-revoke-capability-at-least-32-bytes";
const RENEWAL_TOKEN = "example-renewal-capability-at-least-32-bytes";
const ROUTING_KEY = Buffer.alloc(32, 17);
const TARGET = {
	id: "example-agent",
	driver: "oci",
	inboundToken: "example-runtime-inbound-capability",
	computer: { enabled: true },
};

function scope(overrides = {}) {
	const now = Date.now();
	return {
		leaseId: "6f77f5fa-9375-4341-801c-f17e7814fa70",
		accountId: "synthetic-org-a",
		userId: "synthetic-user-a",
		membershipId: "synthetic-member-a",
		membershipVersion: 1,
		role: "member",
		authorizedAt: new Date(now - 100).toISOString(),
		expiresAt: new Date(now + 29_900).toISOString(),
		...overrides,
	};
}

function envelope(operation, payload, overrides = {}) {
	return {
		version: "vectors.v1",
		requestId: crypto.randomUUID(),
		scope: scope(),
		operation,
		payload,
		...overrides,
	};
}

function renewalResponse(input) {
	const now = Date.now();
	return new Response(JSON.stringify({
		version: "vectors.v1",
		scope: {
			...input.scope,
			authorizedAt: new Date(now).toISOString(),
			expiresAt: new Date(now + 30_000).toISOString(),
		},
	}), { status: 200, headers: { "content-type": "application/json" } });
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

async function waitFor(callback, label, timeout = 2_000) {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		const result = callback();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

async function fixture({ gateRuntime = false, withEvidence = false } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "scoped-app-server-"));
	const config = {
		host: "127.0.0.1",
		port: 3130,
		targetId: TARGET.id,
		databasePath: join(directory, "state.sqlite"),
		organizationsDirectory: join(directory, "organizations"),
		dispatchPath: "/v1/example/dispatch",
		dispatchToken: DISPATCH_TOKEN,
		revokeToken: REVOKE_TOKEN,
		renewalUrl: "https://app.example.com/api/internal/hostd/lease/renew",
		renewalToken: RENEWAL_TOKEN,
		maximumRequestBytes: 128 * 1024,
		maximumEventsPerContext: 2_000,
		maximumActiveTurnsPerContext: 1,
	};
	const store = new ScopedAppStore(config.databasePath, config);
	let releaseRuntime;
	const runtimeCalls = [];
	const stopCalls = [];
	const runtime = {
		async ensureScopedOciContext(target, contextId, organization) {
			runtimeCalls.push({ target, contextId, organization });
			assert.equal((await readFile(organization.path, "utf8")), store.readContext(organization.organizationKey).markdown);
			return { port: 45678 };
		},
		async stopScopedOciContext(target, contextId) {
			stopCalls.push({ target, contextId });
		},
	};
	const fetchImpl = async (url, options) => {
		if (String(url) === config.renewalUrl) {
			assert.equal(options.headers.authorization, `Bearer ${RENEWAL_TOKEN}`);
			return renewalResponse(JSON.parse(options.body));
		}
		assert.match(String(url), /^http:\/\/127\.0\.0\.1:45678\/api\/v2\/agents\/current\/messages$/);
		if (gateRuntime) {
			return await new Promise((resolve) => {
				releaseRuntime = () => resolve(new Response(
					'data: {"type":"text_delta","delta":"Synthetic answer"}\n\n'
					+ 'data: {"type":"run_complete"}\n\n',
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				));
			});
		}
		return new Response(
			'data: {"type":"text_delta","delta":"Synthetic answer"}\n\n'
			+ 'data: {"type":"run_complete"}\n\n',
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	};
	const evidenceBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGzUAAAAASUVORK5CYII=", "base64");
	const evidence = withEvidence ? {
		available: true,
		async verifySource(payload) {
			assert.equal(payload.sourceUrl, "https://example.com/grants/synthetic");
			return {
				sourceUrl: payload.sourceUrl,
				sourceSha256: "d52b7fdfb1c9888861f8c5716a3a66ba62dce117e60a1ac6dc719430c1aed3de",
			};
		},
		async capture(_contextId, input) {
			return {
				receipt: {
					...input,
					capturedAt: new Date().toISOString(),
					screenshotSha256: "4ffae94283206cbc5cadc53121e9581f83e889cb5153bbdd4255b14ba27a55f9",
					viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
					highlight: { method: "selection", rects: [{ x: 0, y: 0, width: 1, height: 1 }] },
					toolVersion: "SYNTHETIC-TEST-BACKEND",
					reviewState: "unreviewed",
					synthetic: false,
				},
				artifact: {
					mediaType: "image/png",
					bytes: evidenceBytes,
					sha256: "4ffae94283206cbc5cadc53121e9581f83e889cb5153bbdd4255b14ba27a55f9",
				},
			};
		},
	} : undefined;
	const gateway = new ScopedAppGateway({
		config,
		store,
		runtime,
		routingKey: ROUTING_KEY,
		target: TARGET,
		evidence,
		fetchImpl,
	});
	const server = createScopedAppServer({ config: { scopedApp: config }, gateway, target: TARGET });
	const port = await listen(server);
	return {
		directory,
		config,
		store,
		gateway,
		server,
		base: `http://127.0.0.1:${port}`,
		runtimeCalls,
		stopCalls,
		releaseRuntime: () => releaseRuntime?.(),
		close: async () => {
			await close(server);
			store.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

async function dispatch(subject, body, token = DISPATCH_TOKEN, headers = {}) {
	return await fetch(`${subject.base}${subject.config.dispatchPath}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

test("dispatch stays server-only and separates ordinary from revoke capability", async () => {
	const subject = await fixture();
	try {
		const request = envelope("capabilities", {});
		const unauthenticated = await fetch(`${subject.base}${subject.config.dispatchPath}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		assert.equal(unauthenticated.status, 401);
		const browser = await dispatch(subject, request, DISPATCH_TOKEN, { origin: "https://app.example.com" });
		assert.equal(browser.status, 403);
		const wrongCapability = await dispatch(subject, request, REVOKE_TOKEN);
		assert.equal(wrongCapability.status, 403);

		const accepted = await dispatch(subject, request);
		assert.equal(accepted.status, 200);
		assert.deepEqual(await accepted.json(), {
			runtime: "hostd",
			protocol: "vectors.v1",
			durableChat: true,
			contextCas: true,
			revocation: true,
			cua: false,
		});
	} finally {
		await subject.close();
	}
});

test("evidence is captured with fresh scope and remains private to one user", async () => {
	const subject = await fixture({ withEvidence: true });
	try {
		const capabilities = await dispatch(subject, envelope("capabilities", {}));
		assert.equal((await capabilities.json()).cua, true);
		const turnId = "af7c145d-c066-472b-ab05-2c63f3ebec1e";
		const send = await dispatch(subject, envelope("chat.send", { turnId, text: "Synthetic evidence question" }));
		assert.equal(send.status, 200);
		const keys = scopedAppScopeKeys(ROUTING_KEY, TARGET.id, scope());
		await waitFor(() => subject.store.getTurn(keys.contextId, turnId)?.status === "completed", "turn completion");

		const evidenceTurnId = "bf7c145d-c066-472b-ab05-2c63f3ebec1e";
		const capture = await dispatch(subject, envelope("evidence.capture", {
			turnId: evidenceTurnId,
			grantId: "synthetic-grant-a",
			sourceUrl: "https://example.com/grants/synthetic",
			field: "title",
			exactQuote: "Synthetic fixture only",
		}));
		assert.equal(capture.status, 200);
		assert.deepEqual(await capture.json(), { status: "queued", turnId: evidenceTurnId });
		const events = subject.store.listEvents(keys.contextId, 0).events;
		const evidenceEvent = events.find((event) => event.type === "evidence");
		assert.match(evidenceEvent.data.artifactId, /^[a-f0-9]{40}$/);
		assert.equal(subject.store.getTurn(keys.contextId, evidenceTurnId).status, "completed");
		assert.equal(subject.store.getTurn(keys.contextId, evidenceTurnId).inputText, "");

		const receiptResponse = await dispatch(subject, envelope("evidence.read", {
			artifactId: evidenceEvent.data.artifactId,
		}));
		assert.equal(receiptResponse.status, 200);
		const receipt = await receiptResponse.json();
		assert.equal(receipt.accountId, "synthetic-org-a");
		assert.equal(receipt.userId, "synthetic-user-a");
		assert.equal(receipt.synthetic, false);

		const artifactResponse = await dispatch(subject, envelope("artifact.read", {
			artifactId: evidenceEvent.data.artifactId,
		}));
		assert.equal(artifactResponse.status, 200);
		assert.equal((await artifactResponse.json()).sha256, receipt.screenshotSha256);

		const otherUser = await dispatch(subject, envelope("evidence.read", {
			artifactId: evidenceEvent.data.artifactId,
		}, { scope: scope({ userId: "synthetic-user-b" }) }));
		assert.equal(otherUser.status, 400);
		assert.equal(subject.runtimeCalls.length, 1);
		assert.equal(subject.stopCalls.length, 1);
	} finally {
		await subject.close();
	}
});

test("context reads and reviewed writes enforce durable compare-and-swap", async () => {
	const subject = await fixture();
	try {
		const initial = await dispatch(subject, envelope("context.read", {}));
		assert.equal(initial.status, 200);
		assert.equal((await initial.json()).revision, 0);

		const write = envelope("context.write", {
			markdown: "# Synthetic organization\n",
			expectedRevision: 0,
			reviewed: true,
		});
		const written = await dispatch(subject, write);
		assert.equal(written.status, 200);
		assert.equal((await written.json()).revision, 1);

		const stale = await dispatch(subject, envelope("context.write", {
			markdown: "stale",
			expectedRevision: 0,
			reviewed: true,
		}));
		assert.equal(stale.status, 409);
		assert.deepEqual(await stale.json(), { error: { code: "conflict", message: "Conflict" } });
	} finally {
		await subject.close();
	}
});

test("chat is queued, renewed at runtime boundaries, persisted, and unmounted", async () => {
	const subject = await fixture({ gateRuntime: true });
	try {
		const turnId = "af7c145d-c066-472b-ab05-2c63f3ebec1e";
		const send = await dispatch(subject, envelope("chat.send", { turnId, text: "Synthetic question" }));
		assert.equal(send.status, 200);
		assert.equal((await send.json()).status, "queued");
		const keys = scopedAppScopeKeys(ROUTING_KEY, TARGET.id, scope());
		await waitFor(() => subject.runtimeCalls.length === 1, "runtime start");

		const authorizationToken = contextCapability(
			TARGET.inboundToken,
			"scoped-app-runtime-authorization",
			keys.contextId,
		);
		const authorized = await fetch(
			`${subject.base}/v1/scoped-app/runtime/${encodeURIComponent(keys.contextId)}/authorize`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${authorizationToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ version: "1", boundary: "tool" }),
			},
		);
		assert.equal(authorized.status, 200);
		assert.equal((await authorized.json()).ok, true);

		subject.releaseRuntime();
		await waitFor(() => subject.store.getTurn(keys.contextId, turnId)?.status === "completed", "turn completion");
		const eventsResponse = await dispatch(subject, envelope("chat.events", { after: 0 }));
		assert.equal(eventsResponse.status, 200);
		const events = await eventsResponse.json();
		assert(events.events.some((event) => event.type === "message" && event.data?.role === "assistant" && event.text === "Synthetic answer"));
		assert.equal(subject.stopCalls.length, 1);
		assert.equal(subject.store.getTurn(keys.contextId, turnId).scopeJson, null);
	} finally {
		await subject.close();
	}
});

test("same-organization admin revocation cancels and tombstones an active member", async () => {
	const subject = await fixture({ gateRuntime: true });
	try {
		const memberScope = scope();
		const turnId = "af7c145d-c066-472b-ab05-2c63f3ebec1e";
		await dispatch(subject, envelope("chat.send", { turnId, text: "Long synthetic task" }, { scope: memberScope }));
		const memberKeys = scopedAppScopeKeys(ROUTING_KEY, TARGET.id, memberScope);
		await waitFor(() => subject.runtimeCalls.length === 1, "active member runtime");

		const adminScope = scope({
			leaseId: "a90313c5-a6ec-42a9-a273-8e0a7711ad42",
			userId: "synthetic-admin-a",
			membershipId: "synthetic-admin-member-a",
			role: "admin",
		});
		const revoke = envelope("scope.revoke", {
			membershipId: memberScope.membershipId,
			membershipVersion: memberScope.membershipVersion,
		}, { scope: adminScope });
		const revoked = await dispatch(subject, revoke, REVOKE_TOKEN);
		assert.equal(revoked.status, 200);
		assert.deepEqual(await revoked.json(), { revoked: true });
		await waitFor(() => subject.store.getTurn(memberKeys.contextId, turnId)?.status === "cancelled", "turn cancellation");
		assert(subject.store.listEvents(memberKeys.contextId, 0).events.some((event) => event.type === "revocation"));
		assert.throws(() => subject.store.acceptMembership(
			memberKeys.accountKey,
			memberKeys.membershipKey,
			memberScope.membershipVersion,
		));
	} finally {
		await subject.close();
	}
});
