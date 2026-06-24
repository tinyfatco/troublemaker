/**
 * MCP Adapter — exposes agent tools over MCP Streamable HTTP.
 *
 * Runs inside the container on the gateway's shared HTTP port (3002).
 * Auth is handled by crawdad-cf before proxying here.
 *
 * Uses the Node.js StreamableHTTPServerTransport (wraps Web Standard
 * transport internally via @hono/node-server).
 */

import { exec as execCb } from "child_process";
import { appendFileSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { basename, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as log from "../log.js";
import { appendAwarenessLine } from "../awareness.js";
import type { ChannelStore } from "../store.js";
import { collectChannelsFromLog, collectPhoneConversations, collectSlackThreads, formatChannelTable } from "../tools/list-channels.js";
import { resolveMessageTarget } from "../tools/send-message.js";
import { collectThreadMessages, formatThreadTranscript } from "../tools/read-thread.js";
import { collectEmailThreadListings } from "../adapters/email/thread-ledger.js";
import type {
	ChannelInfo,
	MomContext,
	MomEvent,
	MomHandler,
	PlatformAdapter,
	UserInfo,
} from "./types.js";

interface PhoneGroupMessageAdapter extends PlatformAdapter {
	postMessageToRecipients(channel: string, text: string, recipients: string[], attachments?: Array<{ filePath: string; filename: string }>): Promise<string>;
}

export interface McpAdapterConfig {
	workingDir: string;
}

export class McpAdapter implements PlatformAdapter {
	readonly name = "mcp";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `You are responding via MCP (Model Context Protocol). Return plain text results. Be concise and precise.`;

	private workingDir: string;
	private handler!: MomHandler;
	private peerAdapters: PlatformAdapter[] = [];
	private awarenessDir?: string;

	constructor(config: McpAdapterConfig) {
		this.workingDir = config.workingDir;
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	/**
	 * Inject the full adapter list and awareness dir after construction.
	 * Called from main.ts once all adapters are built. Lets MCP tools route
	 * sends through other adapters and append to the agent's awareness stream.
	 */
	setAdapters(adapters: PlatformAdapter[], awarenessDir: string): void {
		this.peerAdapters = adapters;
		this.awarenessDir = awarenessDir;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("McpAdapter: handler not set. Call setHandler() before start().");
		log.logInfo("MCP adapter ready");
	}

	async stop(): Promise<void> {}

	/**
	 * Handle inbound MCP request — called by Gateway for POST /mcp.
	 * Creates a fresh stateless MCP server per request.
	 */
	dispatch(req: IncomingMessage, res: ServerResponse): void {
		// VPS mode: verify X-Tools-Token header to prevent unauthenticated access
		// through the Cloudflare Tunnel. Without this, anyone who knows the tunnel
		// hostname can execute arbitrary commands.
		const requiredToken = process.env.MOM_MCP_AUTH_TOKEN;
		if (requiredToken) {
			const provided = req.headers["x-tools-token"];
			if (provided !== requiredToken) {
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					jsonrpc: "2.0",
					error: { code: -32001, message: "Unauthorized" },
					id: null,
				}));
				return;
			}
		}

		this.handleMcpRequest(req, res).catch((err) => {
			log.logWarning("MCP request error", err instanceof Error ? err.message : String(err));
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
			}
			res.end(JSON.stringify({
				jsonrpc: "2.0",
				error: { code: -32603, message: "Internal error" },
				id: null,
			}));
		});
	}

	private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const server = new McpServer(
			{ name: "tinyfat-computer", version: "1.0.0" },
			{ capabilities: { tools: {} } },
		);

		this.registerTools(server);

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // Stateless
			enableJsonResponse: true,
		});

		await server.connect(transport);

		try {
			await transport.handleRequest(req, res);
		} finally {
			await transport.close().catch(() => {});
			await server.close().catch(() => {});
		}
	}

	private exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
		return new Promise((resolve) => {
			execCb(command, {
				cwd: this.workingDir,
				timeout: 120_000,
				maxBuffer: 10 * 1024 * 1024,
				encoding: "utf-8",
			}, (err, stdout, stderr) => {
				if (err) {
					const e = err as { code?: number; killed?: boolean };
					resolve({
						stdout: (stdout as string) || "",
						stderr: (stderr as string) || err.message || "Command failed",
						code: e.code ?? 1,
					});
				} else {
					resolve({ stdout: stdout as string, stderr: stderr as string, code: 0 });
				}
			});
		});
	}

	private shellEscape(s: string): string {
		return `'${s.replace(/'/g, "'\\''")}'`;
	}

	private registerTools(server: McpServer): void {
		// ── execute ──────────────────────────────────────────────────────
		server.registerTool(
			"bash",
			{
				description: "Run a shell command on your TinyFat computer. Returns stdout/stderr.",
				inputSchema: { command: z.string().describe("Shell command to execute") },
			},
			async ({ command }: { command: string }) => {
				log.logInfo(`[mcp] bash: ${command.substring(0, 100)}`);
				const result = await this.exec(command);

				this.logToFile({
					date: new Date().toISOString(),
					channel: "mcp",
					type: "tool_call",
					tool: "bash",
					command,
					success: result.code === 0,
					...(result.code !== 0 && { exitCode: result.code }),
				});

				const output = result.code === 0
					? result.stdout || "(no output)"
					: [result.stdout, result.stderr].filter(Boolean).join("\n");

				return {
					content: [{ type: "text" as const, text: output }],
					...(result.code !== 0 && { isError: true }),
				};
			},
		);

		// ── read ─────────────────────────────────────────────────────────
		server.registerTool(
			"read",
			{
				description: "Read the contents of a file. Use offset/limit for large files.",
				inputSchema: {
					path: z.string().describe("Path to the file to read (relative or absolute)"),
					offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
					limit: z.number().optional().describe("Maximum number of lines to read"),
				},
			},
			async ({ path, offset, limit }: { path: string; offset?: number; limit?: number }) => {
				log.logInfo(`[mcp] read: ${path}`);
				const escaped = this.shellEscape(path);

				// Get total lines
				const countResult = await this.exec(`wc -l < ${escaped}`);
				if (countResult.code !== 0) {
					return { content: [{ type: "text" as const, text: countResult.stderr }], isError: true };
				}
				const totalLines = parseInt(countResult.stdout.trim(), 10) + 1;

				const startLine = offset ? Math.max(1, offset) : 1;
				if (startLine > totalLines) {
					return { content: [{ type: "text" as const, text: `Offset ${offset} is beyond end of file (${totalLines} lines)` }], isError: true };
				}

				let cmd = startLine === 1 ? `cat ${escaped}` : `tail -n +${startLine} ${escaped}`;
				if (limit) {
					cmd += ` | head -n ${limit}`;
				}

				const result = await this.exec(cmd);
				if (result.code !== 0) {
					return { content: [{ type: "text" as const, text: result.stderr }], isError: true };
				}

				const readLines = result.stdout.split("\n").length;
				const endLine = startLine + readLines - 1;
				let text = result.stdout;
				if (endLine < totalLines) {
					text += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue]`;
				}

				this.logToFile({ date: new Date().toISOString(), channel: "mcp", type: "tool_call", tool: "read", path, success: true });
				return { content: [{ type: "text" as const, text }] };
			},
		);

		// ── write ────────────────────────────────────────────────────────
		server.registerTool(
			"write",
			{
				description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
				inputSchema: {
					path: z.string().describe("Path to the file to write (relative or absolute)"),
					content: z.string().describe("Content to write to the file"),
				},
			},
			async ({ path, content }: { path: string; content: string }) => {
				log.logInfo(`[mcp] write: ${path} (${content.length} bytes)`);
				const escaped = this.shellEscape(path);
				const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";

				const cmd = `mkdir -p ${this.shellEscape(dir)} && printf '%s' ${this.shellEscape(content)} > ${escaped}`;
				const result = await this.exec(cmd);

				this.logToFile({ date: new Date().toISOString(), channel: "mcp", type: "tool_call", tool: "write", path, success: result.code === 0 });

				if (result.code !== 0) {
					return { content: [{ type: "text" as const, text: result.stderr }], isError: true };
				}
				return { content: [{ type: "text" as const, text: `Wrote ${content.length} bytes to ${path}` }] };
			},
		);

		// ── edit ─────────────────────────────────────────────────────────
		server.registerTool(
			"edit",
			{
				description: "Edit a file by replacing exact text. The old_text must match exactly one occurrence (including whitespace).",
				inputSchema: {
					path: z.string().describe("Path to the file to edit (relative or absolute)"),
					old_text: z.string().describe("Exact text to find and replace (must match exactly)"),
					new_text: z.string().describe("New text to replace the old text with"),
				},
			},
			async ({ path, old_text, new_text }: { path: string; old_text: string; new_text: string }) => {
				log.logInfo(`[mcp] edit: ${path}`);
				const escaped = this.shellEscape(path);

				// Read file
				const readResult = await this.exec(`cat ${escaped}`);
				if (readResult.code !== 0) {
					return { content: [{ type: "text" as const, text: `File not found: ${path}` }], isError: true };
				}

				const fileContent = readResult.stdout;

				if (!fileContent.includes(old_text)) {
					return { content: [{ type: "text" as const, text: `Could not find the exact text in ${path}. Must match exactly including whitespace.` }], isError: true };
				}

				const occurrences = fileContent.split(old_text).length - 1;
				if (occurrences > 1) {
					return { content: [{ type: "text" as const, text: `Found ${occurrences} occurrences in ${path}. Must be unique — provide more context.` }], isError: true };
				}

				const idx = fileContent.indexOf(old_text);
				const newContent = fileContent.substring(0, idx) + new_text + fileContent.substring(idx + old_text.length);

				const writeResult = await this.exec(`printf '%s' ${this.shellEscape(newContent)} > ${escaped}`);
				if (writeResult.code !== 0) {
					return { content: [{ type: "text" as const, text: writeResult.stderr }], isError: true };
				}

				this.logToFile({ date: new Date().toISOString(), channel: "mcp", type: "tool_call", tool: "edit", path, success: true });
				return { content: [{ type: "text" as const, text: `Replaced ${old_text.length} chars with ${new_text.length} chars in ${path}` }] };
			},
		);

		// ── send_message ─────────────────────────────────────────────────
		// Lets the MCP client send a message on any of the agent's connected
		// channels (Telegram, Slack, Discord, Email, phone) using the agent's bot
		// credentials. Appears in the agent's awareness stream as a system
		// notification but does NOT trigger a runner wake.
		server.registerTool(
			"send_message",
			{
				description:
					"Send a message on the agent's behalf to one of its connected channels " +
					"(Telegram, Slack, Discord, Email, SMS/iMessage). The required target determines routing: " +
					"discord:<17-20 digit ID> or raw 17-20 digit snowflake → Discord, shorter numeric → Telegram, " +
					"C/D/G prefix → Slack, slack:<channel>:<thread_ts> → Slack thread, email-thread:<id> → existing Email thread, email-{address} → Email, phone-{hash} → SMS/iMessage conversation. The send appears in the agent's " +
					"awareness stream but does NOT trigger a run. Use list_channels to discover valid IDs.",
				inputSchema: {
					target: z.string().describe("Required target (discord:<snowflake> for Discord, numeric for Telegram, C/D/G-prefixed for Slack, slack:<channel>:<thread_ts> for Slack threads, email-thread:<id> for existing Email threads, email-{addr} for Email, phone-{hash} for SMS/iMessage conversations)"),
					text: z.string().describe("Message text to send"),
					subject: z.string().optional().describe("Subject line (email only)"),
					attachments: z.array(z.string()).optional().describe("Absolute file paths to attach (email only)"),
					recipients: z.array(z.string()).optional().describe("Phone only: additional E.164 numbers to persist on this phone target and include in the MMS group."),
				},
			},
			async ({ target, text, subject, attachments, recipients }: { target: string; text: string; subject?: string; attachments?: string[]; recipients?: string[] }) => {
				log.logInfo(`[mcp] send_message: ${target} (${text.length} chars)`);

				if (!target.trim()) {
					return {
						content: [{ type: "text" as const, text: "send_message requires a target. Give me a destination such as a channel ID, email-thread:<id>, email-user@example.com, phone-..., or slack:<channel>:<thread_ts>." }],
						isError: true,
					};
				}

				const resolved = resolveMessageTarget(target.trim(), this.peerAdapters);
				if (!resolved) {
					return {
						content: [{ type: "text" as const, text: `No adapter found for target "${target}". Valid patterns: discord:<17-20 digit ID> or raw 17-20 digit snowflake (Discord), shorter numeric (Telegram), C/D/G prefix (Slack), slack:<channel>:<thread_ts> (Slack thread), email-thread:<id> (existing Email thread), email-{address} (Email), phone-{hash} (SMS/iMessage).` }],
						isError: true,
					};
				}
				const { adapter } = resolved;

				try {
					const attachmentObjects = attachments?.map((filePath) => ({
						filePath,
						filename: basename(filePath),
					}));
					const phoneRecipients = normalizePhoneRecipients(recipients);
					if (phoneRecipients.length > 0 && adapter.name !== "phone") {
						throw new Error("send_message recipients are only supported for phone/SMS/MMS targets.");
					}

					const ts = resolved.threadTs
						? await adapter.postInThread(resolved.channel, resolved.threadTs, text)
						: phoneRecipients.length > 0
							? await phoneGroupAdapter(adapter).postMessageToRecipients(resolved.channel, text, phoneRecipients, attachmentObjects)
							: await adapter.postMessage(resolved.channel, text, attachmentObjects, subject);
					adapter.logBotResponse(resolved.channel, text, ts, { threadTs: resolved.threadTs });

					// Append to awareness so the agent sees it on its next run.
					// Does not enqueue a MomEvent — no runner wake.
					if (this.awarenessDir) {
						const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
						appendAwarenessLine(
							this.awarenessDir,
							`[mcp] sent to ${adapter.name}:${resolved.channel}: ${preview}`,
						);
					}

					this.logToFile({
						date: new Date().toISOString(),
						channel: "mcp",
						type: "tool_call",
						tool: "send_message",
						target_adapter: adapter.name,
						target_channel: resolved.channel,
						target_thread_ts: resolved.threadTs,
						success: true,
					});

					const attInfo = attachmentObjects?.length ? ` with ${attachmentObjects.length} attachment(s)` : "";
					const recipientInfo = phoneRecipients.length ? ` to ${phoneRecipients.length + 1} phone participant(s)` : "";
					const threadInfo = resolved.threadTs ? ` thread ${resolved.threadTs}` : "";
					return {
						content: [{ type: "text" as const, text: `Sent to ${adapter.name}:${resolved.channel}${threadInfo}${attInfo}${recipientInfo} (ts=${ts})` }],
					};
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning(`[mcp] send_message failed for ${adapter.name}:${resolved.channel}`, errMsg);
					this.logToFile({
						date: new Date().toISOString(),
						channel: "mcp",
						type: "tool_call",
						tool: "send_message",
						target_adapter: adapter.name,
						target_channel: resolved.channel,
						target_thread_ts: resolved.threadTs,
						success: false,
						error: errMsg,
					});
					return {
						content: [{ type: "text" as const, text: `Failed to send: ${errMsg}` }],
						isError: true,
					};
				}
			},
		);

		// ── list_channels ────────────────────────────────────────────────
		// Discovery helper for MCP clients. Reads log.jsonl so it covers any
		// channel the agent has ever interacted with, regardless of adapter or
		// container lifetime.
		server.registerTool(
			"list_channels",
			{
				description:
					"List every channel the agent has ever sent or received a message on, plus recent Slack, email, and phone conversation targets. Uses Slack API " +
					"for live Slack thread discovery when available, with log.jsonl/ledgers as durable fallback for all adapters. " +
					"Returns markdown tables of channels and concrete conversation send targets. Use slack:<channel>:<thread_ts>, email-thread:<id>, or phone-... targets returned here with send_message when choosing among conversations.",
				inputSchema: {},
			},
			async () => {
				const channels = collectChannelsFromLog(this.workingDir);
				const slackThreads = await collectSlackThreads(this.workingDir, this.peerAdapters);
				const emailThreads = collectEmailThreadListings(this.workingDir);
				const phoneConversations = collectPhoneConversations(this.workingDir);
				log.logInfo(`[mcp] list_channels: ${channels.length} channels, ${slackThreads.length} slack threads, ${emailThreads.length} email threads, ${phoneConversations.length} phone conversations`);
				this.logToFile({
					date: new Date().toISOString(),
					channel: "mcp",
					type: "tool_call",
					tool: "list_channels",
					count: channels.length,
					thread_count: slackThreads.length,
					email_thread_count: emailThreads.length,
					phone_conversation_count: phoneConversations.length,
					success: true,
				});
				return { content: [{ type: "text" as const, text: formatChannelTable(channels, slackThreads, emailThreads, phoneConversations) }] };
			},
		);

		// ── read_thread ─────────────────────────────────────────────────
		server.registerTool(
			"read_thread",
			{
				description:
					"Read the transcript for a conversation target returned by list_channels, " +
					"such as slack:<channel>:<thread_ts>, email-thread:<id>, or phone-.... Falls back to log.jsonl/ledgers when live API access is unavailable. " +
					"Use this to distinguish similar conversations before send_message.",
				inputSchema: {
					target: z.string().describe("Conversation target, e.g. slack:C0AN1GL51K7:1779777014.658729, email-thread:0123abcd..., or phone-..."),
					limit: z.number().optional().describe("Maximum messages to return, default 40, max 100"),
				},
			},
			async ({ target, limit }) => {
				const result = await collectThreadMessages(this.workingDir, target, this.peerAdapters, limit);
				if (!result) {
					return { content: [{ type: "text" as const, text: `Invalid conversation target "${target}". Expected slack:<channel>:<thread_ts>, email-thread:<id>, or phone-....` }], isError: true };
				}
				log.logInfo(`[mcp] read_thread: ${target} (${result.messages.length} messages, source=${result.source})`);
				this.logToFile({
					date: new Date().toISOString(),
					channel: "mcp",
					type: "tool_call",
					tool: "read_thread",
					target,
					count: result.messages.length,
					source: result.source,
					success: true,
				});
				return { content: [{ type: "text" as const, text: formatThreadTranscript(result) }] };
			},
		);
	}

	// ==========================================================================
	// PlatformAdapter — message operations (no-ops for MCP)
	// ==========================================================================

	async postMessage(_channel: string, _text: string): Promise<string> {
		return String(Date.now());
	}

	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string): Promise<void> {}

	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		return String(Date.now());
	}

	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	// ==========================================================================
	// Logging
	// ==========================================================================

	logToFile(entry: object): void {
		try {
			appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
		} catch {
			// R2 FUSE mount may have dropped — don't let logging failures kill tool responses
		}
	}

	logBotResponse(_channel: string, _text: string, _ts: string): void {}

	// ==========================================================================
	// Metadata (MCP has no channels/users)
	// ==========================================================================

	getUser(_userId: string): UserInfo | undefined { return undefined; }
	getChannel(_channelId: string): ChannelInfo | undefined { return undefined; }
	getAllUsers(): UserInfo[] { return []; }
	getAllChannels(): ChannelInfo[] { return []; }
	enqueueEvent(_event: MomEvent): boolean { return false; }

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: "mcp-client",
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: undefined,
			channels: [],
			users: [],
			respond: async () => {},
			sendFinalResponse: async () => {},
			respondInThread: async () => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async () => {},
			deleteMessage: async () => {},
			restartWorking: async () => {},
		};
	}
}

function normalizePhoneRecipients(recipients: unknown): string[] {
	if (!Array.isArray(recipients)) return [];
	return Array.from(new Set(recipients
		.filter((recipient): recipient is string => typeof recipient === "string")
		.map((recipient) => recipient.trim())
		.filter(Boolean)));
}

function phoneGroupAdapter(adapter: PlatformAdapter): PhoneGroupMessageAdapter {
	const maybe = adapter as Partial<PhoneGroupMessageAdapter>;
	if (typeof maybe.postMessageToRecipients !== "function") {
		throw new Error("Phone adapter does not support explicit MMS recipients.");
	}
	return maybe as PhoneGroupMessageAdapter;
}
