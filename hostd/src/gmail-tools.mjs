import { createHash } from "node:crypto";
import { emailAddresses, stablePrivateKey } from "./security.mjs";

const PROVIDER_ID = /^[A-Za-z0-9_-]+$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]+$/;
const MAX_THREAD_CHARACTERS = 100_000;
const MAX_MESSAGE_BODY_CHARACTERS = 30_000;

export class GmailToolError extends Error {
	constructor(status, code) {
		super(code);
		this.status = status;
		this.code = code;
	}
}

function requireProviderId(value, code) {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id || id.length > 256 || !PROVIDER_ID.test(id)) throw new GmailToolError(400, code);
	return id;
}

function requireIdempotencyKey(value) {
	const key = typeof value === "string" ? value.trim() : "";
	if (!key || key.length > 256 || !IDEMPOTENCY_KEY.test(key)) {
		throw new GmailToolError(400, "idempotency_key_invalid");
	}
	return key;
}

function requireBody(value) {
	if (typeof value !== "string" || !value.trim()) throw new GmailToolError(400, "body_required");
	if (value.length > 100_000 || value.includes("\u0000")) throw new GmailToolError(400, "body_invalid");
	return value;
}

function normalizeBody(value) {
	return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd();
}

function bodySha256(value) {
	return createHash("sha256").update(normalizeBody(value), "utf8").digest("hex");
}

function requireSubject(value) {
	const subject = typeof value === "string" ? value.trim() : "";
	if (!subject || subject.length > 998 || /[\r\n\u0000]/.test(subject)) {
		throw new GmailToolError(400, "subject_invalid");
	}
	return subject;
}

function replySubject(value) {
	const cleaned = String(value || "").replace(/[\r\n\u0000]+/g, " ").trim().slice(0, 990) || "Message";
	return /^re:/i.test(cleaned) ? cleaned : `Re: ${cleaned}`;
}

function requireExactAddress(value) {
	const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
	const addresses = emailAddresses(raw);
	if (addresses.length !== 1 || addresses[0] !== raw || raw.length > 320) {
		throw new GmailToolError(400, "contact_invalid");
	}
	return raw;
}

function threadAddresses(thread) {
	const addresses = new Set();
	for (const message of thread) {
		for (const field of [message.from, message.to, message.cc, message.bcc, message.replyTo]) {
			for (const address of emailAddresses(field || "")) addresses.add(address);
		}
	}
	return addresses;
}

function canonicalAddresses(values) {
	const addresses = new Set();
	for (const value of values) {
		const candidates = Array.isArray(value) ? value : emailAddresses(value || "");
		for (const candidate of candidates) {
			const address = String(candidate || "").trim().toLowerCase();
			if (address) addresses.add(address);
		}
	}
	return [...addresses].sort();
}

function replyCcAddresses(message, account, contact, alwaysCc = []) {
	return canonicalAddresses([message?.to, message?.cc, alwaysCc])
		.filter((address) => address !== account && address !== contact);
}

function sameAddresses(left, right) {
	return JSON.stringify(canonicalAddresses([left])) === JSON.stringify(canonicalAddresses([right]));
}

function sameRequest(request, { action, targetId, contextId, providerDraftId }) {
	return request.action === action
		&& request.targetId === targetId
		&& request.contextId === contextId
		&& (providerDraftId === undefined || (request.providerDraftId || null) === providerDraftId);
}

function completedDraftResult(store, request) {
	if (request.status !== "completed" || !request.providerDraftId) return null;
	const draft = store.getGmailDraft(request.providerDraftId);
	if (!draft) throw new GmailToolError(409, "draft_receipt_incomplete");
	return {
		ok: true,
		status: draft.status,
		draft_id: draft.providerDraftId,
		thread_id: draft.providerThreadId,
		...(draft.providerMessageId ? { message_id: draft.providerMessageId } : {}),
		duplicate: true,
	};
}

function boundedThread(thread) {
	let used = 0;
	const messages = [];
	for (const message of thread) {
		if (used >= MAX_THREAD_CHARACTERS) break;
		const body = String(message.body || "").slice(0, MAX_MESSAGE_BODY_CHARACTERS);
		const remaining = MAX_THREAD_CHARACTERS - used;
		const boundedBody = body.slice(0, remaining);
		messages.push({
			id: message.id,
			date: message.date,
			from: message.from,
			to: message.to,
			...(message.cc ? { cc: message.cc } : {}),
			...(message.replyTo ? { reply_to: message.replyTo } : {}),
			subject: message.subject,
			body: boundedBody,
		});
		used += boundedBody.length;
	}
	return messages;
}

