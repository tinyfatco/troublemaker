import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GmailHistoryWatcher, HostdGmailHistoryClient } from "../src/gmail-history-watcher.mjs";
import { RuntimeManager } from "../src/runtime.mjs";
import { contextCapability } from "../src/security.mjs";
import { createHostServer } from "../src/server.mjs";

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return server.address().port;
}

async function close(server) {
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("synthetic provider visibility reaches remote runtime acceptance within five seconds", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-e2e-"));
	const statePath = join(directory, "state.json");
	writeFileSync(statePath, JSON.stringify({
		cursor: "100",
		seenMessageIds: [],
		quarantinedMessages: [],
		status: "active",
		initializedAt: "2026-01-01T00:00:00Z",
	}), { mode: 0o600 });
	let runtimeAccepted;
	const accepted = new Promise((resolve) => { runtimeAccepted = resolve; });
	const applicationToken = "resident-application-token-at-least-32-bytes";
	const contextId = "example-resident";
	const resident = createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/email/identity") {
			assert.equal(request.headers.authorization, `Bearer ${applicationToken}`);
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
				headscaleNodeId: 42,
				runtimeIdentity: "example-resident",
			}));
			return;
		}
		if (request.method === "GET" && request.url === "/health") {
			response.writeHead(200).end("ok");
			return;
		}
		if (request.method === "POST" && request.url === "/email/inbound") {
			assert.equal(
				request.headers.authorization,
				`Bearer ${contextCapability(applicationToken, "inbound", contextId)}`,
			);
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({
				accepted: true,
				deliveryId: body.deliveryId,
				headscaleNodeId: 42,
				runtimeIdentity: "example-resident",
			}));
			runtimeAccepted(body);
			return;
		}
		response.writeHead(404).end();
	});
	const residentPort = await listen(resident);
	const controlStatus = JSON.stringify([{
		id: 42,
		name: "example-resident",
		ip_addresses: ["100.64.0.42"],
	}]);
	const tailnetStatus = JSON.stringify({
		Peer: { one: { ID: "opaque-stable-node-id", HostName: "example-resident", TailscaleIPs: ["100.64.0.42"], Online: true } },
	});
	const target = {
		id: "example-resident",
		driver: "resident",
		protocol: "gmail-history",
		contextId,
		mailbox: "resident@example.com",
		endpoint: `http://127.0.0.1:${residentPort}/email/inbound`,
		identityEndpoint: `http://127.0.0.1:${residentPort}/email/identity`,
		healthEndpoint: `http://127.0.0.1:${residentPort}/health`,
		statusEndpoint: `http://127.0.0.1:${residentPort}/status`,
		receiptBaseUrl: "http://127.0.0.1:19090",
		headscaleNodeId: 42,
		tailnetAddress: "100.64.0.42",
		tailnetHostname: "example-resident",
		headscaleControlCommand: [process.execPath, "-e", `console.log(${JSON.stringify(controlStatus)})`],
		tailnetStatusCommand: [process.execPath, "-e", `console.log(${JSON.stringify(tailnetStatus)})`],
		runtimeIdentity: "example-resident",
		inboundToken: applicationToken,
		outboundToken: applicationToken,
	};
	const runtime = new RuntimeManager({ targetsById: new Map([[target.id, target]]) }, {
		hasRunningEvent: () => false,
	});
	const events = new Map();
	let scheduler;
	const store = {
		getEventByProviderMessage: (source, id) => events.get(`${source}:${id}`),
		upsertEvent: (event) => {
			const stored = {
				...event,
				payloadJson: JSON.stringify(event.payload),
				deliveryMode: "turn",
				leaseToken: "synthetic-lease",
			};
			events.set(`${event.source}:${event.providerMessageId}`, stored);
			return stored;
		},
		markSeen: () => {},
	};
	scheduler = {
		pump: () => {
			const event = events.get("gmail-history:message-1");
			if (event) void runtime.acceptEvent(event);
		},
	};
	const hostd = createHostServer({
		config: { server: {}, targetsById: new Map([[target.id, target]]) },
		store,
		scheduler,
		daemon: {},
	});
	const hostdPort = await listen(hostd);
	let providerMutations = 0;
	let providerVisible = false;
	let firstPollDone;
	const firstPoll = new Promise((resolve) => { firstPollDone = resolve; });
	const gmail = {
		async listHistory(cursor) {
			assert.equal(cursor, "100");
			if (!providerVisible) {
				firstPollDone();
				return { messages: [], nextPageToken: null, historyId: "100" };
			}
			return {
				messages: [{ id: "message-1", threadId: "thread-1", historyId: "101" }],
				nextPageToken: null,
				historyId: "101",
			};
		},
		async getMetadata() {
			return { from: "Person <person@example.com>", to: "resident@example.com", subject: "Synthetic" };
		},
		async getThread() {
			return [{ id: "message-1", from: "Person <person@example.com>", to: "resident@example.com", cc: "", subject: "Synthetic", body: "Generate locally." }];
		},
		async markRead() { providerMutations += 1; },
	};
	let watcher;
	try {
		watcher = await new GmailHistoryWatcher({
			account: "resident@example.com",
			contextId,
			statePath,
			gmail,
			hostd: new HostdGmailHistoryClient({
				endpoint: `http://127.0.0.1:${hostdPort}/v1/inbound/gmail-history`,
				token: contextCapability(applicationToken, "gmail-history-ingress", contextId),
			}),
			random: () => 0.5,
		}).initialize();
		watcher.start({ onError: (error) => { throw error; } });
		await firstPoll;
		providerVisible = true;
		const visibleAt = performance.now();
		let timeout;
		const delivered = await Promise.race([
			accepted.finally(() => clearTimeout(timeout)),
			new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new Error("runtime acceptance timed out")), 5_000);
			}),
		]);
		const elapsed = performance.now() - visibleAt;
		assert.ok(elapsed < 5_000, `synthetic acceptance took ${elapsed}ms`);
		assert.equal(delivered.providerMessageId, "message-1");
		assert.equal(providerMutations, 0);
		assert.equal(JSON.parse(readFileSync(statePath, "utf8")).cursor, "101");
	} finally {
		await watcher?.stop();
		await close(hostd);
		await close(resident);
		rmSync(directory, { recursive: true, force: true });
	}
});
