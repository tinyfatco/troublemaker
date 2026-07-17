import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { hasSlackBroadcastMention, stripSlackBroadcastMentions } from "./slack-addressing.js";
import { SlackBase, type SlackBaseConfig } from "./slack-base.js";
import type { MomEvent } from "./types.js";

// ============================================================================
// SlackWebhookAdapter — HTTP Events API (serverless-friendly)
// ============================================================================

export interface SlackWebhookAdapterConfig extends SlackBaseConfig {
	signingSecret: string;
}

export class SlackWebhookAdapter extends SlackBase {
	private signingSecret: string;

	constructor(config: SlackWebhookAdapterConfig) {
		super(config);
		this.signingSecret = config.signingSecret;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("SlackWebhookAdapter: handler not set. Call setHandler() before start().");

		await this.initMetadata();

		this.markStarted();
	}

	async stop(): Promise<void> {
		// No-op — gateway owns the HTTP server
	}

	// ==========================================================================
	// HTTP request handling — called by Gateway
	// ==========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const rawBody = Buffer.concat(chunks);
			const body = rawBody.toString("utf-8");

			// Trust upstream verification when crawdad-cf has already verified the request
			// (or when running with no signing secret — secrets-out-of-container mode).
			const upstreamVerified = req.headers["x-crawdad-dev-verified"] === "true";
			if (!upstreamVerified && this.signingSecret) {
				const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
				const signature = req.headers["x-slack-signature"] as string | undefined;

				if (!timestamp || !signature) {
					res.writeHead(401);
					res.end("Missing signature headers");
					return;
				}

				// Reject requests older than 5 minutes (replay protection)
				const now = Math.floor(Date.now() / 1000);
				if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
					res.writeHead(401);
					res.end("Request too old");
					return;
				}

