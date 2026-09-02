export interface DeliveryContextMessage {
	sourceEventType?: string;
	deliveryId?: string;
	eventType?: "mention" | "dm";
	directlyAddressed?: boolean;
	threadTs?: string;
	replyTarget?: string;
	replyTargetDescription?: string;
}

/**
 * Render transport metadata that lets the model preserve the origin and reply
 * target of a user message, including messages steered into another active run.
 */
export function formatDeliveryContext(message: DeliveryContextMessage): string {
	const hasActionableDeliveryContext = Boolean(
		message.sourceEventType
		|| message.deliveryId
		|| message.replyTarget
		|| message.threadTs
		|| typeof message.directlyAddressed === "boolean",
	);
	if (!hasActionableDeliveryContext) return "";

	const lines: string[] = [];
	if (message.sourceEventType) lines.push(`Source event: ${message.sourceEventType}`);
	if (message.deliveryId && /^[A-Za-z0-9._:-]{8,128}$/.test(message.deliveryId)) {
		lines.push(`Delivery ID: ${message.deliveryId}`);
	}
	if (message.eventType) lines.push(`Message type: ${message.eventType}`);
	if (typeof message.directlyAddressed === "boolean") {
		lines.push(`Directly addressed: ${message.directlyAddressed ? "yes" : "no"}`);
	}
	if (message.threadTs) lines.push(`Thread timestamp: ${message.threadTs}`);
	if (message.replyTarget) {
		lines.push(`Suggested reply target: ${message.replyTarget}`);
		if (message.replyTargetDescription) lines.push(`Target meaning: ${message.replyTargetDescription}`);
		lines.push("Use send_message with this exact target if you choose to reply there. send_message requires a target; never omit it.");
	}
	if (lines.length === 0) return "";
	return `<delivery_context>\n${lines.join("\n")}\n</delivery_context>`;
}
