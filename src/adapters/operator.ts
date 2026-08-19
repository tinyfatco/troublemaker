/**
 * OperatorAdapter — headless inbound adapter for the Agency MCP.
 *
 * This is the container-side twin of the Agency MCP dispatcher on crawdad-cf.
 * The worker authenticates operator requests and proxies them to five
 * internal HTTP endpoints on the container gateway (port 3002):
 *
 *   GET  /operator/read       — proxies to /awareness/backlog
 *   GET  /operator/describe   — returns current settings snapshot + HEARTBEAT.md
 *   POST /operator/message    — appends awareness line, triggers heartbeat-style run
 *   POST /operator/assign     — writes BRIEF.md, appends awareness, triggers run
 *   POST /operator/configure  — edits settings.json or workspace files for
 *                               whitelisted targets (spontaneity.*, verbose[.*],
 *                               model, thinking_level, heartbeat.checklist)
 *
 * Auth: a context-scoped bearer capability is required at the container
 * boundary even when an upstream proxy also authenticates the operator.
 *
 * Awareness semantics: operator writes a durable entry to
 * `awareness/context.jsonl` tagged with channel `operator:control`, role
 * `user`, speaker `operator`, so the entry is visible to `read` and the
 * runner picks it up as part of the transcript. The triggered run gets a
 * short prompt telling the agent the operator channel has new content.
 *
 * Steering: if a run is active when an operator message arrives, we steer
 * into the current run instead of queueing. Assign triggers a fresh
 * heartbeat-style run. Configure writes are control-plane changes and only
 * become awareness/context for the next natural turn.
 *
 * Shape: modeled after HeartbeatAdapter (headless, no outbound). No post/
 * update/delete methods do anything — replies happen via the agent's
 * send_message tool routing to whatever real adapter the operator
 * is watching from.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { randomUUID, timingSafeEqual } from "crypto";
import { join } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import { ATTENTION_QUEUE_DIR } from "../attention/paths.js";
import { MomSettingsManager, type MomVerboseSettings, type VerbosityLevel } from "../context.js";
import { syncHeartbeatFromSpontaneity } from "../heartbeat-schedule.js";
import type { ChannelStore } from "../store.js";
import type {
	ChannelInfo,
	MomContext,
	MomEvent,
	MomHandler,
	PlatformAdapter,
	UserInfo,
} from "./types.js";
import { withHostReceipt } from "./host-receipt.js";
import { withHostDeliveryScope } from "./host-delivery-scope.js";
import { findModel, listModels } from "../model-config.js";
import {
	DEFAULT_REALTIME_VOICE,
	REALTIME_VOICE_OPTIONS,
	normalizeRealtimeVoiceName,
	realtimeVoiceDescription,
} from "../realtime-voices.js";

export const OPERATOR_CHANNEL_ID = "operator";
const OPERATOR_CHANNEL_LABEL = "operator:control";
const OPERATOR_USER = "operator";
const MAXIMUM_OPERATOR_BODY_BYTES = 1024 * 1024;

/**
 * Flat simple targets — edited as single JSON keys in `settings.json`.
 * (Verbosity and spontaneity go through dedicated branches below because
 * they have nested shapes or need a live reschedule. model and
 * thinking_level also get dedicated branches for validation/canonical keys.)
 */
const SIMPLE_SETTINGS_TARGETS = new Set<string>(["mcpServers"]);

/** Accepted thinking_level values. Matches agent.ts resolveThinkingLevel. */
const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Spontaneity leaf targets accepted via `configure`. */
const SPONTANEITY_LEAF_TARGETS = new Set([
	"spontaneity",
	"spontaneity.enabled",
	"spontaneity.level",
	"spontaneity.intervalMinutes",
	"spontaneity.spontaneity",
	"spontaneity.quietHours",
	"spontaneity.quietHours.start",
	"spontaneity.quietHours.end",
	"spontaneity.timezone",
]);

/** Special file-tier target: writes `/data/HEARTBEAT.md`. */
const HEARTBEAT_CHECKLIST_TARGET = "heartbeat.checklist";
const REALTIME_VOICE_TARGET = "realtime_voice";

/**
 * Legacy aliases advertised by older Agency MCP docstrings. Accepted with a
 * remap so existing operators don't hard-break, but the canonical targets
 * are the `spontaneity.*` forms above.
 */
const LEGACY_ALIASES: Record<string, string> = {
	"heartbeat.interval": "spontaneity.intervalMinutes",
	"heartbeat.enabled": "spontaneity.enabled",
	"voice": REALTIME_VOICE_TARGET,
	"realtimeVoice": REALTIME_VOICE_TARGET,
	"realtime.voice": REALTIME_VOICE_TARGET,
};

/** Pattern match for nested verbose targets like `verbose.slack.C09...`. */
function isVerboseTarget(target: string): boolean {
	return target === "verbose" || target.startsWith("verbose.");
}

interface AssignBody {
	title: string;
	spec: string;
	rubric: string;
	skill_packs?: string[];
	deadline?: string;
}

interface MessageBody {
	text: string;
	deliveryId?: string;
	hostContextId?: string;
	hostReceipt?: unknown;
}

interface ConfigureBody {
	target: string;
	value: unknown;
}

function nowIso(): string {
	return new Date().toISOString();
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += bytes.byteLength;
		if (totalBytes > MAXIMUM_OPERATOR_BODY_BYTES) throw new Error("request_too_large");
		chunks.push(bytes);
	}
	const raw = Buffer.concat(chunks).toString("utf-8");
	if (!raw) return {} as T;
	return JSON.parse(raw) as T;
}