				if (!this.verifySignature(timestamp, body, signature)) {
					log.logWarning("Slack webhook signature verification failed");
					res.writeHead(401);
					res.end("Invalid signature");
					return;
				}
			}

			let payload: SlackEventPayload;
			try {
				payload = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			this.dispatchEvent(payload, res);
		});
	}

	// ==========================================================================
	// Signature verification
	// ==========================================================================

	private verifySignature(timestamp: string, body: string, expectedSignature: string): boolean {
		const sigBasestring = `v0:${timestamp}:${body}`;
		const hmac = createHmac("sha256", this.signingSecret);
		hmac.update(sigBasestring);
		const computed = `v0=${hmac.digest("hex")}`;

		try {
			return timingSafeEqual(Buffer.from(computed), Buffer.from(expectedSignature));
		} catch {
			return false;
		}
	}

	// ==========================================================================
	// Event dispatch
	// ==========================================================================

	/** Promise that resolves when the last enqueued run completes. */
	public lastRunDone: Promise<void> = Promise.resolve();

	private async dispatchEvent(payload: SlackEventPayload, res: ServerResponse): Promise<void> {
		// URL verification challenge
		if (payload.type === "url_verification") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ challenge: payload.challenge }));
			log.logInfo("Slack URL verification challenge passed");
			return;
		}

		res.writeHead(200);
		res.end();

		if (payload.type !== "event_callback" || !payload.event) {
			return;
		}

		const event = payload.event;
		const eventUserId = event.user || event.bot_id || "unknown";
		if (event.type === "message" && event.channel_type === "im" && !this.acceptsDmFrom(eventUserId)) {
			log.logInfo(`[${event.channel}] Ignoring Slack DM from non-allowlisted user ${eventUserId}`);
			return;
		}

		const isDirectlyAddressed = event.type === "app_mention"
			|| event.channel_type === "im"
			|| Boolean(event.text?.includes(`<@${this.botUserId}>`))
			|| hasSlackBroadcastMention(event.text);

		// Feed pulse on every message (before any filtering) — pulse needs to see everything
		if (this.pulse && event.ts && (event.user || event.bot_id)) {
			this.pulse.record(event.channel, event.user || event.bot_id!, (event.text || "").length, event.text, this.slackPulseMetadata(event.channel, event.ts, event.thread_ts, isDirectlyAddressed));
		}

		// Ignore own messages only — bots are just participants
		if (event.user === this.botUserId) {
			return;
		}
		// Ignore subtypes other than file_share and bot_message
		if (event.subtype !== undefined && event.subtype !== "file_share" && event.subtype !== "bot_message") {
			return;
		}
		// Need at least a user or bot_id to attribute the message
		if (!event.user && !event.bot_id) {
			return;
		}

		if (event.type === "app_mention") {
			await this.handleAppMention(event, payload.team_id);
		} else if (event.type === "message") {
			await this.handleMessage(event, payload.team_id);
		}

	}

	private async handleAppMention(event: SlackEventInner, teamId?: string): Promise<void> {
		if (event.channel.startsWith("D")) return;
		this.observeChannel(event.channel);

		const threadTs = event.thread_ts ?? event.ts;

		const momEvent: MomEvent = {
			type: "mention",
			channel: event.channel,
			ts: event.ts,
			user: event.user || event.bot_id || "unknown",
			teamId,
			text: stripSlackBroadcastMentions((event.text || "").replace(/<@[A-Z0-9]+>/gi, "")),
			rawText: event.text || "",
			sourceEventType: "slack_app_mention",
			directlyAddressed: true,
			threadTs,
			replyTarget: `slack:${event.channel}:${threadTs}`,
			replyTargetDescription: event.thread_ts ? "Slack thread containing this direct mention" : "Slack thread under this direct mention",
			files: event.files,
		};

		momEvent.attachments = this.logUserMessage(momEvent);

		if (this.handler.resolvePendingInput(event.channel, momEvent.text)) {
			return;
		}

		if (await this.handler.handleSlashCommand(momEvent, this)) {
			return;
		}

		if (momEvent.text.toLowerCase().trim() === "stop") {
			await this.handler.handleStop(event.channel, this, momEvent);
			return;
		}

		if (this.handler.isRunning(event.channel)) {
			this.handler.handleSteer(momEvent, this);
		} else {
			this.lastRunDone = this.getQueue(event.channel).enqueue(async () => { await this.handler.handleEvent(momEvent, this); });
		}
	}

	private async handleMessage(event: SlackEventInner, teamId?: string): Promise<void> {
		if (!event.text && (!event.files || event.files.length === 0)) return;
		const isDM = event.channel_type === "im";
		const isBotMention = event.text?.includes(`<@${this.botUserId}>`);
		const isBroadcastMention = !isDM && hasSlackBroadcastMention(event.text);
		const isDirectlyAddressed = isDM || isBroadcastMention;
		const userId = event.user || event.bot_id || "unknown";
		if (isDM && !this.acceptsDmFrom(userId)) {
			log.logInfo(`[${event.channel}] Ignoring Slack DM from non-allowlisted user ${userId}`);
			return;
		}

		this.observeChannel(event.channel);

		// Skip channel messages that are @mentions (handled by app_mention)
		if (!isDM && isBotMention) return;

		const threadTs = isDM ? undefined : event.thread_ts ?? event.ts;

		const momEvent: MomEvent = {
			type: isDM ? "dm" : "mention",
			channel: event.channel,
			ts: event.ts,
			user: userId,
			teamId,
			text: stripSlackBroadcastMentions((event.text || "").replace(/<@[A-Z0-9]+>/gi, "")),
			rawText: event.text || "",
			sourceEventType: isDM
				? "slack_dm"
				: isBroadcastMention
					? "slack_broadcast_mention"
					: "slack_ambient_message",
			directlyAddressed: isDirectlyAddressed,
			threadTs,
			replyTarget: isDM
				? event.channel
				: `slack:${event.channel}:${threadTs}`,
			replyTargetDescription: isDM
				? "Slack DM"
				: isBroadcastMention
					? event.thread_ts
						? "Slack thread containing this channel-wide mention"
						: "Slack thread under this channel-wide mention"
					: event.thread_ts
						? "Slack thread containing this ambient message; use only if a visible reply is appropriate"
						: "Slack thread rooted under this ambient message; use only if a visible reply is appropriate",
			files: event.files,
		};

		momEvent.attachments = this.logUserMessage(momEvent);

		if (isDirectlyAddressed) {
			if (this.handler.resolvePendingInput(event.channel, momEvent.text)) {
				return;
			}

			if (await this.handler.handleSlashCommand(momEvent, this)) {
				return;
			}

			if (momEvent.text.toLowerCase().trim() === "stop") {
				await this.handler.handleStop(event.channel, this, momEvent);
				return;
			}

			if (this.handler.isRunning(event.channel)) {
				this.handler.handleSteer(momEvent, this);
			} else {
				this.lastRunDone = this.getQueue(event.channel).enqueue(async () => { await this.handler.handleEvent(momEvent, this); });
			}
		} else {
			// Ambient engagement: non-DM, non-addressed message — let the engagement system decide
			this.onAmbientMessage?.(event.channel, momEvent, this);
		}
	}
}

// ============================================================================
// Slack webhook payload types
// ============================================================================

interface SlackEventPayload {
	type: "url_verification" | "event_callback";
	challenge?: string;
	token?: string;
	team_id?: string;
	event?: SlackEventInner;
}

interface SlackEventInner {
	type: string;
	channel: string;
	channel_type?: string;
	user?: string;
	bot_id?: string;
	text?: string;
	ts: string;
	thread_ts?: string;
	subtype?: string;
	files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
}
