import { readFileSync } from "fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { createServer as createHttpsServer, type Server } from "https";
import * as log from "../log.js";
import { TelegramBase, type TelegramBaseConfig } from "./telegram-base.js";

// ============================================================================
// TelegramWebhookAdapter — HTTPS webhook (serverless-friendly)
// ============================================================================

export interface TelegramWebhookAdapterConfig extends TelegramBaseConfig {
	webhookUrl: string;
	webhookSecret: string;
	port: number;
	/** Path to TLS certificate file (PEM). Required for self-signed certs on bare IP. */
	tlsCert?: string;
	/** Path to TLS key file (PEM). Required alongside tlsCert. */
	tlsKey?: string;
}

export class TelegramWebhookAdapter extends TelegramBase {
	private webhookUrl: string;
	private webhookSecret: string;
	private port: number;
	private tlsCert?: string;
	private tlsKey?: string;
	private server: Server | import("http").Server | null = null;

	constructor(config: TelegramWebhookAdapterConfig) {
		super(config);
		this.webhookUrl = config.webhookUrl;
		this.webhookSecret = config.webhookSecret;
		this.port = config.port;
		this.tlsCert = config.tlsCert;
		this.tlsKey = config.tlsKey;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("TelegramWebhookAdapter: handler not set. Call setHandler() before start().");

		const me = await this.bot.getMe();
		log.logInfo(`Telegram bot (webhook): @${me.username} (${me.id})`);

		// Wire up message handler — processUpdate() fires bot.on("message") events
		this.bot.on("message", (msg) => this.handleIncomingMessage(msg));

		// Register webhook with Telegram API
		// If we have a self-signed cert, pass it so Telegram trusts our server
		const webhookOpts: { secret_token: string; certificate?: string } = {
			secret_token: this.webhookSecret,
		};
		if (this.tlsCert) {
			webhookOpts.certificate = this.tlsCert;
		}
		await this.bot.setWebHook(this.webhookUrl, webhookOpts);
		log.logInfo(`Telegram webhook registered: ${this.webhookUrl}`);

		// Start HTTPS server (or HTTP if no TLS cert — e.g. behind a reverse proxy)
		const handler = (req: IncomingMessage, res: ServerResponse) => this.handleRequest(req, res);

		if (this.tlsCert && this.tlsKey) {
			const tlsOpts = {
				cert: readFileSync(this.tlsCert),
				key: readFileSync(this.tlsKey),
			};
			this.server = createHttpsServer(tlsOpts, handler);
			log.logInfo("Telegram webhook using HTTPS (self-signed cert)");
		} else {
			this.server = createHttpServer(handler);
			log.logInfo("Telegram webhook using HTTP (expects reverse proxy for TLS)");
		}

		await new Promise<void>((resolve) => {
			this.server!.listen(this.port, () => {
				log.logInfo(`Telegram webhook server listening on port ${this.port}`);
				resolve();
			});
		});

		log.logConnected();
	}

	async stop(): Promise<void> {
		// Unregister webhook with Telegram
		try {
			await this.bot.deleteWebHook();
			log.logInfo("Telegram webhook deleted");
		} catch (err) {
			log.logWarning("Failed to delete Telegram webhook", err instanceof Error ? err.message : String(err));
		}

		if (this.server) {
			await new Promise<void>((resolve, reject) => {
				this.server!.close((err) => (err ? reject(err) : resolve()));
			});
			this.server = null;
		}
	}

	// ==========================================================================
	// HTTP request handling
	// ==========================================================================

	private handleRequest(req: IncomingMessage, res: ServerResponse): void {
		if (req.method !== "POST" || req.url !== "/telegram/webhook") {
			res.writeHead(404);
			res.end("Not found");
			return;
		}

		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf-8");

			// Verify secret token header
			const secretToken = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
			if (!secretToken || secretToken !== this.webhookSecret) {
				log.logWarning("Telegram webhook secret token verification failed");
				res.writeHead(401);
				res.end("Invalid secret token");
				return;
			}

			let update: object;
			try {
				update = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}

			// Acknowledge immediately (Telegram retries on non-2xx)
			res.writeHead(200);
			res.end();

			// Process the update — fires bot.on("message") which calls handleIncomingMessage
			this.bot.processUpdate(update as Parameters<typeof this.bot.processUpdate>[0]);
		});
	}
}