export class HostGmailTools {
	constructor({ config, store, gmail, routingKey }) {
		this.config = config;
		this.store = store;
		this.gmail = gmail;
		this.routingKey = routingKey;
		this.account = config.gmail.account.toLowerCase();
	}

	async resolveScope(target, contextId) {
		const stored = this.store.getContextScope(contextId, target.id);
		if (!stored) throw new GmailToolError(403, "context_scope_denied");
		let contact = stored.emailAddress;
		if (contact) {
			const expected = stablePrivateKey(this.routingKey, "email-principal", contact);
			if (expected !== stored.principalHash) throw new Error("stored principal contact failed verification");
		}
		if (!contact) {
			for (const route of this.store.listRoutesForContext(contextId, target.id)) {
				if (route.source !== "gmail") continue;
				const thread = await this.gmail.getThread(route.providerThreadId);
				for (const address of threadAddresses(thread)) {
					if (address === this.account) continue;
					const candidate = stablePrivateKey(this.routingKey, "email-principal", address);
					if (candidate === stored.principalHash) {
						contact = address;
						break;
					}
				}
				if (contact) break;
			}
			if (!contact) throw new GmailToolError(409, "contact_unavailable");
			this.store.setPrincipalEmail(stored.principalHash, contact);
		}
		return { ...stored, contact };
	}

	async threadForContext(target, contextId, scope, threadId) {
		const route = this.store.getRoute("gmail", threadId);
		if (route && (route.contextId !== contextId || route.targetId !== target.id)) {
			throw new GmailToolError(403, "conversation_scope_denied");
		}
		const thread = await this.gmail.getThread(threadId);
		if (!route) {
			const allowed = new Set([scope.contact, ...(this.config.gmail.alwaysCc ?? [])]);
			const external = [...threadAddresses(thread)].filter((address) => address !== this.account);
			if (external.length === 0 || external.some((address) => !allowed.has(address))) {
				throw new GmailToolError(403, "conversation_scope_denied");
			}
		}
		return thread;
	}

