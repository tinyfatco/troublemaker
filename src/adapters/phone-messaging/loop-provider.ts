import type { PhoneMessagingProvider, PhoneSendRequest, PhoneSendResult, PhoneTransport } from "./types.js";

export interface LoopProviderConfig {
	apiKey: string;
	baseUrl?: string;
	senderId?: string;
}

export class LoopProvider implements PhoneMessagingProvider {
	readonly name = "loop";
	private apiKey: string;
	private baseUrl: string;
	private senderId?: string;

	constructor(config: LoopProviderConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = (config.baseUrl || "https://a.loopmessage.com").replace(/\/$/, "");
		this.senderId = config.senderId;
	}

	async sendMessage(request: PhoneSendRequest): Promise<PhoneSendResult> {
		if (request.attachments?.length) {
			throw new Error("Loop phone messaging does not support local file attachments yet; send a public media URL instead.");
		}

		const providerData = request.channel.providerData || {};
		const groupId = typeof providerData.groupId === "string" ? providerData.groupId : undefined;
		const body: Record<string, unknown> = {
			text: request.text,
			passthrough: JSON.stringify({
				channelId: request.channel.channelId,
				conversationId: request.channel.conversationId,
			}),
		};

		if (groupId) {
			body.group = groupId;
		} else {
			body.contact = request.channel.from;
		}

		const senderId = typeof providerData.senderId === "string" ? providerData.senderId : this.senderId;
		if (senderId) body.sender = senderId;

		const channel = chooseLoopChannel(request.preferredTransport, request.channel.transport);
		if (channel) body.channel = channel;

		const response = await fetch(`${this.baseUrl}/api/v1/message/send/`, {
			method: "POST",
			headers: {
				"Authorization": this.apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		const payload = await response.json().catch(() => ({})) as { message_id?: string; success?: boolean; message?: string; code?: number };
		if (!response.ok || payload.success === false) {
			const reason = payload.message || `HTTP ${response.status}`;
			throw new Error(`Loop send failed: ${reason}${payload.code ? ` (${payload.code})` : ""}`);
		}

		return {
			providerMessageId: payload.message_id || String(Date.now()),
			transport: channel || request.channel.transport,
			status: "accepted",
		};
	}
}

function chooseLoopChannel(preferred: PhoneTransport | "auto" | undefined, current: PhoneTransport): PhoneTransport | undefined {
	const requested = preferred === "auto" || !preferred ? current : preferred;
	if (requested === "imessage" || requested === "sms" || requested === "rcs" || requested === "whatsapp") {
		return requested;
	}
	return undefined;
}
