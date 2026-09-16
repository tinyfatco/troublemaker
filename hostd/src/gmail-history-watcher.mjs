import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { GogCommandError } from "./gmail.mjs";
import { emailAddresses } from "./security.mjs";

const MAX_SEEN_MESSAGES = 10_000;
const MAX_QUARANTINED_MESSAGES = 1_000;
const ID_PATTERN = /^[A-Za-z0-9._:@+-]{1,512}$/;

export class GmailHistoryRebaselineRequiredError extends Error {
	constructor(message = "Gmail History cursor expired; explicit rebaseline is required") {
		super(message);
		this.name = "GmailHistoryRebaselineRequiredError";
	}
}

class MalformedGmailMessageError extends Error {
	constructor(reason) {
		super(reason);
		this.name = "MalformedGmailMessageError";
		this.reason = reason;
	}
}

function requiredId(value, label) {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!ID_PATTERN.test(normalized)) throw new Error(`${label} is invalid`);
	return normalized;
}

function requiredText(value, label, maximum) {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!normalized || normalized.length > maximum) throw new Error(`${label} is invalid`);
	return normalized;
}

function oneAddress(value, label) {
	const addresses = emailAddresses(value);
	if (addresses.length !== 1) throw new Error(`${label} must contain exactly one email address`);
	return addresses[0];
}

function boundedUnique(values, maximum = MAX_SEEN_MESSAGES) {
	return [...new Set(values)].slice(-maximum);
}

function historyOrder(value) {
	try {
		return BigInt(value);
	} catch {
		return 0n;
	}
}

export function isExpiredHistory(error) {
	return error instanceof GogCommandError
		&& /(?:404|history.*(?:expired|too old|invalid)|startHistoryId)/i.test(`${error.message} ${error.stderr}`);
}

export function isThrottled(error) {
	return error instanceof GogCommandError
		&& /(?:429|rate.?limit|resource_exhausted|too many requests)/i.test(`${error.message} ${error.stderr}`);
}

export function isPermanentMissingMessage(error) {
	return error instanceof GogCommandError
		&& /(?:HTTP\s*)?404\b/i.test(`${error.message} ${error.stderr}`);
}

async function loadState(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return {
			cursor: typeof parsed?.cursor === "string" ? parsed.cursor : null,
			seenMessageIds: Array.isArray(parsed?.seenMessageIds)
				? parsed.seenMessageIds.filter((value) => typeof value === "string")
				: [],
			quarantinedMessages: Array.isArray(parsed?.quarantinedMessages)
				? parsed.quarantinedMessages.filter((value) => value && typeof value === "object").slice(-MAX_QUARANTINED_MESSAGES)
				: [],
			status: parsed?.status === "rebaseline-required" ? "rebaseline-required" : "active",
			emptyMailbox: parsed?.emptyMailbox === true,
			blockedAt: typeof parsed?.blockedAt === "string" ? parsed.blockedAt : null,
			initializedAt: typeof parsed?.initializedAt === "string" ? parsed.initializedAt : null,
		};
	} catch (error) {
		if (error?.code === "ENOENT") return {
			cursor: null,
			seenMessageIds: [],
			quarantinedMessages: [],
			status: "active",
			emptyMailbox: false,
			blockedAt: null,
			initializedAt: null,
		};
		throw error;
	}
}

