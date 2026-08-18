import * as log from "../log.js";
import { TelegramBase, type TelegramBaseConfig } from "./telegram-base.js";

// ============================================================================
// TelegramPollingAdapter — Long polling (persistent connection)
// ============================================================================

export class TelegramPollingAdapter extends TelegramBase {
	private pollingTask: Promise<void> | undefined;

	constructor(config: TelegramBaseConfig) {
		super(config);
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("TelegramPollingAdapter: handler not set. Call setHandler() before start().");

		if (process.env.MOM_TELEGRAM_TAKEOVER === "true") {
			await this.bot.api.deleteWebhook();
			log.logInfo("Telegram webhook removed for polling takeover");
		}

		const me = await this.bot.api.getMe();
		log.logInfo(`Telegram bot started (polling): @${me.username} (${me.id})`);

		// Wire up message handler
		this.bot.on("message", (context) => {
			if (context.message) this.handleIncomingMessage(context.message);
		});
		this.pollingTask = this.bot.startPolling().catch((error) => {
			log.logWarning(
				"Telegram polling stopped unexpectedly",
				error instanceof Error ? error.message : String(error),
			);
		});

		log.logConnected();
	}

	async stop(): Promise<void> {
		this.bot.stop();
		await this.pollingTask;
		this.pollingTask = undefined;
	}
}
