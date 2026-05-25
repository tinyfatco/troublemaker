import { appendFileSync } from "fs";
import { join } from "path";

export interface EmailThreadLedgerEvent {
	type: "inbound" | "outbound";
	at: string;
	channelId: string;
	from?: string;
	to?: string[];
	subject?: string;
	body?: string;
	messageId?: string;
	providerMessageId?: string;
	inReplyTo?: string;
	references?: string;
}

const LEDGER_FILE = "email-thread-events.jsonl";

export function appendEmailThreadEvent(workingDir: string, event: EmailThreadLedgerEvent): void {
	appendFileSync(join(workingDir, LEDGER_FILE), `${JSON.stringify(event)}\n`);
}
