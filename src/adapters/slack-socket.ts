import { SocketModeClient } from "@slack/socket-mode";
import * as log from "../log.js";
import type { ChannelStore } from "../store.js";
import { SlackBase, type SlackBaseConfig } from "./slack-base.js";
import type { MomEvent } from "./types.js";

// ============================================================================
// SlackSocketAdapter — Socket Mode (persistent WebSocket)
// ============================================================================

export interface SlackSocketAdapterConfig extends SlackBaseConfig {
	appToken: string;
}

function safelyAcknowledge(ack: () => unknown): void {
	try {
		void Promise.resolve(ack()).catch((error) => {
			log.logWarning("Slack Socket Mode acknowledgement failed", error instanceof Error ? error.message : String(error));
		});
	} catch (error) {
		log.logWarning("Slack Socket Mode acknowledgement failed", error instanceof Error ? error.message : String(error));
	}
}

export class SlackSocketAdapter extends SlackBase {
	private socketClient: SocketModeClient;

	constructor(config: SlackSocketAdapterConfig) {
		super(config);
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("SlackSocketAdapter: handler not set. Call setHandler() before start().");

		await this.initMetadata();
		this.setupEventHandlers();
		await this.socketClient.start();
		this.markStarted();
	}

	async stop(): Promise<void> {
		await this.socketClient.disconnect();
	}

	// ==========================================================================
	// Socket Mode event handlers
	// ==========================================================================

	private setupEventHandlers(): void {
		// Channel @mentions
		this.socketClient.on("app_mention", async ({ event, ack, body }) => {
			const e = event as {
				text: string;
				channel: string;
				user?: string;
				bot_id?: string;
				ts: string;
				thread_ts?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};
			this.observeChannel(e.channel);

			// Feed pulse before any filtering
			if (this.pulse && (e.user || e.bot_id)) {
				this.pulse.record(e.channel, e.user || e.bot_id!, (e.text || "").length, e.text, this.slackPulseMetadata(e.channel, e.ts, e.thread_ts, true));
			}

			if (e.channel.startsWith("D")) {
				safelyAcknowledge(ack);
				return;
			}

			// Ignore own messages only
			if (e.user === this.botUserId) {
				safelyAcknowledge(ack);
				return;
			}

			const userId = e.user || e.bot_id || "unknown";
			const threadTs = e.thread_ts ?? e.ts;

			const momEvent: MomEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: userId,
				teamId: (body as { team_id?: string }).team_id,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				rawText: e.text || "",
				sourceEventType: "slack_app_mention",
				directlyAddressed: true,
				threadTs,
				replyTarget: `slack:${e.channel}:${threadTs}`,
				replyTargetDescription: e.thread_ts ? "Slack thread containing this direct mention" : "Slack thread under this direct mention",
				files: e.files,
			};

			momEvent.attachments = this.logUserMessage(momEvent);

			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${momEvent.text.substring(0, 30)}`,
				);
				safelyAcknowledge(ack);
				return;
			}

			if (this.handler.resolvePendingInput(e.channel, momEvent.text)) {
				safelyAcknowledge(ack);
				return;
			}

			if (await this.handler.handleSlashCommand(momEvent, this)) {
				safelyAcknowledge(ack);
				return;
			}

			if (momEvent.text.toLowerCase().trim() === "stop") {
				safelyAcknowledge(ack);
				void this.handler.handleStop(e.channel, this, momEvent).catch((err) => {
					log.logWarning("Slack stop response failed", err instanceof Error ? err.message : String(err));
				});
				return;
			}

			if (this.handler.isRunning(e.channel)) {
				this.handler.handleSteer(momEvent, this);
			} else {
				this.getQueue(e.channel).enqueue(async () => { await this.handler.handleEvent(momEvent, this); });
			}

			safelyAcknowledge(ack);
		});

		// All messages (for logging) + DMs (for triggering) + ambient engagement
		this.socketClient.on("message", async ({ event, ack, body }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				thread_ts?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};
			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);
			const userId = e.user || e.bot_id || "unknown";

			// A resident host-mode agent may be intentionally reachable by only one
			// Slack identity in DMs. Reject before pulse/logging so unauthorized DM
			// content never enters the agent workspace or awareness stream.
			if (isDM && !this.acceptsDmFrom(userId)) {
				log.logInfo(`[${e.channel}] Ignoring Slack DM from non-allowlisted user ${userId}`);
				safelyAcknowledge(ack);
				return;
			}

			this.observeChannel(e.channel);

			// Feed pulse before any filtering — pulse needs to see everything
			if (this.pulse && (e.user || e.bot_id)) {
				this.pulse.record(e.channel, e.user || e.bot_id!, (e.text || "").length, e.text, this.slackPulseMetadata(e.channel, e.ts, e.thread_ts, !isDM && Boolean(isBotMention)));
			}

			// Ignore own messages only — bots are just participants
			if (e.user === this.botUserId) {
				safelyAcknowledge(ack);
				return;
			}
			// Ignore subtypes other than file_share and bot_message
			if (e.subtype !== undefined && e.subtype !== "file_share" && e.subtype !== "bot_message") {
				safelyAcknowledge(ack);
				return;
			}
			// Need at least a user or bot_id
			if (!e.user && !e.bot_id) {
				safelyAcknowledge(ack);
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				safelyAcknowledge(ack);
				return;
			}

			const threadTs = isDM ? undefined : e.thread_ts ?? e.ts;

			if (!isDM && isBotMention) {
				safelyAcknowledge(ack);
				return;
			}

			const momEvent: MomEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: userId,
				teamId: (body as { team_id?: string }).team_id,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				rawText: e.text || "",
				sourceEventType: isDM ? "slack_dm" : "slack_ambient_message",
				directlyAddressed: isDM,
				threadTs,
				replyTarget: isDM
					? e.channel
					: `slack:${e.channel}:${threadTs}`,
				replyTargetDescription: isDM
					? "Slack DM"
					: e.thread_ts
						? "Slack thread containing this ambient message; use only if a visible reply is appropriate"
						: "Slack thread rooted under this ambient message; use only if a visible reply is appropriate",
				files: e.files,
			};

			momEvent.attachments = this.logUserMessage(momEvent);

			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${momEvent.text.substring(0, 30)}`);
				safelyAcknowledge(ack);
				return;
			}

			if (isDM) {
				if (this.handler.resolvePendingInput(e.channel, momEvent.text)) {
					safelyAcknowledge(ack);
					return;
				}

				if (await this.handler.handleSlashCommand(momEvent, this)) {
					safelyAcknowledge(ack);
					return;
				}

				if (momEvent.text.toLowerCase().trim() === "stop") {
					safelyAcknowledge(ack);
					void this.handler.handleStop(e.channel, this, momEvent).catch((err) => {
						log.logWarning("Slack stop response failed", err instanceof Error ? err.message : String(err));
					});
					return;
				}

				if (this.handler.isRunning(e.channel)) {
					this.handler.handleSteer(momEvent, this);
				} else {
					this.getQueue(e.channel).enqueue(async () => { await this.handler.handleEvent(momEvent, this); });
				}
			} else {
				// Ambient engagement: non-DM, non-mention message
				this.onAmbientMessage?.(e.channel, momEvent, this);
			}

			safelyAcknowledge(ack);
		});
	}
}