function matchesBearerToken(header: string | undefined, expected: string): boolean {
	const actual = Buffer.from(/^Bearer ([^\s]+)$/i.exec(header || "")?.[1] || "");
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: string, description?: string): void {
	sendJson(res, status, { error, error_description: description ?? error });
}

function sendBodyParseError(res: ServerResponse, error: unknown): void {
	const tooLarge = error instanceof Error && error.message === "request_too_large";
	sendError(
		res,
		tooLarge ? 413 : 400,
		tooLarge ? "request_too_large" : "invalid_request",
		tooLarge ? undefined : "Body must be JSON",
	);
}

export class OperatorAdapter implements PlatformAdapter {
	readonly name = "operator";
	readonly maxMessageLength = 100000;
	readonly formatInstructions = `## Operator Channel
You are receiving a message from the **operator channel**. Entries tagged \`operator\` in your awareness stream are principal instructions from the human or agent running your fleet — not user requests.

Treat operator messages with appropriate weight:
- A \`[operator message]\` is a direct instruction to you. Read it, decide, act.
- A \`[operator assigned brief: ...]\` entry means a new \`BRIEF.md\` has been written to your workspace. Read it and begin work.
- A \`[operator configured ...]\` entry means one of your settings changed. Usually you can just continue.

Replies to the operator happen through whatever channel you were already using with your principal (Telegram, Slack, Discord, email, etc.) via \`send_message\` with an explicit target. The operator channel itself has no outbound path.`;

	private workingDir: string;
	private inboundToken?: string;
	private relationshipInboundToken?: string;
	private hostContextId?: string;
	private hostdUrl?: string;
	private handler!: MomHandler;
	private queue: MomEvent[] = [];
	private processing = false;
	private completedRelationshipDeliveries = new Set<string>();
	private activeRelationshipDeliveries = new Set<string>();

	constructor(config: {
		workingDir: string;
		inboundToken?: string;
		relationshipInboundToken?: string;
		hostContextId?: string;
		hostdUrl?: string;
	}) {
		this.workingDir = config.workingDir;
		this.inboundToken = config.inboundToken;
		this.relationshipInboundToken = config.relationshipInboundToken;
		this.hostContextId = config.hostContextId;
		this.hostdUrl = config.hostdUrl;
		this.loadCompletedRelationshipDeliveries();
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		log.logInfo("Operator adapter ready");
	}

	async stop(): Promise<void> {}

	// ========================================================================
	// Awareness write — durable entry in context.jsonl tagged as operator input
	// ========================================================================

