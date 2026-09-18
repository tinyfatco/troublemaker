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
	if (message.sourceEventType === "computer_voice_call_started") {
		lines.push("Voice interaction: Alex has just started a live call with you; the user message is the first finalized utterance.");
		lines.push("Computer owns microphone, transcription, and speech playback. Continue using the canonical agent model and tools; do not invoke a separate speech tool.");
		lines.push("Answer naturally for listening. Later finalized utterances may be admitted as steering while you are still working; incorporate them without discarding safe completed work.");
	} else if (message.sourceEventType === "computer_voice_call_turn") {
		lines.push("Voice interaction: Alex is continuing a live call with you; the user message is the latest finalized utterance.");
		lines.push("Computer owns microphone, transcription, and speech playback. Continue using the canonical agent model and tools; do not invoke a separate speech tool.");
		lines.push("This utterance may be steering for work already in progress; incorporate it without discarding safe completed work.");
	} else if (message.sourceEventType === "computer_duplex_thinking") {
		lines.push("Continuous duplex context, not a completed utterance: the voice owns interaction; this canonical backend silently interprets emerging speech and continues tools.");
		lines.push("Room speaker identity and addressing are unverified. Do not turn every fragment into a command or repeat prior actions. Send useful quiet guidance via live_voice_update; never invoke speech/TTS.");
	} else if (message.sourceEventType === "computer_local_duplex_delegation") {
		lines.push("Local duplex delegation: the live speech layer has asked the canonical agent runtime for deeper reasoning, durable memory, or tool work.");
		lines.push("Use canonical memory and tools normally, then return concise final guidance to the requesting live layer.");
		lines.push("The local duplex model is the call's only audible speaker. Do not invoke speech/TTS and do not create a second spoken response; the live layer will incorporate this result into one natural reply.");
	}
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
