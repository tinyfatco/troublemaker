import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { currentHostDeliveryScope } from "../adapters/host-delivery-scope.js";

interface GmailToolOptions {
	baseUrl?: string;
	token?: string;
	contextId?: string;
	fetch?: typeof fetch;
}

interface GmailDraftInput {
	body?: string;
	draft_id?: string;
	thread_id?: string;
	to?: string;
	subject?: string;
}

function hostBase(options: GmailToolOptions): string {
	return (options.baseUrl || process.env.TROUBLEMAKER_HOSTD_URL || "").replace(/\/+$/, "");
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text: text || "(empty response)" }], details: undefined };
}

function gmailIdempotencyKey(action: "draft" | "send", toolCallId: string): string {
	if (typeof toolCallId !== "string" || !toolCallId || toolCallId.length > 4096) {
		throw new Error("Gmail tools require a bounded provider tool-call ID.");
	}
	const digest = createHash("sha256").update(toolCallId, "utf8").digest("hex");
	return `gmail_${action}:${digest}`;
}

async function gmailRequest(
	options: GmailToolOptions,
	path: string,
	body: Record<string, unknown>,
): Promise<string> {
	const baseUrl = hostBase(options);
	const token = options.token || process.env.MOM_EMAIL_TOOLS_TOKEN;
	const contextId = options.contextId || process.env.TROUBLEMAKER_CONTEXT_ID;
	if (!baseUrl || !token || !contextId) {
		throw new Error("Gmail tools require the host URL, context, and capability.");
	}
	const request = options.fetch || fetch;
	const response = await request(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			"authorization": `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ context_id: contextId, ...body }),
	});
	const text = await response.text();
	if (!response.ok) {
		let reason = text;
		try {
			const parsed = JSON.parse(text) as { error?: unknown };
			if (typeof parsed.error === "string") reason = parsed.error;
		} catch {
			// Keep the bounded host response as the error reason.
		}
		throw new Error(`Gmail request failed (${response.status}): ${reason.slice(0, 300)}`);
	}
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		throw new Error("Gmail host returned invalid JSON.");
	}
}

export function createGmailToolDefinitions(options: GmailToolOptions = {}): ToolDefinition<any>[] {
	const baseUrl = hostBase(options);
	const token = options.token || process.env.MOM_EMAIL_TOOLS_TOKEN;
	const contextId = options.contextId || process.env.TROUBLEMAKER_CONTEXT_ID;
	if (!baseUrl || !token || !contextId) return [];

	return [
		defineTool({
			name: "gmail_search",
			label: "gmail_search",
			description: "Search Gmail threads available to the current customer context. The host narrows results to the verified contact and returns compact thread metadata.",
			parameters: Type.Object({
				query: Type.String({ description: "Gmail search query, for example newer_than:30d invoice.", minLength: 1, maxLength: 500 }),
				limit: Type.Optional(Type.Integer({ description: "Maximum results. Defaults to 10 and cannot exceed 20.", minimum: 1, maximum: 20 })),
			}),
			execute: async (_id: string, input: unknown) => {
				const body = input as { query?: string; limit?: number };
				return textResult(await gmailRequest(options, "/v1/gmail/search", {
					query: body.query,
					limit: body.limit,
				}));
			},
		}),
		defineTool({
			name: "gmail_read",
			label: "gmail_read",
			description: "Read one Gmail thread available to the current customer context. Content is sanitized by the host before it is returned.",
			parameters: Type.Object({
				thread_id: Type.String({ description: "Gmail thread ID returned by gmail_search or the current inbound thread.", minLength: 1, maxLength: 256 }),
			}),
			execute: async (_id: string, input: unknown) => {
				const body = input as { thread_id?: string };
				return textResult(await gmailRequest(options, "/v1/gmail/read", {
					thread_id: body.thread_id,
				}));
			},
		}),
		defineTool({
			name: "gmail_draft",
			label: "gmail_draft",
			description: "Create or update an unsent Gmail draft. Create with exactly one addressing mode: thread_id for a reply, or to plus subject for a new message. Update with draft_id and body only; recipient and thread binding cannot change. This tool never sends email.",
			parameters: Type.Object({
				body: Type.String({ description: "Plain-text draft body.", minLength: 1, maxLength: 100000 }),
				draft_id: Type.Optional(Type.String({ description: "Existing draft ID to update. When present, omit thread_id, to, and subject.", minLength: 1, maxLength: 256 })),
				thread_id: Type.Optional(Type.String({ description: "Existing Gmail thread to reply to.", minLength: 1, maxLength: 256 })),
				to: Type.Optional(Type.String({ description: "Exact verified contact for a new message. One address only.", minLength: 3, maxLength: 320 })),
				subject: Type.Optional(Type.String({ description: "Subject for a new message. Reply subjects are derived by the host.", minLength: 1, maxLength: 998 })),
			}),
			execute: async (id: string, input: unknown) => {
				if (currentHostDeliveryScope()?.source === "mcp-operator") {
					throw new Error("Gmail drafts are unavailable during an MCP relationship turn; user-facing action is restricted to the exact Hostd-bound reply target.");
				}
				const body = input as GmailDraftInput;
				return textResult(await gmailRequest(options, "/v1/gmail/draft", {
					idempotency_key: gmailIdempotencyKey("draft", id),
					body: body.body,
					draft_id: body.draft_id,
					thread_id: body.thread_id,
					to: body.to,
					subject: body.subject,
				}));
			},
		}),
		defineTool({
			name: "gmail_send",
			label: "gmail_send",
			description: "Send one previously saved Gmail draft within the current verified context. Accepts only a draft ID; addressing and content cannot be supplied or changed here. Returns durable Gmail message and thread IDs.",
			parameters: Type.Object({
				draft_id: Type.String({ description: "Draft ID returned by gmail_draft.", minLength: 1, maxLength: 256 }),
			}),
			execute: async (id: string, input: unknown) => {
				if (currentHostDeliveryScope()?.source === "mcp-operator") {
					throw new Error("Gmail send is unavailable during an MCP relationship turn; user-facing action is restricted to the exact Hostd-bound reply target.");
				}
				const body = input as { draft_id?: string };
				return textResult(await gmailRequest(options, "/v1/gmail/send", {
					idempotency_key: gmailIdempotencyKey("send", id),
					draft_id: body.draft_id,
				}));
			},
		}),
	];
}
