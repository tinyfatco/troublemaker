import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GogCommandError } from "../src/gmail.mjs";
import { GmailHistoryWatcher, HostdGmailHistoryClient, isThrottled } from "../src/gmail-history-watcher.mjs";

function message(id, historyId, threadId = `thread-${id}`) {
	return { id, threadId, historyId };
}

function fakeGmail() {
	const calls = [];
	let history = { messages: [], nextPageToken: null, historyId: "100" };
	return {
		calls,
		setHistory(value) { history = value; },
		async searchMessages(query, maximum) {
			calls.push(["searchMessages", query, maximum]);
			if (query === "in:anywhere") return [{ id: "existing", threadId: "thread-existing" }];
			return [{ id: "existing", threadId: "thread-existing" }];
		},
		async getMessageEnvelope(id) {
			calls.push(["getMessageEnvelope", id]);
			return { id, threadId: `thread-${id}`, historyId: id === "existing" ? "100" : "200" };
		},
		async listHistory(cursor, options) {
			calls.push(["listHistory", cursor, options]);
			if (history instanceof Error) throw history;
			return history;
		},
		async getMetadata(id) {
			calls.push(["getMetadata", id]);
			return { from: "Person <person@example.com>", to: "agent@example.com", subject: `Subject ${id}` };
		},
		async getThread(threadId) {
			calls.push(["getThread", threadId]);
			const id = threadId.replace(/^thread-/, "");
			return [{
				id,
				from: "Person <person@example.com>",
				to: "agent@example.com",
				cc: "",
				subject: `Subject ${id}`,
				body: `Body ${id}`,
			}];
		},
		async markRead() {
			throw new Error("provider mutation must never be called");
		},
	};
}

async function watcher(directory, gmail, hostd) {
	return new GmailHistoryWatcher({
		account: "agent@example.com",
		contextId: "example-resident",
		statePath: join(directory, "state.json"),
		gmail,
		hostd,
		random: () => 0.5,
	}).initialize();
}

