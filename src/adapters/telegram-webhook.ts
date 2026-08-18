import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Update } from "node-telegram-bot-api";
import * as log from "../log.js";
import { TelegramBase, type TelegramBaseConfig } from "./telegram-base.js";

const MAXIMUM_WEBHOOK_BYTES = 1024 * 1024;

// ============================================================================
// TelegramWebhookAdapter — HTTPS webhook (serverless-friendly)
// ============================================================================

export interface TelegramWebhookAdapterConfig extends TelegramBaseConfig {
	webhookUrl?: string;
	webhookSecret: string;
	/** Skip setWebHook/deleteWebHook calls. Use when webhook URL is managed externally (e.g. CF Worker). */
	skipRegistration?: boolean;
	/** Scoped capability used when a host proxy verifies Telegram upstream. */
	upstreamToken?: string;
}

export class TelegramWebhookAdapter extends TelegramBase {
	private webhookUrl?: string;
	private webhookSecret: string;
	private skipRegistration: boolean;
	private upstreamToken?: string;

	constructor(config: TelegramWebhookAdapterConfig) {
		super(config);
		this.webhookUrl = config.webhookUrl;
		this.webhookSecret = config.webhookSecret;
		this.skipRegistration = config.skipRegistration || !!process.env.MOM_SKIP_WEBHOOK_REGISTRATION;
		this.upstreamToken = config.upstreamToken;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("TelegramWebhookAdapter: handler not set. Call setHandler() before start().");

		const me = await this.bot.api.getMe();
		log.logInfo(`Telegram bot (webhook): @${me.username} (${me.id})`);

		// Wire up message handler before accepting webhook deliveries.
		this.bot.on("message", (context) => {
			if (context.message) this.handleIncomingMessage(context.message);
		});

		// Register webhook with Telegram API (unless managed externally)
		if (!this.skipRegistration) {
			if (!this.webhookUrl) throw new Error("TelegramWebhookAdapter: webhookUrl required when not skipping registration");
			const webhookOpts: { secret_token: string } = {
				secret_token: this.webhookSecret,
			};
			await this.bot.api.setWebhook({ url: this.webhookUrl, ...webhookOpts });
			log.logInfo(`Telegram webhook registered: ${this.webhookUrl}`);
		} else {
			log.logInfo("Telegram webhook registration skipped (managed externally)");
		}

		log.logConnected();
	}

	async stop(): Promise<void> {
		// Unregister webhook with Telegram (unless managed externally)
		if (!this.skipRegistration) {
			try {
				await this.bot.api.deleteWebhook();
				log.logInfo("Telegram webhook deleted");
			} catch (err) {
				log.logWarning("Failed to delete Telegram webhook", err instanceof Error ? err.message : String(err));
			}
		}
	}

	// ==========================================================================
	// HTTP request handling — called by Gateway
	// ==========================================================================

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		let rejected = false;
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			totalBytes += chunk.byteLength;
			if (totalBytes > MAXIMUM_WEBHOOK_BYTES) {
				rejected = true;
				res.writeHead(413);
				res.end("Request too large");
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", async () => {
			if (rejected) return;
			const body = Buffer.concat(chunks).toString("utf-8");

			const upstreamVerified = this.upstreamToken
				? bearerMatches(req.headers.authorization, this.upstreamToken)
				: false;
			if (!upstreamVerified) {
				if (!this.webhookSecret) {
					res.writeHead(401);
					res.end("Webhook authentication is not configured");
					return;
				}
				const secretToken = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
				if (!secretToken || !constantTimeEqual(secretToken, this.webhookSecret)) {
					log.logWarning("Telegram webhook secret token verification failed");
					res.writeHead(401);
					res.end("Invalid secret token");
					return;
				}
			}

			let update: Update;
			try {
				update = JSON.parse(body) as Update;
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			res.writeHead(200);
			res.end();

			log.logInfo(`[telegram:webhook] dispatch: processing update at ${new Date().toISOString()}`);
			// Acknowledge transport delivery, then process through the shared middleware path.
			void this.bot.handleUpdate(update).catch((error) => {
				log.logWarning(
					"Telegram webhook update failed",
					error instanceof Error ? error.message : String(error),
				);
			});
		});
	}
}

function bearerMatches(header: string | undefined, expected: string): boolean {
	return constantTimeEqual(/^Bearer ([^\s]+)$/i.exec(header || "")?.[1] || "", expected);
}

function constantTimeEqual(left: string, right: string): boolean {
	const actual = Buffer.from(left);
	const expected = Buffer.from(right);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
