import type {
	PhoneMessagingProvider,
	PhoneSendRequest,
	PhoneSendResult,
	PhoneTransport,
} from "./types.js";

export interface ManagedPhoneProviderConfig {
	endpoint: string;
	token: string;
	providerName?: string;
}

interface ManagedPhoneSendResponse {
	ok?: boolean;
	messageId?: string;
	providerMessageId?: string;
	transport?: PhoneTransport;
	status?: string;
	error?: string;
	error_description?: string;
}

/**
 * Sends through a platform-owned bridge so resident hosts do not need broad
 * carrier credentials. The bridge remains responsible for sender ownership,
 * recipient policy, opt-outs, and provider delivery.
 */
export class ManagedPhoneProvider implements PhoneMessagingProvider {
	readonly name: string;
	private readonly endpoint: string;
	private readonly token: string;

	constructor(config: ManagedPhoneProviderConfig) {
		this.endpoint = config.endpoint.trim();
		this.token = config.token.trim();
		this.name = config.providerName?.trim().toLowerCase() || "managed";
		if (!this.endpoint) throw new Error("ManagedPhoneProvider: endpoint is required");
		if (!this.token) throw new Error("ManagedPhoneProvider: token is required");
		if (!this.name) throw new Error("ManagedPhoneProvider: providerName is required");
	}

	async sendMessage(request: PhoneSendRequest): Promise<PhoneSendResult> {
		if (request.attachments?.length) {
			throw new Error("Managed phone delivery does not support local attachments");
		}

		const recipients = request.channel.outboundRecipients?.length
			? request.channel.outboundRecipients
			: [request.channel.from].filter(Boolean);
		if (recipients.length === 0) {
			throw new Error("Managed phone delivery requires an inbound recipient");
		}

		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider: request.channel.provider,
				transport: request.preferredTransport === "auto"
					? request.channel.transport
					: request.preferredTransport || request.channel.transport,
				threadTarget: request.channel.channelId,
				conversationId: request.channel.conversationId,
				from: request.channel.sender,
				to: recipients[0],
				recipients,
				body: request.text,
				providerData: request.channel.providerData,
			}),
		});

		const text = await response.text();
		let payload: ManagedPhoneSendResponse = {};
		try {
			payload = text ? JSON.parse(text) as ManagedPhoneSendResponse : {};
		} catch {
			// Preserve the HTTP status below without echoing arbitrary response HTML.
		}
		if (!response.ok || !payload.ok) {
			throw new Error(payload.error_description || payload.error || `Managed phone delivery failed with HTTP ${response.status}`);
		}

		const providerMessageId = payload.providerMessageId || payload.messageId;
		if (!providerMessageId) throw new Error("Managed phone delivery response is missing a message id");
		return {
			providerMessageId,
			transport: payload.transport || request.channel.transport,
			status: payload.status,
		};
	}
}
