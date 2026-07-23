import { spawnSync } from "node:child_process";

const READ_COMMANDS = "gmail.messages.search,gmail.get,gmail.thread.get,gmail.mark-read";
const SEND_COMMANDS = "gmail.send";

function clean(value, maximum) {
	return typeof value === "string" ? value.replaceAll("\u0000", "").trim().slice(0, maximum) : "";
}

export class GogGmail {
	constructor(config, environment = process.env) {
		this.account = config.account;
		this.gogPath = config.gogPath;
		this.environment = environment;
	}

	json(args, { timeout = 120_000, write = false, input } = {}) {
		const result = spawnSync(this.gogPath, [
			"--json",
			"--no-input",
			...(write ? [] : ["--gmail-no-send"]),
			`--enable-commands=${write ? SEND_COMMANDS : READ_COMMANDS}`,
			...args,
		], {
			encoding: "utf8",
			input,
			maxBuffer: 32 * 1024 * 1024,
			timeout,
			env: this.environment,
		});
		if (result.error) throw new Error(`gog command failed: ${result.error.message}`);
		if (result.status !== 0) {
			throw new Error(`gog command exited ${result.status}: ${String(result.stderr || "").trim().slice(0, 1000)}`);
		}
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new Error("gog command returned invalid JSON");
		}
	}

	searchMessages(query) {
		const parsed = this.json([
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
			if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(threadId)) return null;
			return { id, threadId };
		}).filter(Boolean);
	}

	getMetadata(messageId) {
		const parsed = this.json([
			"gmail",
			"get",
			"--account",
			this.account,
			messageId,
			"--format",
			"metadata",
			"--headers",
			"From,To,Cc,Subject,Auto-Submitted,Precedence,X-Auto-Response-Suppress,Return-Path,List-Id",
		]);
		const headers = parsed?.headers;
		if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
			throw new Error("message metadata omitted headers");
		}
		return Object.fromEntries(
			Object.entries(headers).map(([key, value]) => [key.toLowerCase(), clean(value, 4000)]),
		);
	}

	getThread(threadId) {
		const parsed = this.json([
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
				subject: clean(headers.subject, 2000),
				body: typeof message?.body === "string" ? message.body.replaceAll("\u0000", "") : "",
			};
		});
	}

	markRead(messageId) {
		this.json(["gmail", "mark-read", "--account", this.account, messageId]);
	}

	sendThreadReply(threadId, subject, body) {
		const parsed = this.json([
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
		], {
			write: true,
			input: body,
			timeout: 180_000,
		});
		const messageId = clean(parsed?.messageId ?? parsed?.id ?? parsed?.message?.id, 256);
		if (!messageId) throw new Error("gog send response omitted message ID");
		return { messageId };
	}
}
