import { randomUUID } from "node:crypto";
import {
	ContactRelayVerificationError,
	resolveInboundPrincipal,
} from "./contact-relay.mjs";
import {
	GmailEnvelopeParticipantError,
	normalizedGmailHeaderMailboxes,
	resolveGmailEnvelopeParticipant,
} from "./gmail-envelope.mjs";
import { RouteParticipantDeniedError } from "./router.mjs";

function suppressionReason(headers, account, senders) {
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

function isInternalGmailSender(address, account, internalDomains) {
	const normalized = address.trim().toLowerCase();
	if (normalized === account.trim().toLowerCase()) return true;
	const separator = normalized.lastIndexOf("@");
	if (separator === -1) return false;
	const domain = normalized.slice(separator + 1);
	return internalDomains.some((candidate) => candidate.trim().toLowerCase() === domain);
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
	constructor({ config, store, gmail, router, scheduler, controlNotifier }) {
		this.config = config;
		this.store = store;
		this.gmail = gmail;
		this.router = router;
		this.scheduler = scheduler;
		this.controlNotifier = controlNotifier;
		this.polling = false;
	}

	async baseline() {
		if (this.store.getMeta("gmail:last_successful_poll_at")) {
			throw new Error("Gmail baseline already exists");
		}
		const messages = await this.gmail.searchMessages("in:inbox newer_than:30d");
		this.store.importSeen("gmail", messages.map((message) => message.id));
		const timestamp = new Date().toISOString();
		this.store.setMeta("gmail:last_successful_poll_at", timestamp);
		setPendingReads(this.store, []);
		return { existing: messages.length, wakes: 0 };
	}

	async retryPendingReads() {
		const ids = pendingReads(this.store);
		for (const id of [...ids]) {
			await this.gmail.markRead(id);
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
			const messages = await this.gmail.searchMessages(`in:inbox after:${after}`);
			const fresh = messages.filter((message) => !this.store.hasSeen("gmail", message.id)).reverse();
			let queued = 0;
			let outbound = 0;
			let suppressed = 0;
			let quarantined = 0;
			let failures = 0;

			for (const message of fresh) {
				const metadata = await this.gmail.getMetadata(message.id);
				let senders;
				try {
					senders = normalizedGmailHeaderMailboxes(metadata.from || "");
				} catch (error) {
					if (!(error instanceof GmailEnvelopeParticipantError)) throw error;
					this.store.markSeen("gmail", message.id, `quarantined:${error.code}`);
					quarantined++;
					console.warn(
						`troublemaker-hostd: quarantined Gmail message ${message.id}; ${error.message}`,
					);
					continue;
				}
				const reason = suppressionReason(metadata, this.config.gmail.account, senders);
				if (reason) {
					this.store.markSeen("gmail", message.id, `suppressed:${reason}`);
					suppressed++;
					console.log(`troublemaker-hostd: suppressed Gmail message ${message.id} (${reason})`);
					continue;
				}

				const sender = senders[0];
				if (!sender) throw new Error(`Gmail message ${message.id} has no verified sender`);
				let inbound;
				try {
					inbound = resolveInboundPrincipal({
						headers: metadata,
						sender,
						relays: this.config.gmail.contactRelays,
					});
				} catch (error) {
					if (!(error instanceof ContactRelayVerificationError)) throw error;
					this.store.markSeen("gmail", message.id, "quarantined:contact_relay_invalid");
					quarantined++;
					console.warn(
						`troublemaker-hostd: quarantined Gmail message ${message.id}; contact relay verification failed`,
					);
					continue;
				}
				if (!inbound.relay) {
					try {
						inbound = {
							...inbound,
							principalEmail: resolveGmailEnvelopeParticipant({
								headers: metadata,
								account: this.config.gmail.account,
								internalDomains: this.config.gmail.internalDomains,
							}),
						};
					} catch (error) {
						if (!(error instanceof GmailEnvelopeParticipantError)) throw error;
						this.store.markSeen("gmail", message.id, `quarantined:${error.code}`);
						quarantined++;
						console.warn(
							`troublemaker-hostd: quarantined Gmail message ${message.id}; ${error.message}`,
						);
						continue;
					}
				}
				const direction = inbound.relay || !isInternalGmailSender(
					sender,
					this.config.gmail.account,
					this.config.gmail.internalDomains,
				)
					? "inbound"
					: "outbound";
				let route;
				try {
					route = this.router.resolve({
						source: "gmail",
						threadId: message.threadId,
						sender: inbound.principalEmail,
						project: inbound.project,
						label: inbound.principalLabel,
					});
				} catch (error) {
					if (!(error instanceof RouteParticipantDeniedError)) throw error;
					this.store.markSeen("gmail", message.id, "quarantined:route_participant_denied");
					quarantined++;
					console.warn(
						`troublemaker-hostd: quarantined Gmail message ${message.id}; sender is outside its bound thread`,
					);
					continue;
				}
				try {
					const thread = await this.gmail.getThread(message.threadId);
					if (direction === "outbound") {
						const current = thread.find((candidate) => candidate.id === message.id) ?? {
							...message,
							body: "",
						};
						const eventInput = {
							id: `gmail_outbound:${message.id}`,
							source: "gmail_outbound",
							providerMessageId: message.id,
							providerThreadId: message.threadId,
							principalHash: route.principalHash,
							targetId: route.targetId,
							contextId: route.contextId,
							payload: {
								direction,
								route,
								message: current,
								metadata,
								sender,
								recipient: inbound.principalEmail,
							},
						};
						if (this.controlNotifier) {
							this.store.recordCompletedLedgerEventWithControlNotification(eventInput);
						} else {
							this.store.recordCompletedLedgerEvent(eventInput);
						}
						outbound++;
					} else {
						const eventInput = {
							id: randomUUID(),
							source: "gmail",
							providerMessageId: message.id,
							providerThreadId: message.threadId,
							principalHash: route.principalHash,
							targetId: route.targetId,
							contextId: route.contextId,
							payload: {
								direction,
								route,
								message,
								metadata,
								sender: inbound.principalEmail,
								thread,
								...(inbound.relay ? { relay: inbound.relay } : {}),
							},
						};
						const event = this.controlNotifier
							? this.store.upsertEventWithControlNotification(eventInput)
							: this.store.upsertEvent(eventInput);
						if (event.status !== "completed") queued++;
					}
				} catch (error) {
					failures++;
					console.error(
						`troublemaker-hostd: could not journal Gmail message ${message.id}:`,
						error instanceof Error ? error.message : String(error),
					);
					continue;
				}

				this.store.markSeen("gmail", message.id, direction === "outbound" ? "ledgered:outbound" : "queued");
				setPendingReads(this.store, [...pendingReads(this.store), message.id]);
				await this.gmail.markRead(message.id);
				setPendingReads(
					this.store,
					pendingReads(this.store).filter((candidate) => candidate !== message.id),
				);
				console.log(
					direction === "outbound"
						? `troublemaker-hostd: durably ledgered outbound Gmail message ${message.id} in ${route.contextId}`
						: `troublemaker-hostd: durably queued Gmail message ${message.id} in ${route.contextId}`,
				);
			}

			this.store.setMeta("gmail:last_successful_poll_at", new Date().toISOString());
			this.scheduler?.pump();
			this.controlNotifier?.wake();
			const result = {
				candidates: messages.length,
				fresh: fresh.length,
				queued,
				outbound,
				suppressed,
				quarantined,
				failures,
			};
			console.log(
				`troublemaker-hostd: poll complete (${result.candidates} candidate(s), ${result.fresh} new, ${result.queued} queued, ${result.outbound} outbound, ${result.suppressed} suppressed, ${result.quarantined} quarantined, ${result.failures} failed)`,
			);
			return result;
		} finally {
			this.polling = false;
		}
	}
}
