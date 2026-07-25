import type { MomEvent, PlatformAdapter } from "./adapters/types.js";
import { formatDeliveryContext } from "./delivery-context.js";

export type BusyMessageDisposition = "steered" | "queued";

export interface RouteBusyMessageOptions {
	prompt: string;
	canSteer: boolean;
	steer: (prompt: string) => boolean;
	enqueue: () => void;
}

/**
 * Try Pi's safe steering queue first, then enqueue a fresh canonical turn.
 * Deliberately has no abort callback: ordinary busy messages must never cancel
 * the active run or tool as a side effect of delivery.
 */
export function routeBusyMessageWithoutInterrupt(options: RouteBusyMessageOptions): BusyMessageDisposition {
	if (options.canSteer && options.steer(options.prompt)) return "steered";
	options.enqueue();
	return "queued";
}

/** Format a steered message with the same source and delivery metadata as a fresh turn. */
export function formatBusyMessageSteer(
	event: MomEvent,
	adapter: PlatformAdapter,
	channelLabel: string,
	receivedAt = Date.now(),
): string {
	const user = adapter.getUser(event.user);
	const userName = user?.userName || user?.displayName || event.user || "unknown";
	const deliveryContext = formatDeliveryContext({
		sourceEventType: event.sourceEventType,
		eventType: event.type,
		directlyAddressed: event.directlyAddressed,
		threadTs: event.threadTs,
		replyTarget: event.replyTarget,
		replyTargetDescription: event.replyTargetDescription,
	});
	const message = `[${formatLocalTimestamp(receivedAt)}] [${channelLabel}] [${userName}]: ${event.text}`;
	const attachments = event.attachments?.map((attachment) => attachment.local).filter(Boolean) ?? [];
	const attachmentContext = attachments.length > 0
		? `<attachments>\n${attachments.join("\n")}\n</attachments>`
		: "";

	return [deliveryContext, message, attachmentContext].filter(Boolean).join("\n\n");
}

export function formatLocalTimestamp(ms = Date.now()): string {
	const now = new Date(ms);
	const pad = (value: number) => value.toString().padStart(2, "0");
	const offset = -now.getTimezoneOffset();
	const offsetSign = offset >= 0 ? "+" : "-";
	const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
	const offsetMinutes = pad(Math.abs(offset) % 60);
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMinutes}`;
}
