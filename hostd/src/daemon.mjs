import { randomUUID } from "node:crypto";
import { emailAddresses } from "./security.mjs";

function suppressionReason(headers, account) {
	const senders = emailAddresses(headers.from || "");
	if (senders.length !== 1) return "ambiguous_sender";
	const sender = senders[0];
	if (sender === account.toLowerCase()) return "self_mail";
	const localPart = sender.split("@", 1)[0];
	const subject = (headers.subject || "").toLowerCase();
	if (["mailer-daemon", "postmaster"].includes(localPart)) return "bounce_sender";
	if (/delivery status notification|undeliverable|mail delivery (?:failed|subsystem)|returned mail/.test(subject)) {
		return "bounce_subject";
	}
	const autoSubmitted = (headers["auto-submitted"] || "").toLowerCase();
	if (autoSubmitted && autoSubmitted !== "no") return "auto_submitted";
	const precedence = (headers.precedence || "").toLowerCase();
	if (["bulk", "junk", "list"].includes(precedence)) return "bulk_precedence";
	if (headers["x-auto-response-suppress"]) return "auto_response_suppressed";
	if (headers["list-id"]) return "mailing_list";
	return null;
}

function pendingReads(store) {
	const encoded = store.getMeta("gmail:pending_read_ids");
	if (!encoded) return [];
	try {
		const parsed = JSON.parse(encoded);
		return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
	} catch {
		throw new Error("pending Gmail read state is malformed");
	}
}

function setPendingReads(store, ids) {
	store.setMeta("gmail:pending_read_ids", JSON.stringify([...new Set(ids)]));
}

export class InboxDaemon {
	constructor({ config, store, gmail, router, runtime }) {
		this.config = config;
		this.store = store;
		this.gmail = gmail;
		this.router = router;
		this.runtime = runtime;
		this.polling = false;
	}

	async baseline() {
		if (this.store.getMeta("gmail:last_successful_poll_at")) {
			throw new Error("Gmail baseline already exists");
		}
		const messages = this.gmail.searchMessages("in:inbox newer_than:30d");
		this.store.importSeen("gmail", messages.map((message) => message.id));
		const timestamp = new Date().toISOString();
		this.store.setMeta("gmail:last_successful_poll_at", timestamp);
		setPendingReads(this.store, []);
		return { existing: messages.length, wakes: 0 };
	}

	async retryPendingReads() {
		const ids = pendingReads(this.store);
		for (const id of [...ids]) {
			this.gmail.markRead(id);
			const remaining = pendingReads(this.store).filter((candidate) => candidate !== id);
			setPendingReads(this.store, remaining);
			console.log(`troublemaker-hostd: completed deferred Gmail read mark for ${id}`);
		}
	}

	async pollOnce() {
		if (this.polling) return { skipped: "poll_in_progress" };
		this.polling = true;
		try {
			await this.retryPendingReads();
			const lastSuccessful = this.store.getMeta("gmail:last_successful_poll_at");
			if (!lastSuccessful) throw new Error("Gmail baseline or checkpoint import is required");
			const lastSuccessfulMs = Date.parse(lastSuccessful);
			if (!Number.isFinite(lastSuccessfulMs)) throw new Error("Gmail checkpoint timestamp is invalid");
			const after = Math.max(
				0,
				Math.floor(lastSuccessfulMs / 1000) - this.config.gmail.overlapSeconds,
			);
			const searched = this.gmail.searchMessages(`in:inbox after:${after}`);
			const retryable = this.store.listRetryableEvents()
				.filter((event) => event.source === "gmail")
				.map((event) => ({
					id: event.providerMessageId,
					threadId: event.providerThreadId,
				}));
			const messagesById = new Map(
				[...retryable, ...searched].map((message) => [message.id, message]),
			);
			const messages = [...messagesById.values()];
			const fresh = messages.filter((message) => !this.store.hasSeen("gmail", message.id)).reverse();
			let wakes = 0;
			let suppressed = 0;
			let failures = 0;

			for (const message of fresh) {
				const metadata = this.gmail.getMetadata(message.id);
				const reason = suppressionReason(metadata, this.config.gmail.account);
				if (reason) {
					this.store.markSeen("gmail", message.id, `suppressed:${reason}`);
					suppressed++;
					console.log(`troublemaker-hostd: suppressed Gmail message ${message.id} (${reason})`);
					continue;
				}

				const sender = emailAddresses(metadata.from || "")[0];
				if (!sender) throw new Error(`Gmail message ${message.id} has no verified sender`);
				const route = this.router.resolve({
					source: "gmail",
					threadId: message.threadId,
					sender,
				});
				let event = this.store.upsertEvent({
					id: randomUUID(),
					source: "gmail",
					providerMessageId: message.id,
					providerThreadId: message.threadId,
					principalHash: route.principalHash,
					targetId: route.targetId,
					contextId: route.contextId,
				});

				if (event.status !== "completed") {
					const thread = this.gmail.getThread(message.threadId);
					this.store.startEvent(event.id);
					try {
						await this.runtime.deliver({ event, route, message, metadata, sender, thread });
						this.store.completeEvent(event.id);
					} catch (error) {
						this.store.failEvent(event.id, error instanceof Error ? error.message : String(error));
						failures++;
						console.error(
							`troublemaker-hostd: delivery failed for Gmail message ${message.id}:`,
							error instanceof Error ? error.message : String(error),
						);
						continue;
					}
					event = this.store.getEventByProviderMessage("gmail", message.id);
					wakes++;
				}

				this.store.markSeen("gmail", message.id, "completed");
				setPendingReads(this.store, [...pendingReads(this.store), message.id]);
				this.gmail.markRead(message.id);
				setPendingReads(
					this.store,
					pendingReads(this.store).filter((candidate) => candidate !== message.id),
				);
				console.log(
					`troublemaker-hostd: handled Gmail message ${message.id} in ${event.contextId} (wake ${wakes})`,
				);
			}

			this.store.setMeta("gmail:last_successful_poll_at", new Date().toISOString());
			const result = {
				candidates: messages.length,
				fresh: fresh.length,
				wakes,
				suppressed,
				failures,
			};
			console.log(
				`troublemaker-hostd: poll complete (${result.candidates} candidate(s), ${result.fresh} new, ${result.wakes} wake(s), ${result.suppressed} suppressed, ${result.failures} failed)`,
			);
			return result;
		} finally {
			this.polling = false;
		}
	}
}