	/**
	 * Append a durable entry to awareness/context.jsonl so `read` sees it and
	 * the runner picks it up on the next turn. Schema mirrors the helper used
	 * by slash commands (commands.ts:logSystemAction) so the transcript shape
	 * stays consistent.
	 */
	private writeAwareness(text: string): void {
		const contextFile = join(this.workingDir, "awareness", "context.jsonl");
		const entry = {
			type: "message",
			id: randomUUID().substring(0, 8),
			parentId: null,
			timestamp: nowIso(),
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: `[${nowIso()}] [${OPERATOR_CHANNEL_LABEL}] [${OPERATOR_USER}]: ${text}`,
					},
				],
			},
		};
		try {
			appendFileSync(contextFile, JSON.stringify(entry) + "\n");
		} catch (err) {
			log.logWarning(
				"[operator] Failed to append awareness entry",
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// ========================================================================
	// Run trigger — steer if running, otherwise fire a fresh heartbeat-style run
	// ========================================================================

	private triggerRun(runPrompt: string): void {
		const event: MomEvent = {
			type: "dm",
			channel: OPERATOR_CHANNEL_ID,
			ts: String(Date.now()),
			user: OPERATOR_USER,
			text: runPrompt,
			attachments: [],
		};

		if (this.handler.isRunning(OPERATOR_CHANNEL_ID)) {
			// Already in the operator channel; steer into it.
			this.handler.handleSteer(event, this);
			return;
		}

		// If an unrelated channel is running, still steer into that run — the
		// operator is principal, and they should be able to break in.
		// handleSteer is a no-op unless a run is active, so we check first.
		const anyRunning = this.anyRunRunning();
		if (anyRunning) {
			this.handler.handleSteer(event, this);
			return;
		}

		this.enqueueEvent(event);
	}

	/**
	 * Best-effort check for any active run. The handler only exposes a
	 * channel-scoped isRunning, so we fall through to that for the operator
	 * channel and let handleSteer be a safe no-op if nothing is live.
	 */
	private anyRunRunning(): boolean {
		return this.handler.isRunning(OPERATOR_CHANNEL_ID);
	}

	// ========================================================================
	// HTTP dispatch — routed from the gateway
	// ========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const pathname = url.pathname;
		const relationshipMessage = pathname === "/operator/relationship-message";
		const expectedToken = relationshipMessage
			? this.relationshipInboundToken
			: this.inboundToken;
		if (!expectedToken) {
			sendError(res, 503, relationshipMessage
				? "relationship_operator_ingress_disabled"
				: "operator_ingress_disabled");
			return;
		}
		if (!matchesBearerToken(req.headers.authorization, expectedToken)) {
			sendError(res, 401, "unauthorized");
			return;
		}
		const method = req.method?.toUpperCase() ?? "GET";
		if (method === "POST") {
			const mediaType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
			if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
				sendError(res, 415, "json_required");
				return;
			}
		}

		(async () => {
			try {
				if (relationshipMessage && method === "POST") {
					return this.handleRelationshipMessage(req, res);
				}
				if (relationshipMessage) {
					return sendError(res, 405, "method_not_allowed");
				}
				if (pathname === "/operator/read" && method === "GET") {
					return this.handleRead(url, res);
				}
				if (pathname === "/operator/describe" && method === "GET") {
					return this.handleDescribe(res);
				}
				if (pathname === "/operator/message" && method === "POST") {
					return this.handleMessage(req, res);
				}
				if (pathname === "/operator/assign" && method === "POST") {
					return this.handleAssign(req, res);
				}
				if (pathname === "/operator/configure" && method === "POST") {
					return this.handleConfigure(req, res);
				}
				sendError(res, 404, "not_found", `No operator route for ${method} ${pathname}`);
			} catch (err) {
				log.logWarning(
					"[operator] dispatch error",
					err instanceof Error ? err.message : String(err),
				);
				const tooLarge = err instanceof Error && err.message === "request_too_large";
				sendError(res, tooLarge ? 413 : 500, tooLarge ? "request_too_large" : "internal_error");
			}
		})();
	}

	// ------------------------------------------------------------------------
	// /operator/read
	// ------------------------------------------------------------------------

	private handleRead(url: URL, res: ServerResponse): void {
		const contextFile = join(this.workingDir, "awareness", "context.jsonl");
		const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
		const before = parseInt(url.searchParams.get("before") || "0", 10) || 0;

		let allLines: string[] = [];
		try {
			if (existsSync(contextFile)) {
				allLines = readFileSync(contextFile, "utf-8").split("\n").filter(Boolean);
			}
		} catch (err) {
			log.logWarning(
				"[operator] read error",
				err instanceof Error ? err.message : String(err),
			);
			return sendError(res, 500, "read_failed");
		}

		const total = allLines.length;
		const endIndex = before > 0 ? Math.min(before, total) : total;
		const startIndex = Math.max(0, endIndex - limit);
		const slice = allLines.slice(startIndex, endIndex);

		sendJson(res, 200, { lines: slice, total, offset: startIndex });
	}

	// ------------------------------------------------------------------------
	// /operator/relationship-message
	// ------------------------------------------------------------------------

	private relationshipDeliveryPath(): string {
		return join(this.workingDir, "awareness", "relationship-operator-deliveries.jsonl");
	}

	private loadCompletedRelationshipDeliveries(): void {
		const path = this.relationshipDeliveryPath();
		if (!existsSync(path)) return;
		try {
			const ids = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-10_000);
			this.completedRelationshipDeliveries = new Set(ids);
		} catch (error) {
			log.logWarning(
				"[operator] Failed to load relationship delivery receipts",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private markRelationshipDeliveryCompleted(deliveryId: string): void {
		if (this.completedRelationshipDeliveries.has(deliveryId)) return;
		appendFileSync(this.relationshipDeliveryPath(), `${deliveryId}\n`, { mode: 0o600 });
		this.completedRelationshipDeliveries.add(deliveryId);
	}

	private async handleRelationshipMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: MessageBody;
		try {
			body = await readJsonBody<MessageBody>(req);
		} catch (error) {
			return sendBodyParseError(res, error);
		}
		let receiptUrl: URL | undefined;
		let expectedReceiptUrl: URL | undefined;
		try {
			receiptUrl = new URL((body.hostReceipt as { url?: unknown } | undefined)?.url as string);
			if (this.hostdUrl) {
				expectedReceiptUrl = new URL(
					`/v1/events/${encodeURIComponent(body.deliveryId || "")}/receipt`,
					this.hostdUrl,
				);
			}
		} catch {
			// The common validation below rejects an absent or malformed Hostd receipt.
		}
		const receipt = body.hostReceipt as {
			url?: unknown;
			token?: unknown;
			leaseToken?: unknown;
		} | undefined;
		if (
			!this.hostContextId
			|| !this.hostdUrl
			|| body.hostContextId !== this.hostContextId
			|| typeof body.deliveryId !== "string"
			|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.deliveryId)
			|| typeof body.text !== "string"
			|| !body.text.trim()
			|| body.text.length > 16_000
			|| !receiptUrl
			|| !expectedReceiptUrl
			|| receiptUrl.href !== expectedReceiptUrl.href
			|| typeof receipt?.token !== "string"
			|| !/^[A-Za-z0-9_-]{43}$/.test(receipt.token)
			|| typeof receipt?.leaseToken !== "string"
			|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.leaseToken)
		) {
			return sendError(res, 400, "invalid_relationship_delivery");
		}
		if (
			this.completedRelationshipDeliveries.has(body.deliveryId)
			|| this.activeRelationshipDeliveries.has(body.deliveryId)
		) {
			return sendJson(res, 202, {
				accepted: true,
				delivery_id: body.deliveryId,
				duplicate: true,
			});
		}
		if (this.handler.isRunning(OPERATOR_CHANNEL_ID)) {
			return sendError(res, 409, "relationship_operator_busy");
		}
		this.activeRelationshipDeliveries.add(body.deliveryId);
		sendJson(res, 202, {
			accepted: true,
			delivery_id: body.deliveryId,
		});
		void this.processRelationshipMessage(body)
			.catch((error) => {
				log.logWarning(
					"[operator] Relationship instruction failed",
					error instanceof Error ? error.message : String(error),
				);
			})
			.finally(() => this.activeRelationshipDeliveries.delete(body.deliveryId!));
	}

	private async processRelationshipMessage(body: MessageBody): Promise<void> {
		await withHostReceipt(body.hostReceipt, async () => {
			const deliveryId = body.deliveryId!;
			if (this.completedRelationshipDeliveries.has(deliveryId)) return;
			this.writeAwareness(`[relationship operator instruction] ${body.text.trim()}`);
			const event: MomEvent = {
				type: "dm",
				channel: OPERATOR_CHANNEL_ID,
				ts: String(Date.now()),
				user: OPERATOR_USER,
				text: "An authenticated MCP connection bound to this exact relationship sent an Operator instruction. Check the latest [relationship operator instruction] awareness entry, decide what is appropriate, and act only through this relationship's existing scoped capabilities.",
				attachments: [],
			};
			await withHostDeliveryScope({ source: "mcp-operator", eventId: deliveryId }, async () => {
				if (this.handler.isRunning(OPERATOR_CHANNEL_ID)) {
					throw new Error("relationship Operator became busy before delivery");
				}
				const result = await this.handler.handleEvent(event, this, true);
				if (result?.stopReason === "error" || result?.stopReason === "aborted") {
					throw new Error("relationship Operator run did not complete");
				}
			});
			this.markRelationshipDeliveryCompleted(deliveryId);
		}, { failureStatus: "uncertain" });
	}

	// ------------------------------------------------------------------------
	// /operator/message
	// ------------------------------------------------------------------------

	private async handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: MessageBody;
		try {
			body = await readJsonBody<MessageBody>(req);
		} catch (error) {
			return sendBodyParseError(res, error);
		}

		if (!body.text || typeof body.text !== "string") {
			return sendError(res, 400, "invalid_request", "text is required");
		}

		this.writeAwareness(`[operator message] ${body.text}`);
		this.triggerRun(
			`The operator just sent you a message through the operator channel. Check your awareness stream for the latest \`[operator message]\` entry and respond or act on it.`,
		);

		sendJson(res, 200, {
			delivered_at: nowIso(),
			channel: OPERATOR_CHANNEL_ID,
			will_steer: true,
		});
	}

	// ------------------------------------------------------------------------
	// /operator/assign
	// ------------------------------------------------------------------------

	private async handleAssign(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: AssignBody;
		try {
			body = await readJsonBody<AssignBody>(req);
		} catch (error) {
			return sendBodyParseError(res, error);
		}

		if (!body.title || !body.spec || !body.rubric) {
			return sendError(
				res,
				400,
				"invalid_request",
				"title, spec, and rubric are required",
			);
		}

		const briefPath = join(this.workingDir, "BRIEF.md");
		const briefMarkdown = this.renderBrief(body);
		try {
			writeFileSync(briefPath, briefMarkdown, "utf-8");
		} catch (err) {
			log.logWarning(
				"[operator] BRIEF.md write failed",
				err instanceof Error ? err.message : String(err),
			);
			return sendError(res, 500, "write_failed");
		}

		this.writeAwareness(
			`[operator assigned brief: ${body.title}] BRIEF.md has been written to your workspace root.`,
		);
		this.triggerRun(
			`The operator just assigned you a new brief titled "${body.title}". BRIEF.md has been written to your workspace root. Read it and begin work.`,
		);

		sendJson(res, 200, {
			accepted_at: nowIso(),
			brief_path: "BRIEF.md",
			title: body.title,
		});
	}

	private renderBrief(body: AssignBody): string {
		const lines: string[] = [];
		lines.push(`# ${body.title}`);
		lines.push("");
		lines.push(`_Assigned by operator at ${nowIso()}_`);
		lines.push("");
		lines.push("## Spec");
		lines.push(body.spec.trim());
		lines.push("");
		lines.push("## Rubric");
		lines.push(body.rubric.trim());
		if (body.skill_packs && body.skill_packs.length > 0) {
			lines.push("");
			lines.push("## Skill Packs");
			for (const pack of body.skill_packs) lines.push(`- ${pack}`);
		}
		if (body.deadline) {
			lines.push("");
			lines.push("## Deadline");
			lines.push(body.deadline);
		}
		lines.push("");
		return lines.join("\n");
	}

	// ------------------------------------------------------------------------
	// /operator/configure
	// ------------------------------------------------------------------------

	private async handleConfigure(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: ConfigureBody;
		try {
			body = await readJsonBody<ConfigureBody>(req);
		} catch (error) {
			return sendBodyParseError(res, error);
		}

		if (!body.target || typeof body.target !== "string") {
			return sendError(res, 400, "invalid_request", "target is required");
		}
		if (!("value" in body)) {
			return sendError(res, 400, "invalid_request", "value is required");
		}

		// Remap legacy aliases to their canonical form before dispatch.
		const originalTarget = body.target;
		const target = LEGACY_ALIASES[body.target] ?? body.target;

		// ── File tier: HEARTBEAT.md ─────────────────────────────────────────
		if (target === HEARTBEAT_CHECKLIST_TARGET) {
			return this.configureHeartbeatChecklist(originalTarget, body.value, res);
		}

		// ── Settings tier: verbosity, spontaneity, simple keys ──────────────
		if (isVerboseTarget(target)) {
			return this.configureVerbose(originalTarget, target, body.value, res);
		}
		if (
			target.startsWith("spontaneity.") ||
			target === "spontaneity" ||
			SPONTANEITY_LEAF_TARGETS.has(target)
		) {
			return this.configureSpontaneity(originalTarget, target, body.value, res);
		}
		if (target === "thinking_level") {
			return this.configureThinkingLevel(originalTarget, body.value, res);
		}
		if (target === "model") {
			return this.configureModel(originalTarget, body.value, res);
		}
		if (target === REALTIME_VOICE_TARGET) {
			return this.configureRealtimeVoice(originalTarget, body.value, res);
		}
		if (SIMPLE_SETTINGS_TARGETS.has(target)) {
			return this.configureSimpleSetting(originalTarget, target, body.value, res);
		}

		return sendError(
			res,
			400,
			"invalid_target",
			`Unknown target: ${body.target}. See /operator/describe for supported fields.`,
		);
	}

	// ------------------------------------------------------------------------
	// Configure helpers — one per tier
	// ------------------------------------------------------------------------

	/**
	 * Read settings.json from disk. Returns an empty object if the file is
	 * missing. Used by the raw-key helpers that can't go through
	 * MomSettingsManager (e.g. simple key edits, verbose nested writes).
	 */
	private loadSettingsRaw(): Record<string, unknown> | Response {
		const settingsPath = join(this.workingDir, "settings.json");
		try {
			if (!existsSync(settingsPath)) return {};
			return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		} catch (err) {
			log.logWarning(
				"[operator] settings.json read failed",
				err instanceof Error ? err.message : String(err),
			);
			return new Response(null); // sentinel; caller must handle
		}
	}

	private saveSettingsRaw(settings: Record<string, unknown>): boolean {
		const settingsPath = join(this.workingDir, "settings.json");
		try {
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
			return true;
		} catch (err) {
			log.logWarning(
				"[operator] settings.json write failed",
				err instanceof Error ? err.message : String(err),
			);
			return false;
		}
	}

	private writeConfiguredAwareness(
		originalTarget: string,
		value: unknown,
		previousValue: unknown,
	): boolean {
		if (settingsValueEquals(previousValue, value)) return false;
		this.writeAwareness(
			`[operator configured ${originalTarget} = ${JSON.stringify(value)}] (previously ${JSON.stringify(previousValue)})`,
		);
		return true;
	}

	private configureSimpleSetting(
		originalTarget: string,
		target: string,
		value: unknown,
		res: ServerResponse,
	): void {
		const settings = this.loadSettingsRaw();
		if (settings instanceof Response) return sendError(res, 500, "settings_read_failed");

		const previousValue = settings[target];
		settings[target] = value;

		if (!this.saveSettingsRaw(settings)) {
			return sendError(res, 500, "settings_write_failed");
		}

		const changed = this.writeConfiguredAwareness(originalTarget, value, previousValue);

		sendJson(res, 200, {
			edited: true,
			changed,
			target: originalTarget,
			tier: "container",
			previous_value: previousValue ?? null,
			new_value: value,
			applied_at: nowIso(),
			note: "Settings changes take effect on next wake.",
		});
	}

	private configureModel(
		originalTarget: string,
		value: unknown,
		res: ServerResponse,
	): void {
		if (typeof value !== "string" || !value.trim()) {
			return sendError(res, 400, "invalid_value", "model must be a non-empty string");
		}

		const match = findModel(value, this.workingDir);
		if (!match) {
			return sendError(
				res,
				400,
				"model_not_found",
				`Model not found: ${value}. Use /model list to see available models.`,
			);
		}

		const settings = this.loadSettingsRaw();
		if (settings instanceof Response) return sendError(res, 500, "settings_read_failed");

		const previousValue = settings.defaultProvider && settings.defaultModel
			? `${String(settings.defaultProvider)}/${String(settings.defaultModel)}`
			: settings.model ?? null;

		settings.defaultProvider = match.provider;
		settings.defaultModel = match.id;
		delete settings.model;

		if (!this.saveSettingsRaw(settings)) {
			return sendError(res, 500, "settings_write_failed");
		}

		const newValue = `${match.provider}/${match.id}`;
		const changed = this.writeConfiguredAwareness(originalTarget, newValue, previousValue);

		sendJson(res, 200, {
			edited: true,
			changed,
			target: originalTarget,
			tier: "container",
			previous_value: previousValue,
			new_value: newValue,
			applied_at: nowIso(),
			note: "Takes effect on next wake.",
		});
	}

	/**
	 * Dedicated thinking_level handler with validation. Writes to
	 * `thinking_level` (the canonical key read by agent.ts) and also
	 * syncs `defaultThinkingLevel` (used by MomSettingsManager) so
	 * describe and any other consumers stay consistent.
	 */
	private configureThinkingLevel(
		originalTarget: string,
		value: unknown,
		res: ServerResponse,
	): void {
		if (typeof value !== "string" || !(THINKING_LEVEL_VALUES as readonly string[]).includes(value)) {
			return sendError(
				res,
				400,
				"invalid_value",
				`thinking_level must be one of: ${THINKING_LEVEL_VALUES.join(", ")}`,
			);
		}

		const settings = this.loadSettingsRaw();
		if (settings instanceof Response) return sendError(res, 500, "settings_read_failed");

		const previousValue = settings.thinking_level ?? settings.defaultThinkingLevel ?? "off";
		settings.thinking_level = value;
		settings.defaultThinkingLevel = value;

		if (!this.saveSettingsRaw(settings)) {
			return sendError(res, 500, "settings_write_failed");
		}

		const changed = this.writeConfiguredAwareness(originalTarget, value, previousValue);

		sendJson(res, 200, {
			edited: true,
			changed,
			target: originalTarget,
			tier: "container",
			previous_value: previousValue,
			new_value: value,
			accepted_values: [...THINKING_LEVEL_VALUES],
			applied_at: nowIso(),
			note: "Takes effect on next wake.",
		});
	}

	private configureRealtimeVoice(
		originalTarget: string,
		value: unknown,
		res: ServerResponse,
	): void {
		if (typeof value !== "string" || !value.trim()) {
			return sendError(res, 400, "invalid_value", "voice must be a non-empty string");
		}
		const voice = normalizeRealtimeVoiceName(value);
		if (!voice) {
			return sendError(
				res,
				400,
				"invalid_value",
				`voice must be one of: ${REALTIME_VOICE_OPTIONS.map((option) => option.name).join(", ")}`,
			);
		}

		const settings = this.loadSettingsRaw();
		if (settings instanceof Response) return sendError(res, 500, "settings_read_failed");

		const previousValue = normalizeRealtimeVoiceName(settings.realtimeVoice) || DEFAULT_REALTIME_VOICE;
		settings.realtimeVoice = voice;

		if (!this.saveSettingsRaw(settings)) {
			return sendError(res, 500, "settings_write_failed");
		}

		const changed = this.writeConfiguredAwareness(originalTarget, voice, previousValue);
		const description = realtimeVoiceDescription(voice);

		sendJson(res, 200, {
			edited: true,
			changed,
			target: originalTarget,
			tier: "container",
			previous_value: previousValue,
			new_value: voice,
			accepted_values: REALTIME_VOICE_OPTIONS.map((option) => option.name),
			applied_at: nowIso(),
			note: `Realtime voice changes apply to the next voice session.${description ? ` ${description}` : ""}`,
		});
	}

	/**
	 * Verbosity edits accept either:
	 *  - target = "verbose", value = boolean | object (replace whole block)
	 *  - target = "verbose.<path>", value = any (set nested key)
	 */
	private configureVerbose(
		originalTarget: string,
		target: string,
		value: unknown,
		res: ServerResponse,
	): void {
		const settings = this.loadSettingsRaw();
		if (settings instanceof Response) return sendError(res, 500, "settings_read_failed");

		const previousValue = this.getNestedSetting(settings, target);

		if (target === "verbose") {
			// Replace the entire verbose block. Accept boolean, "messages-only", or object.
			if (
				typeof value !== "boolean" &&
				value !== "messages-only" &&
				(value === null || typeof value !== "object")
			) {
				return sendError(
					res,
					400,
					"invalid_value",
					'verbose must be a boolean, "messages-only", or an object',
				);
			}
			settings.verbose = value as VerbosityLevel | MomVerboseSettings;
		} else {
			// Nested write like verbose.slack.C09...
			this.setNestedSetting(settings, target, value);
		}

		if (!this.saveSettingsRaw(settings)) {
			return sendError(res, 500, "settings_write_failed");
		}

		const changed = this.writeConfiguredAwareness(originalTarget, value, previousValue);

		sendJson(res, 200, {
			edited: true,
			changed,
			target: originalTarget,
			tier: "container",
			previous_value: previousValue,
			new_value: value,
			applied_at: nowIso(),
			note: "Verbosity changes take effect on the next outbound message.",
		});
	}

	/**
	 * Spontaneity edits go through MomSettingsManager so the level/interval
	 * sync logic runs, then trigger a live reschedule of
	 * `attention/queue/heartbeat.json` so the scheduled prompt watcher + DO wake
	 * manifest pick up the new cadence without waiting for the next container boot.
	 */
	private configureSpontaneity(
		originalTarget: string,
		target: string,
		value: unknown,
		res: ServerResponse,
	): void {
		const manager = new MomSettingsManager(this.workingDir);
		const previous = manager.getSpontaneitySettings();

		// Translate a dotted leaf target into a patch object.
		const patch: Partial<import("../context.js").MomSpontaneitySettings> = {};
		try {
			if (target === "spontaneity") {
				if (value === null || typeof value !== "object") {
					return sendError(
						res,
						400,
						"invalid_value",
						"spontaneity must be an object",
					);
				}
				Object.assign(patch, value);
			} else if (target === "spontaneity.enabled") {
				if (typeof value !== "boolean") {
					return sendError(res, 400, "invalid_value", "spontaneity.enabled must be a boolean");
				}
				patch.enabled = value;
			} else if (target === "spontaneity.level") {
				if (typeof value !== "number" || value < 1 || value > 5 || !Number.isInteger(value)) {
					return sendError(
						res,
						400,
						"invalid_value",
						"spontaneity.level must be an integer 1-5",
					);
				}
				patch.level = value as 1 | 2 | 3 | 4 | 5;
			} else if (target === "spontaneity.intervalMinutes") {
				if (typeof value !== "number" || value <= 0) {
					return sendError(
						res,
						400,
						"invalid_value",
						"spontaneity.intervalMinutes must be a positive number",
					);
				}
				patch.intervalMinutes = value;
			} else if (target === "spontaneity.spontaneity") {
				if (typeof value !== "number" || value < 0 || value > 1) {
					return sendError(
						res,
						400,
						"invalid_value",
						"spontaneity.spontaneity must be a number between 0 and 1",
					);
				}
				patch.spontaneity = value;
			} else if (target === "spontaneity.quietHours") {
				if (
					!value ||
					typeof value !== "object" ||
					typeof (value as { start?: unknown }).start !== "string" ||
					typeof (value as { end?: unknown }).end !== "string"
				) {
					return sendError(
						res,
						400,
						"invalid_value",
						"spontaneity.quietHours must be { start, end } with HH:MM strings",
					);
				}
				patch.quietHours = value as { start: string; end: string };
			} else if (target === "spontaneity.quietHours.start") {
				if (typeof value !== "string") {
					return sendError(res, 400, "invalid_value", "quietHours.start must be a string");
				}
				patch.quietHours = { ...previous.quietHours, start: value };
			} else if (target === "spontaneity.quietHours.end") {
				if (typeof value !== "string") {
					return sendError(res, 400, "invalid_value", "quietHours.end must be a string");
				}
				patch.quietHours = { ...previous.quietHours, end: value };
			} else if (target === "spontaneity.timezone") {
				if (typeof value !== "string") {
					return sendError(res, 400, "invalid_value", "spontaneity.timezone must be a string");
				}
				patch.timezone = value;
			} else {
				return sendError(res, 400, "invalid_target", `Unknown spontaneity target: ${target}`);
			}
		} catch (err) {
			return sendError(
				res,
				400,
				"invalid_value",
				err instanceof Error ? err.message : "Invalid value",
			);
		}

		const merged = manager.setSpontaneity(patch);

		// Live reschedule: rewrite attention/queue/heartbeat.json so the next fire
		// reflects the new cadence instead of waiting for a full boot.
		let scheduleResult: ReturnType<typeof syncHeartbeatFromSpontaneity> | null = null;
		try {
			scheduleResult = syncHeartbeatFromSpontaneity(this.workingDir, merged);
		} catch (err) {
			log.logWarning(
				"[operator] heartbeat reschedule failed",
				err instanceof Error ? err.message : String(err),
			);
		}

		const previousValue = this.pickPrevious(previous, target);
		const changed = this.writeConfiguredAwareness(originalTarget, value, previousValue);

		sendJson(res, 200, {
			edited: true,
			changed,
			target: originalTarget,
			tier: "container",
			previous_value: previousValue,
			new_value: value,
			applied_at: nowIso(),
			schedule: scheduleResult,
			note: "Heartbeat schedule resynced live. Other effects take place on next wake.",
		});
	}

	/**
	 * Pick the previous value matching the dotted target path out of the
	 * current spontaneity block, so the response reflects exactly the
	 * leaf the operator changed.
	 */
	private pickPrevious(
		previous: import("../context.js").MomSpontaneitySettings,
		target: string,
	): unknown {
		switch (target) {
			case "spontaneity":
				return previous;
			case "spontaneity.enabled":
				return previous.enabled;
			case "spontaneity.level":
				return previous.level;
			case "spontaneity.intervalMinutes":
				return previous.intervalMinutes;
			case "spontaneity.spontaneity":
				return previous.spontaneity;
			case "spontaneity.quietHours":
				return previous.quietHours;
			case "spontaneity.quietHours.start":
				return previous.quietHours.start;
			case "spontaneity.quietHours.end":
				return previous.quietHours.end;
			case "spontaneity.timezone":
				return previous.timezone ?? null;
			default:
				return null;
		}
	}

	/**
	 * Write the `HEARTBEAT.md` checklist prompt. Empty string is legal and
	 * triggers the documented kill-switch behavior in the heartbeat adapter.
	 */
	private configureHeartbeatChecklist(
		originalTarget: string,
		value: unknown,
		res: ServerResponse,
	): void {
		if (typeof value !== "string") {
			return sendError(
				res,
				400,
				"invalid_value",
				"heartbeat.checklist value must be a string (empty string = kill switch)",
			);
		}

		const checklistPath = join(this.workingDir, "HEARTBEAT.md");
		let previousValue: string | null = null;
		try {
			if (existsSync(checklistPath)) {
				previousValue = readFileSync(checklistPath, "utf-8");
			}
		} catch (err) {
			log.logWarning(
				"[operator] HEARTBEAT.md read failed",
				err instanceof Error ? err.message : String(err),
			);
		}

		try {
			writeFileSync(checklistPath, value, "utf-8");
		} catch (err) {
			log.logWarning(
				"[operator] HEARTBEAT.md write failed",
				err instanceof Error ? err.message : String(err),
			);
			return sendError(res, 500, "file_write_failed");
		}

		const killSwitch = value.trim().length === 0;
		const changed = !settingsValueEquals(previousValue, value);
		if (changed) {
			this.writeAwareness(
				killSwitch
					? `[operator configured ${originalTarget}] HEARTBEAT.md cleared — heartbeat kill switch ON.`
					: `[operator configured ${originalTarget}] HEARTBEAT.md rewritten (${value.length} chars).`,
			);
		}

		sendJson(res, 200, {
			edited: true,
			changed,
			target: originalTarget,
			tier: "file",
			path: "HEARTBEAT.md",
			previous_value: previousValue,
			new_value: value,
			kill_switch: killSwitch,
			applied_at: nowIso(),
			note: killSwitch
				? "HEARTBEAT.md is empty. Heartbeat runs will be skipped until the file is non-empty."
				: "HEARTBEAT.md updated. Takes effect on the next heartbeat fire.",
		});
	}

	// ------------------------------------------------------------------------
	// /operator/describe
	// ------------------------------------------------------------------------

	private handleDescribe(res: ServerResponse): void {
		const manager = new MomSettingsManager(this.workingDir);
		const spontaneity = manager.getSpontaneitySettings();
		const raw = manager.getRawSettings();

		let heartbeatChecklist: string | null = null;
		const checklistPath = join(this.workingDir, "HEARTBEAT.md");
		try {
			if (existsSync(checklistPath)) {
				heartbeatChecklist = readFileSync(checklistPath, "utf-8");
			}
		} catch {
			heartbeatChecklist = null;
		}

		const heartbeatFile = join(this.workingDir, ATTENTION_QUEUE_DIR, "heartbeat.json");
		let heartbeatScheduleFile: unknown = null;
		try {
			if (existsSync(heartbeatFile)) {
				heartbeatScheduleFile = JSON.parse(readFileSync(heartbeatFile, "utf-8"));
			}
		} catch {
			heartbeatScheduleFile = null;
		}

		// Read thinking_level from the raw settings file directly.
		// configure writes to `thinking_level` (canonical key for agent.ts),
		// MomSettingsManager uses `defaultThinkingLevel`. Check both.
		const rawSettings = this.loadSettingsRaw();
		const thinkingLevel = rawSettings instanceof Response
			? raw.defaultThinkingLevel ?? null
			: (rawSettings as Record<string, unknown>).thinking_level ?? raw.defaultThinkingLevel ?? null;
		const realtimeVoice = rawSettings instanceof Response
			? normalizeRealtimeVoiceName(raw.realtimeVoice) || DEFAULT_REALTIME_VOICE
			: normalizeRealtimeVoiceName((rawSettings as Record<string, unknown>).realtimeVoice) || DEFAULT_REALTIME_VOICE;

		let models: Array<{ provider: string; id: string; name: string; api: string }> = [];
		try {
			models = listModels(this.workingDir);
		} catch (err) {
			log.logWarning(
				"[operator] model list failed",
				err instanceof Error ? err.message : String(err),
			);
		}

		sendJson(res, 200, {
			spontaneity,
			verbose: raw.verbose ?? null,
			model: raw.defaultModel ?? null,
			provider: raw.defaultProvider ?? null,
			models,
			thinking_level: thinkingLevel,
			thinking_level_accepted: [...THINKING_LEVEL_VALUES],
			voice: realtimeVoice,
			voice_accepted: REALTIME_VOICE_OPTIONS.map((option) => option.name),
			heartbeat: {
				checklist: heartbeatChecklist,
				checklist_present: heartbeatChecklist !== null,
				checklist_empty:
					heartbeatChecklist !== null && heartbeatChecklist.trim().length === 0,
				schedule_file: heartbeatScheduleFile,
			},
			described_at: nowIso(),
		});
	}

	private getNestedSetting(
		settings: Record<string, unknown>,
		target: string,
	): unknown {
		const parts = target.split(".");
		let cursor: unknown = settings;
		for (const part of parts) {
			if (cursor && typeof cursor === "object" && part in (cursor as Record<string, unknown>)) {
				cursor = (cursor as Record<string, unknown>)[part];
			} else {
				return null;
			}
		}
		return cursor;
	}

	private setNestedSetting(
		settings: Record<string, unknown>,
		target: string,
		value: unknown,
	): void {
		const parts = target.split(".");
		let cursor: Record<string, unknown> = settings;
		for (let i = 0; i < parts.length - 1; i++) {
			const part = parts[i];
			const next = cursor[part];
			if (!next || typeof next !== "object") {
				cursor[part] = {};
			}
			cursor = cursor[part] as Record<string, unknown>;
		}
		cursor[parts[parts.length - 1]] = value;
	}

	// ========================================================================
	// PlatformAdapter interface — mostly no-ops (headless, no outbound)
	// ========================================================================

	async postMessage(_channel: string, _text: string): Promise<string> {
		return String(Date.now());
	}
	async updateMessage(_channel: string, _ts: string, _text: string): Promise<void> {}
	async deleteMessage(_channel: string, _ts: string): Promise<void> {}
	async postInThread(_channel: string, _threadTs: string, _text: string): Promise<string> {
		return String(Date.now());
	}
	async uploadFile(_channel: string, _filePath: string, _title?: string): Promise<void> {}

	logToFile(entry: object): void {
		appendFileSync(
			join(this.workingDir, "log.jsonl"),
			`${JSON.stringify(entry)}\n`,
		);
	}

	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile({
			date: nowIso(),
			ts,
			channel: `${OPERATOR_CHANNEL_LABEL}:${channel}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	getUser(_userId: string): UserInfo | undefined {
		return { id: OPERATOR_USER, userName: OPERATOR_USER, displayName: "Operator" };
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		if (channelId === OPERATOR_CHANNEL_ID) {
			return { id: OPERATOR_CHANNEL_ID, name: OPERATOR_CHANNEL_LABEL };
		}
		return undefined;
	}

	getAllUsers(): UserInfo[] {
		return [{ id: OPERATOR_USER, userName: OPERATOR_USER, displayName: "Operator" }];
	}

	getAllChannels(): ChannelInfo[] {
		return [{ id: OPERATOR_CHANNEL_ID, name: OPERATOR_CHANNEL_LABEL }];
	}

	enqueueEvent(event: MomEvent): boolean {
		if (event.channel !== OPERATOR_CHANNEL_ID) return false;

		if (this.queue.length >= 8) {
			log.logWarning(
				`Operator queue full, discarding: ${event.text.substring(0, 50)}`,
			);
			return false;
		}

		this.queue.push(event);
		this.processQueue();
		return true;
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			while (this.queue.length > 0) {
				const event = this.queue.shift()!;
				try {
					await this.handler.handleEvent(event, this, true);
				} catch (err) {
					log.logWarning(
						"Operator run failed",
						err instanceof Error ? err.message : String(err),
					);
				}
			}
		} finally {
			this.processing = false;
		}
	}

	createContext(event: MomEvent, _store: ChannelStore, _isEvent?: boolean): MomContext {
		return {
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				userName: OPERATOR_USER,
				channel: event.channel,
				ts: event.ts,
				attachments: [],
			},
			channelName: OPERATOR_CHANNEL_LABEL,
			channels: this.getAllChannels(),
			users: this.getAllUsers(),
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

function settingsValueEquals(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}
