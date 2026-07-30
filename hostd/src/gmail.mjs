import { spawn } from "node:child_process";
import { plainTextEmailHtml } from "./email-body.mjs";
import { emailAddresses } from "./security.mjs";

const READ_COMMANDS = "gmail.messages.search,gmail.search,gmail.get,gmail.thread.get,gmail.mark-read,gmail.drafts.get";
const DIRECT_SEND_COMMANDS = "gmail.send";
const DRAFT_WRITE_COMMANDS = "gmail.drafts.create,gmail.drafts.update,gmail.drafts.delete";
const DRAFT_SEND_COMMANDS = "gmail.drafts.send";
const PROVIDER_ID = /^[A-Za-z0-9_-]+$/;

function clean(value, maximum) {
	return typeof value === "string" ? value.replaceAll("\u0000", "").trim().slice(0, maximum) : "";
}

function providerId(value, label) {
	const id = clean(value, 256);
	if (!id || !PROVIDER_ID.test(id)) throw new Error(`gog response omitted valid ${label}`);
	return id;
}

function payloadHeaders(payload) {
	const headers = Array.isArray(payload?.headers) ? payload.headers : [];
	return Object.fromEntries(headers
		.map((header) => [clean(header?.name, 256).toLowerCase(), clean(header?.value, 4000)])
		.filter(([name]) => name));
}

function decodeBase64Url(value) {
	if (typeof value !== "string" || !value) return "";
	try {
		return Buffer.from(value, "base64url").toString("utf8").replaceAll("\u0000", "");
	} catch {
		throw new Error("Gmail draft body was not valid base64url data");
	}
}

function plainBody(payload) {
	if (!payload || typeof payload !== "object") return "";
	const mimeType = clean(payload.mimeType, 256).toLowerCase();
	if ((!mimeType || mimeType === "text/plain") && payload.body?.data) {
		return decodeBase64Url(payload.body.data);
	}
	for (const part of Array.isArray(payload.parts) ? payload.parts : []) {
		const body = plainBody(part);
		if (body) return body;
	}
	return "";
}

function hasAttachments(payload) {
	if (!payload || typeof payload !== "object") return false;
	if (clean(payload.filename, 1000)) return true;
	if (clean(payload.body?.attachmentId, 256)) return true;
	return (Array.isArray(payload.parts) ? payload.parts : []).some(hasAttachments);
}

function draftMetadata(parsed) {
	const draft = parsed?.draft;
	const message = draft?.message;
	if (!draft || !message) throw new Error("gog draft response omitted message details");
	const headers = payloadHeaders(message.payload);
	return {
		draftId: providerId(draft.id, "draft ID"),
		messageId: providerId(message.id, "draft message ID"),
		threadId: providerId(message.threadId, "draft thread ID"),
		to: emailAddresses(headers.to || ""),
		cc: emailAddresses(headers.cc || ""),
		bcc: emailAddresses(headers.bcc || ""),
		replyTo: emailAddresses(headers["reply-to"] || ""),
		subject: clean(headers.subject, 998),
		body: plainBody(message.payload),
		hasAttachments: hasAttachments(message.payload),
	};
}

export class GogGmail {
	constructor(config, environment = process.env) {
		this.account = config.account;
		this.gogPath = config.gogPath;
		this.environment = environment;
	}

