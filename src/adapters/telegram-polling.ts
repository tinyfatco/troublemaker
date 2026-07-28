import * as log from "../log.js";
import { TelegramBase, type TelegramBaseConfig } from "./telegram-base.js";

// ============================================================================
// TelegramPollingAdapter — Long polling (persistent connection)
// ============================================================================

export class TelegramPollingAdapter extends TelegramBase {
	constructor(config: TelegramBaseConfig) {
		super(config);
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("TelegramPollingAdapter: handler not set. Call setHandler() before start().");

		if (process.env.MOM_TELEGRAM_TAKEOVER === "true") {
			await this.bot.deleteWebHook();
			log.logInfo("Telegram webhook removed for polling takeover");
		}

		const me = await this.bot.getMe();
		log.logInfo(`Telegram bot started (polling): @${me.username} (${me.id})`);

		// Wire the handler before polling so updates already queued at startup
		// cannot be acknowledged before the adapter is ready to process them.
		this.bot.on("message", (msg) => this.handleIncomingMessage(msg));
		this.bot.startPolling();

		log.logConnected();
	}

	async stop(): Promise<void> {
		this.bot.stopPolling();
	}
}