test("first start establishes a durable cursor without replaying existing mail", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-init-"));
	const gmail = fakeGmail();
	const accepted = [];
	try {
		const instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event) });
		assert.deepEqual(await instance.pollOnce(), { initialized: true, cursor: "100", delivered: 0 });
		assert.equal(accepted.length, 0);
		const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
		assert.equal(state.cursor, "100");
		assert.deepEqual(state.seenMessageIds, ["existing"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an empty mailbox is durably initialized and its first later message is delivered", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-empty-init-"));
	const gmail = fakeGmail();
	const accepted = [];
	let firstMessageVisible = false;
	gmail.searchMessages = async (query) => {
		if (!firstMessageVisible) return [];
		return [{ id: "first", threadId: "thread-first" }];
	};
	gmail.getMessageEnvelope = async (id) => ({ id, threadId: `thread-${id}`, historyId: "10" });
	try {
		const instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event.providerMessageId) });
		assert.deepEqual(await instance.pollOnce(), { initialized: true, cursor: null, delivered: 0 });
		let state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
		assert.equal(state.emptyMailbox, true);
		assert.deepEqual(state.seenMessageIds, []);

		firstMessageVisible = true;
		assert.deepEqual(await instance.pollOnce(), {
			initialized: false,
			cursor: "10",
			delivered: 1,
			quarantined: 0,
		});
		assert.deepEqual(accepted, ["first"]);
		state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
		assert.equal(state.cursor, "10");
		assert.equal(state.emptyMailbox, false);
		assert.deepEqual(state.seenMessageIds, ["first"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("initialization does not lose mail that appears between cursor and inbox snapshots", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-init-race-"));
	const gmail = fakeGmail();
	const accepted = [];
	gmail.searchMessages = async (query) => query === "in:anywhere"
		? [{ id: "existing", threadId: "thread-existing" }]
		: [{ id: "race", threadId: "thread-race" }, { id: "existing", threadId: "thread-existing" }];
	gmail.getMessageEnvelope = async (id) => ({ id, threadId: `thread-${id}`, historyId: id === "race" ? "101" : "100" });
	try {
		const instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event.providerMessageId) });
		await instance.pollOnce();
		assert.deepEqual(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).seenMessageIds, ["existing"]);
		gmail.setHistory({ messages: [message("race", "101")], nextPageToken: null, historyId: "101" });
		await instance.pollOnce();
		assert.deepEqual(accepted, ["race"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("watcher durably advances only after Hostd acknowledges each provider position", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-ack-"));
	const gmail = fakeGmail();
	const accepted = [];
	try {
		const instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event) });
		await instance.pollOnce();
		gmail.setHistory({
			messages: [message("existing", "100", "thread-existing"), message("new-1", "101")],
			nextPageToken: null,
			historyId: "101",
		});
		assert.deepEqual(await instance.pollOnce(), { initialized: false, cursor: "101", delivered: 1, quarantined: 0 });
		assert.equal(accepted.length, 1);
		assert.equal(accepted[0].providerMessageId, "new-1");
		assert.equal(accepted[0].historyId, "101");
		assert.equal(JSON.parse(readFileSync(join(directory, "state.json"), "utf8")).cursor, "101");
		assert.equal(gmail.calls.some(([method]) => method === "markRead"), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("tunnel or Hostd receipt loss leaves cursor and message dedupe unadvanced", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-loss-"));
	const gmail = fakeGmail();
	try {
		const instance = await watcher(directory, gmail, { accept: async () => { throw new Error("synthetic receipt loss"); } });
		await instance.pollOnce();
		gmail.setHistory({ messages: [message("new-1", "101")], nextPageToken: null, historyId: "101" });
		await assert.rejects(instance.pollOnce(), /synthetic receipt loss/);
		const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
		assert.equal(state.cursor, "100");
		assert.deepEqual(state.seenMessageIds, ["existing"]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("restart, duplicate entries, and out-of-order history converge without duplicate Hostd delivery", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-restart-"));
	const gmail = fakeGmail();
	const accepted = [];
	try {
		let instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event.providerMessageId) });
		await instance.pollOnce();
		gmail.setHistory({
			messages: [message("new-2", "103"), message("new-1", "102"), message("new-2", "103")],
			nextPageToken: null,
			historyId: "103",
		});
		await instance.pollOnce();
		assert.deepEqual(accepted, ["new-1", "new-2"]);
		instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event.providerMessageId) });
		await instance.pollOnce();
		assert.deepEqual(accepted, ["new-1", "new-2"]);
		assert.equal(gmail.calls.at(-1)[1], "103");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("expired Gmail History durably blocks for explicit rebaseline without advancing or scanning an overlap", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-expired-"));
	const gmail = fakeGmail();
	const accepted = [];
	try {
		const instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event.providerMessageId) });
		await instance.pollOnce();
		const callsBeforeExpiry = gmail.calls.length;
		gmail.setHistory(new GogCommandError("gog command exited 1: HTTP 404 startHistoryId invalid", {
			exitCode: 1,
			stderr: "HTTP 404 startHistoryId invalid",
		}));
		await assert.rejects(instance.pollOnce(), /explicit rebaseline is required/);
		const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
		assert.equal(state.cursor, "100");
		assert.equal(state.status, "rebaseline-required");
		assert.equal(typeof state.blockedAt, "string");
		assert.deepEqual(accepted, []);
		assert.deepEqual(gmail.calls.slice(callsBeforeExpiry).map(([method]) => method), ["listHistory"]);
		await assert.rejects(instance.pollOnce(), /explicit rebaseline is required/);
		assert.equal(gmail.calls.length, callsBeforeExpiry + 1, "blocked state performs no provider calls");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("one malformed message is durably quarantined without stalling later mailbox delivery", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-quarantine-"));
	const gmail = fakeGmail();
	const accepted = [];
	gmail.getMetadata = async (id) => id === "malformed"
		? { from: "not-an-address", to: "agent@example.com", subject: "Malformed" }
		: { from: "Person <person@example.com>", to: "agent@example.com", subject: `Subject ${id}` };
	try {
		const instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event.providerMessageId) });
		await instance.pollOnce();
		gmail.setHistory({
			messages: [message("malformed", "101"), message("valid", "102")],
			nextPageToken: null,
			historyId: "102",
		});
		assert.deepEqual(await instance.pollOnce(), {
			initialized: false,
			cursor: "102",
			delivered: 1,
			quarantined: 1,
		});
		assert.deepEqual(accepted, ["valid"]);
		const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
		assert.deepEqual(state.seenMessageIds, ["existing", "malformed", "valid"]);
		assert.deepEqual(state.quarantinedMessages.map(({ providerMessageId, historyId, reason }) => ({
			providerMessageId,
			historyId,
			reason,
		})), [{ providerMessageId: "malformed", historyId: "101", reason: "malformed_message" }]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a permanently deleted History message is quarantined while later valid mail advances", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-deleted-"));
	const gmail = fakeGmail();
	const accepted = [];
	gmail.getMetadata = async (id) => {
		if (id === "deleted") throw new GogCommandError("gog command exited 1: HTTP 404 message not found", {
			exitCode: 1,
			stderr: "HTTP 404 message not found",
		});
		return { from: "Person <person@example.com>", to: "agent@example.com", subject: `Subject ${id}` };
	};
	try {
		const instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event.providerMessageId) });
		await instance.pollOnce();
		gmail.setHistory({
			messages: [message("deleted", "101"), message("valid", "102")],
			nextPageToken: null,
			historyId: "102",
		});
		assert.deepEqual(await instance.pollOnce(), {
			initialized: false,
			cursor: "102",
			delivered: 1,
			quarantined: 1,
		});
		assert.deepEqual(accepted, ["valid"]);
		const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
		assert.deepEqual(state.quarantinedMessages.map(({ providerMessageId, reason }) => ({ providerMessageId, reason })), [
			{ providerMessageId: "deleted", reason: "provider_message_missing" },
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("transport and provider 5xx failures remain retryable and block cursor advancement", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-retryable-fetch-"));
	const gmail = fakeGmail();
	const accepted = [];
	gmail.getMetadata = async (id) => {
		if (id === "unavailable") throw new GogCommandError("gog command exited 1: HTTP 503 unavailable", {
			exitCode: 1,
			stderr: "HTTP 503 unavailable",
		});
		return { from: "Person <person@example.com>", to: "agent@example.com", subject: `Subject ${id}` };
	};
	try {
		const instance = await watcher(directory, gmail, { accept: async (event) => accepted.push(event.providerMessageId) });
		await instance.pollOnce();
		gmail.setHistory({
			messages: [message("unavailable", "101"), message("valid", "102")],
			nextPageToken: null,
			historyId: "102",
		});
		await assert.rejects(instance.pollOnce(), /HTTP 503 unavailable/);
		assert.deepEqual(accepted, []);
		const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
		assert.equal(state.cursor, "100");
		assert.deepEqual(state.seenMessageIds, ["existing"]);
		assert.deepEqual(state.quarantinedMessages, []);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("one in-flight poll and bounded two-second cadence/backoff are enforced", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-cadence-"));
	let release;
	let searchCount = 0;
	const gmail = fakeGmail();
	gmail.searchMessages = async () => {
		searchCount += 1;
		if (searchCount === 1) return new Promise((resolve) => { release = resolve; });
		return [{ id: "existing", threadId: "thread-existing" }];
	};
	try {
		const instance = await watcher(directory, gmail, { accept: async () => {} });
		const first = instance.pollOnce();
		assert.deepEqual(await instance.pollOnce(), { skipped: "in_flight" });
		release([{ id: "existing", threadId: "thread-existing" }]);
		await first;
		assert.equal(instance.nextDelay(true), 2_000);
		instance.failures = 1;
		assert.equal(instance.nextDelay(false), 2_000);
		instance.failures = 8;
		assert.equal(instance.nextDelay(false), 60_000);
		assert.equal(isThrottled(new GogCommandError("HTTP 429 too many requests", {
			exitCode: 1,
			stderr: "resource_exhausted",
		})), true);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("shutdown terminates and awaits the one in-flight provider subprocess", async () => {
	const directory = mkdtempSync(join(tmpdir(), "gmail-history-stop-"));
	const gmail = fakeGmail();
	let release;
	let started;
	const providerStarted = new Promise((resolve) => { started = resolve; });
	let calls = 0;
	gmail.searchMessages = async () => {
		calls += 1;
		if (calls === 1) {
			started();
			return new Promise((resolve) => { release = resolve; });
		}
		return [{ id: "existing", threadId: "thread-existing" }];
	};
	let terminated = 0;
	gmail.terminate = () => {
		terminated += 1;
		release([{ id: "existing", threadId: "thread-existing" }]);
	};
	try {
		const instance = await watcher(directory, gmail, { accept: async () => {} });
		instance.start();
		await providerStarted;
		await instance.stop();
		assert.equal(terminated, 1);
		assert.equal(instance.inFlight, null);
		assert.equal(instance.timer, null);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("Hostd history client is loopback-only, redirect-free, and verifies exact durable receipt fields", async () => {
	const calls = [];
	const client = new HostdGmailHistoryClient({
		endpoint: "http://127.0.0.1:19444/v1/inbound/gmail-history",
		token: "context-capability",
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			const event = JSON.parse(options.body);
			return new Response(JSON.stringify({
				accepted: true,
				eventId: "event-1",
				providerMessageId: event.providerMessageId,
				historyId: event.historyId,
			}), { status: 202 });
		},
	});
	await client.accept({ providerMessageId: "message-1", historyId: "101" });
	assert.equal(calls[0].options.redirect, "error");
	assert.equal(calls[0].options.headers.authorization, "Bearer context-capability");
	for (const endpoint of [
		"https://example.com/v1/inbound/gmail-history",
		"http://localhost:19444/v1/inbound/gmail-history",
	]) {
		assert.throws(() => new HostdGmailHistoryClient({
			endpoint,
			token: "context-capability",
		}), /loopback end/);
	}
});