async function persistState(path, state) {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
	const parent = await open(directory, "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

export class HostdGmailHistoryClient {
	constructor({ endpoint, token, fetchImpl = fetch, timeoutMs = 5_000 }) {
		const parsed = new URL(endpoint);
		if (parsed.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(parsed.hostname)) {
			throw new Error("Hostd Gmail ingress must use the guest loopback end of the supervised tunnel");
		}
		if (parsed.pathname !== "/v1/inbound/gmail-history" || parsed.search || parsed.hash) {
			throw new Error("Hostd Gmail ingress URL path is invalid");
		}
		this.endpoint = parsed.toString();
		this.token = requiredText(token, "Hostd ingress token", 16 * 1024);
		this.fetch = fetchImpl;
		this.timeoutMs = timeoutMs;
	}

	async accept(event) {
		const response = await this.fetch(this.endpoint, {
			method: "POST",
			redirect: "error",
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Hostd Gmail ingress returned HTTP ${response.status}`);
		let receipt;
		try {
			receipt = JSON.parse(text);
		} catch {
			throw new Error("Hostd Gmail ingress receipt is invalid");
		}
		if (
			receipt?.accepted !== true
			|| receipt.providerMessageId !== event.providerMessageId
			|| receipt.historyId !== event.historyId
			|| typeof receipt.eventId !== "string"
			|| !receipt.eventId
		) {
			throw new Error("Hostd Gmail ingress receipt does not match the provider position");
		}
		return receipt;
	}
}

export class GmailHistoryWatcher {
	constructor({
		account,
		contextId,
		statePath,
		gmail,
		hostd,
		activeIntervalMs = 2_000,
		minimumBackoffMs = 2_000,
		maximumBackoffMs = 60_000,
		jitterRatio = 0.15,
		random = Math.random,
		now = Date.now,
	}) {
		this.account = oneAddress(account, "account");
		this.contextId = requiredId(contextId, "context ID");
		this.statePath = statePath;
		this.gmail = gmail;
		this.hostd = hostd;
		this.activeIntervalMs = activeIntervalMs;
		this.minimumBackoffMs = minimumBackoffMs;
		this.maximumBackoffMs = maximumBackoffMs;
		this.jitterRatio = jitterRatio;
		this.random = random;
		this.now = now;
		this.state = null;
		this.inFlight = null;
		this.timer = null;
		this.stopped = true;
		this.failures = 0;
		if (!Number.isSafeInteger(activeIntervalMs) || activeIntervalMs < 1_000 || activeIntervalMs > 60_000) {
			throw new Error("active interval is invalid");
		}
	}

	async initialize() {
		this.state = await loadState(this.statePath);
		return this;
	}

	async newestHistoryCursor() {
		const newest = await this.gmail.searchMessages("in:anywhere", 1);
		if (newest.length === 0) return null;
		return (await this.gmail.getMessageEnvelope(newest[0].id)).historyId;
	}

	async initializeWithoutReplay() {
		const cursor = await this.newestHistoryCursor();
		const inbox = cursor ? await this.gmail.searchMessages("in:inbox newer_than:2d", 100) : [];
		const baselineIds = [];
		for (const message of inbox) {
			const envelope = await this.gmail.getMessageEnvelope(message.id);
			if (historyOrder(envelope.historyId) <= historyOrder(cursor)) baselineIds.push(message.id);
		}
		this.state = {
			cursor,
			seenMessageIds: boundedUnique(baselineIds),
			quarantinedMessages: [],
			status: "active",
			emptyMailbox: cursor === null,
			blockedAt: null,
			initializedAt: new Date(this.now()).toISOString(),
		};
		await persistState(this.statePath, this.state);
		return { initialized: true, cursor, delivered: 0 };
	}

	async pollInitializedEmptyMailbox() {
		const cursor = await this.newestHistoryCursor();
		if (!cursor) return { initialized: false, cursor: null, delivered: 0, quarantined: 0 };
		const inbox = await this.gmail.searchMessages("in:inbox", 500);
		const candidates = [];
		for (const message of inbox) {
			const envelope = await this.gmail.getMessageEnvelope(message.id);
			if (historyOrder(envelope.historyId) <= historyOrder(cursor)) {
				candidates.push({ ...message, historyId: envelope.historyId });
			}
		}
		candidates.sort((left, right) => {
			const order = historyOrder(left.historyId) - historyOrder(right.historyId);
			return order < 0n ? -1 : order > 0n ? 1 : left.id.localeCompare(right.id);
		});
		const { delivered, quarantined } = await this.deliverCandidates(candidates);
		this.state.cursor = cursor;
		this.state.emptyMailbox = false;
		await persistState(this.statePath, this.state);
		return { initialized: false, cursor, delivered, quarantined };
	}

	async listFromCursor(cursor) {
		const messages = [];
		let page = null;
		let finalHistoryId = cursor;
		for (let index = 0; index < 10; index += 1) {
			const result = await this.gmail.listHistory(cursor, { maximum: 100, page });
			messages.push(...result.messages);
			if (result.historyId && historyOrder(result.historyId) > historyOrder(finalHistoryId)) {
				finalHistoryId = result.historyId;
			}
			page = result.nextPageToken;
			if (!page) {
				const deduplicated = [...new Map(messages.map((message) => [message.id, message])).values()];
				deduplicated.sort((left, right) => {
					const order = historyOrder(left.historyId) - historyOrder(right.historyId);
					return order < 0n ? -1 : order > 0n ? 1 : left.id.localeCompare(right.id);
				});
				return { messages: deduplicated, finalHistoryId };
			}
		}
		throw new Error("Gmail History exceeded its ten-page reconciliation bound");
	}

	async normalizedEvent(candidate) {
		let metadata;
		let thread;
		try {
			metadata = await this.gmail.getMetadata(candidate.id);
			thread = await this.gmail.getThread(candidate.threadId);
		} catch (error) {
			if (isPermanentMissingMessage(error)) throw new MalformedGmailMessageError("provider_message_missing");
			throw error;
		}
		try {
			const sender = oneAddress(metadata["reply-to"] || metadata.from, "message sender");
			if (sender === this.account) return null;
			const message = thread.find((entry) => entry.id === candidate.id);
			if (!message) throw new Error("Gmail thread did not contain the history message");
			const subject = requiredText(message.subject || metadata.subject || "(no subject)", "message subject", 998);
			const body = typeof message.body === "string" ? message.body.replaceAll("\u0000", "").slice(0, 2_000_000) : "";
			return {
				contextId: this.contextId,
				mailbox: this.account,
				historyId: requiredId(candidate.historyId, "history ID"),
				providerMessageId: requiredId(candidate.id, "provider message ID"),
				providerThreadId: requiredId(candidate.threadId, "provider thread ID"),
				sender,
				fromFull: message.from || metadata.from || sender,
				to: message.to || this.account,
				cc: message.cc || "",
				subject,
				body,
				allRecipients: emailAddresses([message.to, message.cc].filter(Boolean).join(",")),
			};
		} catch {
			throw new MalformedGmailMessageError("malformed_message");
		}
	}

	async deliverCandidates(candidates) {
		let delivered = 0;
		let quarantined = 0;
		for (const candidate of candidates) {
			if (this.state.seenMessageIds.includes(candidate.id)) continue;
			let event;
			try {
				event = await this.normalizedEvent(candidate);
			} catch (error) {
				if (!(error instanceof MalformedGmailMessageError)) throw error;
				this.state.quarantinedMessages = [
					...(this.state.quarantinedMessages || []),
					{
						providerMessageId: requiredId(candidate.id, "provider message ID"),
						historyId: requiredId(candidate.historyId, "history ID"),
						reason: error.reason,
						quarantinedAt: new Date(this.now()).toISOString(),
					},
				].slice(-MAX_QUARANTINED_MESSAGES);
				quarantined += 1;
				event = null;
			}
			if (event) {
				await this.hostd.accept(event);
				delivered += 1;
			}
			this.state.seenMessageIds = boundedUnique([...this.state.seenMessageIds, candidate.id]);
			await persistState(this.statePath, this.state);
		}
		return { delivered, quarantined };
	}

	async blockExpiredCursor() {
		this.state.status = "rebaseline-required";
		this.state.blockedAt = new Date(this.now()).toISOString();
		await persistState(this.statePath, this.state);
		throw new GmailHistoryRebaselineRequiredError();
	}

	async performPoll() {
		if (!this.state) await this.initialize();
		if (this.state.status === "rebaseline-required") throw new GmailHistoryRebaselineRequiredError();
		if (!this.state.cursor && !this.state.initializedAt) return this.initializeWithoutReplay();
		if (!this.state.cursor && this.state.emptyMailbox) return this.pollInitializedEmptyMailbox();
		if (!this.state.cursor) throw new Error("Gmail History state omitted a cursor without an empty-mailbox marker");
		let history;
		try {
			history = await this.listFromCursor(this.state.cursor);
		} catch (error) {
			if (isExpiredHistory(error)) return this.blockExpiredCursor();
			throw error;
		}
		const { delivered, quarantined } = await this.deliverCandidates(history.messages);
		this.state.cursor = history.finalHistoryId;
		await persistState(this.statePath, this.state);
		return { initialized: false, cursor: this.state.cursor, delivered, quarantined };
	}

	pollOnce() {
		if (this.inFlight) return Promise.resolve({ skipped: "in_flight" });
		this.inFlight = this.performPoll().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	nextDelay(success) {
		const base = success
			? this.activeIntervalMs
			: Math.min(this.maximumBackoffMs, this.minimumBackoffMs * (2 ** Math.max(0, this.failures - 1)));
		const jitter = base * this.jitterRatio * ((this.random() * 2) - 1);
		return Math.max(250, Math.round(base + jitter));
	}

	start({ onError = (error) => console.error(`gmail-history-watcher: ${error.message}`) } = {}) {
		if (!this.stopped) return;
		this.stopped = false;
		const tick = async () => {
			const startedAt = this.now();
			let success = false;
			try {
				await this.pollOnce();
				this.failures = 0;
				success = true;
			} catch (error) {
				this.failures += 1;
				onError(error, { throttled: isThrottled(error), failures: this.failures });
			}
			if (this.stopped) return;
			const targetDelay = this.nextDelay(success);
			const elapsed = Math.max(0, this.now() - startedAt);
			this.timer = setTimeout(tick, Math.max(0, targetDelay - elapsed));
		};
		void tick();
	}

	async stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (this.inFlight) {
			this.gmail.terminate?.();
			try {
				await this.inFlight;
			} catch {
				// Shutdown owns the cancellation after the subprocess has terminated.
			}
		}
	}
}
