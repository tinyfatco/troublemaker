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

		// Start polling
		this.bot.startPolling();

		const me = await this.bot.getMe();
		log.logInfo(`Telegram bot started (polling): @${me.username} (${me.id})`);

		// Wire up message handler
		this.bot.on("message", (msg) => this.handleIncomingMessage(msg));

		log.logConnected();
	}

	async stop(): Promise<void> {
		this.bot.stopPolling();
	}
}