	async search(target, contextId, input) {
		const scope = await this.resolveScope(target, contextId);
		const rawQuery = typeof input.query === "string" ? input.query.trim() : "";
		if (!rawQuery || rawQuery.length > 500 || rawQuery.includes("\u0000")) {
			throw new GmailToolError(400, "query_invalid");
		}
		const query = rawQuery.replace(/[\r\n]+/g, " ");
		const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(20, input.limit)) : 10;
		const providerQuery = `(${query}) {from:${scope.contact} to:${scope.contact} replyto:${scope.contact}}`;
		const candidates = await this.gmail.searchThreads(providerQuery, Math.min(50, Math.max(limit, limit * 3)));
		const threads = [];
		for (const candidate of candidates) {
			if (threads.length >= limit) break;
			const route = this.store.getRoute("gmail", candidate.id);
			if (route && (route.contextId !== contextId || route.targetId !== target.id)) continue;
			if (!route) {
				try {
					await this.threadForContext(target, contextId, scope, candidate.id);
				} catch (error) {
					if (error instanceof GmailToolError && error.status === 403) continue;
					throw error;
				}
			}
			threads.push({
				thread_id: candidate.id,
				date: candidate.date,
				from: candidate.from,
				subject: candidate.subject,
				message_count: candidate.messageCount,
			});
		}
		return { ok: true, threads };
	}

	async read(target, contextId, input) {
		const scope = await this.resolveScope(target, contextId);
		const threadId = requireProviderId(input.thread_id, "thread_id_invalid");
		const thread = await this.threadForContext(target, contextId, scope, threadId);
		return { ok: true, thread_id: threadId, messages: boundedThread(thread) };
	}

	async draft(target, contextId, input) {
		const scope = await this.resolveScope(target, contextId);
		const body = requireBody(input.body);
		const idempotencyKey = requireIdempotencyKey(input.idempotency_key);
		const draftIdInput = typeof input.draft_id === "string" && input.draft_id.trim()
			? requireProviderId(input.draft_id, "draft_id_invalid")
			: undefined;
		if (draftIdInput) {
			if (input.thread_id !== undefined || input.to !== undefined || input.subject !== undefined) {
				throw new GmailToolError(400, "draft_update_body_only");
			}
			return await this.updateDraft(target, contextId, scope, idempotencyKey, draftIdInput, body);
		}

		const hasThread = typeof input.thread_id === "string" && Boolean(input.thread_id.trim());
		const hasComposeField = input.to !== undefined || input.subject !== undefined;
		if (hasThread === hasComposeField) throw new GmailToolError(400, "draft_addressing_mode_invalid");

		let mode;
		let contact;
		let subject;
		let providerThreadId;
		let replyToMessageId;
		let ccAddresses;
		if (hasThread) {
			if (input.to !== undefined || input.subject !== undefined) {
				throw new GmailToolError(400, "draft_addressing_mode_invalid");
			}
			mode = "thread";
			providerThreadId = requireProviderId(input.thread_id, "thread_id_invalid");
			const thread = await this.threadForContext(target, contextId, scope, providerThreadId);
			const replyTarget = [...thread].reverse().find((message) => (
				emailAddresses(message.from || "").includes(scope.contact)
				|| emailAddresses(message.replyTo || "").includes(scope.contact)
			));
			if (!replyTarget) throw new GmailToolError(409, "reply_target_unavailable");
			replyToMessageId = requireProviderId(replyTarget.id, "reply_target_unavailable");
			subject = replySubject(replyTarget.subject || thread.find((message) => message.subject)?.subject);
			contact = scope.contact;
			ccAddresses = replyCcAddresses(
				replyTarget,
				this.account,
				contact,
				this.config.gmail.alwaysCc ?? [],
			);
		} else {
			mode = "compose";
			contact = requireExactAddress(input.to);
			if (contact !== scope.contact) throw new GmailToolError(403, "contact_scope_denied");
			subject = requireSubject(input.subject);
			ccAddresses = replyCcAddresses(
				undefined,
				this.account,
				contact,
				this.config.gmail.alwaysCc ?? [],
			);
		}

		const action = "draft_create";
		const request = this.store.startGmailRequest({
			idempotencyKey,
			action,
			targetId: target.id,
			contextId,
		});
		if (!sameRequest(request, { action, targetId: target.id, contextId })) {
			throw new GmailToolError(409, "idempotency_key_conflict");
		}
		const duplicate = completedDraftResult(this.store, request);
		if (duplicate) return duplicate;
		if (request.status !== "running") throw new GmailToolError(409, "draft_request_unresolved");
		if (request.providerDraftId) throw new GmailToolError(409, "draft_request_unresolved");

		let receipt;
		try {
			receipt = await this.gmail.createDraft({
				to: contact,
				cc: ccAddresses,
				subject,
				body,
				replyToMessageId,
			});
			if (mode === "thread" && receipt.threadId !== providerThreadId) {
				throw new Error("provider draft thread did not match the requested thread");
			}
			providerThreadId = receipt.threadId;
			const binding = {
				providerDraftId: receipt.draftId,
				targetId: target.id,
				contextId,
				principalHash: scope.principalHash,
				contactAddress: contact,
				ccAddresses,
				mode,
				providerThreadId,
				replyToMessageId,
				subject,
				bodySha256: bodySha256(body),
			};
			this.verifyProviderDraft(await this.gmail.getDraft(receipt.draftId), binding);
			const draft = this.store.completeGmailDraftCreate(idempotencyKey, binding);
			return { ok: true, status: "draft", draft_id: draft.providerDraftId, thread_id: draft.providerThreadId };
		} catch (error) {
			if (receipt?.draftId) {
				try {
					await this.gmail.deleteDraft(receipt.draftId);
				} catch {
					// The failed request remains unresolved and cannot be retried automatically.
				}
			}
			this.store.failGmailRequest(idempotencyKey, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	async updateDraft(target, contextId, scope, idempotencyKey, providerDraftId, body) {
		const draft = this.store.getGmailDraft(providerDraftId);
		if (!draft || draft.contextId !== contextId || draft.targetId !== target.id || draft.principalHash !== scope.principalHash) {
			throw new GmailToolError(403, "draft_scope_denied");
		}
		if (draft.status !== "draft") throw new GmailToolError(409, "draft_not_editable");
		const action = "draft_update";
		const request = this.store.startGmailRequest({
			idempotencyKey,
			action,
			targetId: target.id,
			contextId,
			providerDraftId,
		});
		if (!sameRequest(request, { action, targetId: target.id, contextId, providerDraftId })) {
			throw new GmailToolError(409, "idempotency_key_conflict");
		}
		const duplicate = completedDraftResult(this.store, request);
		if (duplicate) return duplicate;
		if (request.status !== "running") throw new GmailToolError(409, "draft_request_unresolved");
		try {
			const receipt = await this.gmail.updateDraft(providerDraftId, {
				to: draft.contactAddress,
				cc: draft.ccAddresses,
				subject: draft.subject,
				body,
				replyToMessageId: draft.replyToMessageId,
			});
			if (receipt.draftId !== providerDraftId || receipt.threadId !== draft.providerThreadId) {
				throw new Error("provider changed immutable draft binding");
			}
			const next = { ...draft, bodySha256: bodySha256(body) };
			this.verifyProviderDraft(await this.gmail.getDraft(providerDraftId), next);
			const completed = this.store.completeGmailDraftUpdate(
				idempotencyKey,
				providerDraftId,
				next.bodySha256,
				receipt.threadId,
			);
			return { ok: true, status: "draft", draft_id: completed.providerDraftId, thread_id: completed.providerThreadId };
		} catch (error) {
			this.store.failGmailRequest(idempotencyKey, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	verifyProviderDraft(provider, binding) {
		if (provider.draftId !== binding.providerDraftId
			|| provider.threadId !== binding.providerThreadId
			|| provider.to.length !== 1
			|| provider.to[0] !== binding.contactAddress
			|| !sameAddresses(provider.cc, binding.ccAddresses)
			|| provider.bcc.length !== 0
			|| provider.replyTo.length !== 0
			|| provider.subject !== binding.subject
			|| provider.hasAttachments
			|| bodySha256(provider.body) !== binding.bodySha256) {
			throw new GmailToolError(409, "draft_binding_changed");
		}
	}

	async send(target, contextId, input) {
		const scope = await this.resolveScope(target, contextId);
		const providerDraftId = requireProviderId(input.draft_id, "draft_id_invalid");
		const idempotencyKey = requireIdempotencyKey(input.idempotency_key);
		let draft = this.store.getGmailDraft(providerDraftId);
		if (!draft || draft.contextId !== contextId || draft.targetId !== target.id || draft.principalHash !== scope.principalHash) {
			throw new GmailToolError(403, "draft_scope_denied");
		}
		if (draft.status === "sent" && draft.providerMessageId) {
			return {
				ok: true,
				status: "sent",
				draft_id: draft.providerDraftId,
				message_id: draft.providerMessageId,
				thread_id: draft.providerThreadId,
				duplicate: true,
			};
		}
		if (draft.status !== "draft") throw new GmailToolError(409, "draft_send_unresolved");
		const providerDraft = await this.gmail.getDraft(providerDraftId);
		this.verifyProviderDraft(providerDraft, draft);

		const action = "draft_send";
		const request = this.store.startGmailRequest({
			idempotencyKey,
			action,
			targetId: target.id,
			contextId,
			providerDraftId,
		});
		if (!sameRequest(request, { action, targetId: target.id, contextId, providerDraftId })) {
			throw new GmailToolError(409, "idempotency_key_conflict");
		}
		const duplicate = completedDraftResult(this.store, request);
		if (duplicate) return duplicate;
		if (request.status !== "running") throw new GmailToolError(409, "draft_send_unresolved");
		draft = this.store.markGmailDraftSending(providerDraftId);
		if (!draft) throw new GmailToolError(409, "draft_send_unresolved");
		try {
			const receipt = await this.gmail.sendDraft(providerDraftId);
			if (receipt.threadId !== draft.providerThreadId) {
				throw new Error("provider sent the draft in an unexpected thread");
			}
			const completed = this.store.completeGmailDraftSend(
				idempotencyKey,
				providerDraftId,
				receipt.messageId,
				receipt.threadId,
				(this.config.mattermost || this.config.rocketChat || this.config.zulip) ? {
					id: `gmail_outbound:${receipt.messageId}`,
					source: "gmail_outbound",
					providerMessageId: receipt.messageId,
					providerThreadId: receipt.threadId,
					principalHash: draft.principalHash,
					targetId: draft.targetId,
					contextId: draft.contextId,
					payload: {
						direction: "outbound",
						sender: this.account,
						recipient: draft.contactAddress,
						metadata: { subject: draft.subject },
						route: { projectSlug: scope.projectSlug },
						message: {
							id: receipt.messageId,
							threadId: receipt.threadId,
							body: providerDraft.body,
						},
					},
				} : undefined,
			);
			return {
				ok: true,
				status: "sent",
				draft_id: completed.providerDraftId,
				message_id: completed.providerMessageId,
				thread_id: completed.providerThreadId,
			};
		} catch (error) {
			this.store.failGmailRequest(idempotencyKey, error instanceof Error ? error.message : String(error));
			this.store.markGmailDraftUncertain(providerDraftId);
			throw error;
		}
	}
}