	async json(args, { timeout = 120_000, commands = READ_COMMANDS, allowSend = false, input } = {}) {
		const result = await new Promise((resolve, reject) => {
			const child = spawn(this.gogPath, [
				"--json",
				"--no-input",
				...(allowSend ? [] : ["--gmail-no-send"]),
				`--enable-commands=${commands}`,
				...args,
			], {
				stdio: ["pipe", "pipe", "pipe"],
				env: this.environment,
			});
			const stdout = [];
			const stderr = [];
			let outputBytes = 0;
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("gog command timed out"));
			}, timeout);
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(new Error(`gog command failed: ${error.message}`));
			});
			child.stdout.on("data", (chunk) => {
				outputBytes += chunk.length;
				if (outputBytes > 32 * 1024 * 1024) {
					child.kill("SIGKILL");
					reject(new Error("gog command exceeded output limit"));
					return;
				}
				stdout.push(chunk);
			});
			child.stderr.on("data", (chunk) => stderr.push(chunk));
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({
					status: code ?? -1,
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
				});
			});
			if (input !== undefined) child.stdin.end(input);
			else child.stdin.end();
		});
		if (result.status !== 0) {
			throw new Error(`gog command exited ${result.status}: ${result.stderr.trim().slice(0, 1000)}`);
		}
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new Error("gog command returned invalid JSON");
		}
	}

	async searchMessages(query) {
		const parsed = await this.json([
			"gmail",
			"messages",
			"search",
			"--account",
			this.account,
			query,
			"--all",
		]);
		if (!Array.isArray(parsed?.messages)) throw new Error("gog search response omitted messages");
		return parsed.messages.map((raw) => {
			const id = clean(raw?.id, 256);
			const threadId = clean(raw?.threadId, 256);
			if (!PROVIDER_ID.test(id) || !PROVIDER_ID.test(threadId)) return null;
			return { id, threadId };
		}).filter(Boolean);
	}

	async searchThreads(query, limit = 10) {
		const parsed = await this.json([
			"gmail",
			"search",
			"--account",
			this.account,
			query,
			"--max",
			String(limit),
		]);
		if (!Array.isArray(parsed?.threads)) throw new Error("gog thread search response omitted threads");
		return parsed.threads.map((raw) => {
			const id = clean(raw?.id, 256);
			if (!PROVIDER_ID.test(id)) return null;
			return {
				id,
				date: clean(raw?.date, 256),
				from: clean(raw?.from, 1000),
				subject: clean(raw?.subject, 2000),
				messageCount: Number.isInteger(raw?.messageCount) ? raw.messageCount : 0,
			};
		}).filter(Boolean);
	}

	async getMetadata(messageId) {
		const parsed = await this.json([
			"gmail",
			"get",
			"--account",
			this.account,
			messageId,
			"--format",
			"full",
		]);
		const headers = payloadHeaders(parsed?.message?.payload);
		if (Object.keys(headers).length === 0) {
			throw new Error("message metadata omitted headers");
		}
		return headers;
	}

	async getThread(threadId) {
		const parsed = await this.json([
			"gmail",
			"thread",
			"get",
			"--account",
			this.account,
			threadId,
			"--full",
			"--sanitize-content",
		], { timeout: 180_000 });
		const messages = parsed?.thread?.messages;
		if (!Array.isArray(messages) || messages.length === 0) {
			throw new Error("thread response omitted messages");
		}
		return messages.map((message) => {
			const headers = message?.headers && typeof message.headers === "object" && !Array.isArray(message.headers)
				? Object.fromEntries(
					Object.entries(message.headers).map(([key, value]) => [key.toLowerCase(), clean(value, 4000)]),
				)
				: {};
			return {
				id: clean(message?.id, 256),
				date: clean(headers.date, 256),
				from: clean(headers.from, 1000),
				to: clean(headers.to, 1000),
				cc: clean(headers.cc, 1000),
				bcc: clean(headers.bcc, 1000),
				replyTo: clean(headers["reply-to"], 1000),
				subject: clean(headers.subject, 2000),
				body: typeof message?.body === "string" ? message.body.replaceAll("\u0000", "") : "",
			};
		});
	}

	async markRead(messageId) {
		await this.json(["gmail", "mark-read", "--account", this.account, messageId]);
	}

	async createDraft({ to, cc = [], subject, body, replyToMessageId }) {
		const toAddresses = Array.isArray(to) ? to : [to];
		const parsed = await this.json([
			"gmail",
			"drafts",
			"create",
			"--account",
			this.account,
			"--to",
			toAddresses.join(","),
			...(cc.length > 0 ? ["--cc", cc.join(",")] : []),
			"--subject",
			subject,
			...(replyToMessageId ? ["--reply-to-message-id", replyToMessageId] : []),
			"--body-file",
			"-",
			"--body-html",
			plainTextEmailHtml(body),
		], {
			commands: DRAFT_WRITE_COMMANDS,
			input: body,
			timeout: 180_000,
		});
		return {
			draftId: providerId(parsed?.draftId, "draft ID"),
			messageId: providerId(parsed?.message?.id, "draft message ID"),
			threadId: providerId(parsed?.threadId ?? parsed?.message?.threadId, "draft thread ID"),
		};
	}

	async updateDraft(draftId, { to, cc = [], subject, body, replyToMessageId }) {
		const toAddresses = Array.isArray(to) ? to : [to];
		const parsed = await this.json([
			"gmail",
			"drafts",
			"update",
			"--account",
			this.account,
			draftId,
			"--to",
			toAddresses.join(","),
			...(cc.length > 0 ? ["--cc", cc.join(",")] : []),
			"--subject",
			subject,
			...(replyToMessageId ? ["--reply-to-message-id", replyToMessageId] : []),
			"--body-file",
			"-",
			"--body-html",
			plainTextEmailHtml(body),
		], {
			commands: DRAFT_WRITE_COMMANDS,
			input: body,
			timeout: 180_000,
		});
		return {
			draftId: providerId(parsed?.draftId, "draft ID"),
			messageId: providerId(parsed?.message?.id, "draft message ID"),
			threadId: providerId(parsed?.threadId ?? parsed?.message?.threadId, "draft thread ID"),
		};
	}

	async getDraft(draftId) {
		const parsed = await this.json([
			"gmail",
			"drafts",
			"get",
			"--account",
			this.account,
			draftId,
		]);
		return draftMetadata(parsed);
	}

	async deleteDraft(draftId) {
		await this.json([
			"--force",
			"gmail",
			"drafts",
			"delete",
			"--account",
			this.account,
			draftId,
		], { commands: DRAFT_WRITE_COMMANDS });
	}

	async sendDraft(draftId) {
		const parsed = await this.json([
			"gmail",
			"drafts",
			"send",
			"--account",
			this.account,
			draftId,
		], {
			commands: DRAFT_SEND_COMMANDS,
			allowSend: true,
			timeout: 180_000,
		});
		return {
			messageId: providerId(parsed?.messageId ?? parsed?.id ?? parsed?.message?.id, "message ID"),
			threadId: providerId(parsed?.threadId ?? parsed?.message?.threadId, "thread ID"),
		};
	}

	async sendThreadReply(threadId, subject, body) {
		const parsed = await this.json([
			"gmail",
			"send",
			"--account",
			this.account,
			"--thread-id",
			threadId,
			"--reply-all",
			"--subject",
			subject,
			"--quote",
			"--body-file",
			"-",
			"--body-html",
			plainTextEmailHtml(body),
		], {
			commands: DIRECT_SEND_COMMANDS,
			allowSend: true,
			input: body,
			timeout: 180_000,
		});
		const messageId = clean(parsed?.messageId ?? parsed?.id ?? parsed?.message?.id, 256);
		if (!messageId) throw new Error("gog send response omitted message ID");
		return { messageId };
	}
}
