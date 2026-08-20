export type PhoneTransport = "imessage" | "sms" | "mms" | "rcs" | "whatsapp" | "unknown";
export type PhoneMessageDirection = "inbound" | "outbound";
export type PhoneMessageStatus = "received" | "sent" | "queued" | "failed" | "rejected" | "delivered" | "read";

export interface PhoneAttachment {
	filename?: string;
	content_type?: string;
	url?: string;
	content?: string;
}

export interface PhoneInboundPayload {
	provider: string;
	hostManaged?: boolean;
	transport?: PhoneTransport;
	direction?: PhoneMessageDirection;
	status?: PhoneMessageStatus;
	messageId: string;
	conversationId?: string;
	from: string;
	to?: string;
	sender?: string;
	recipients?: string[];
	text: string;
	attachments?: PhoneAttachment[];
	timestamp?: string;
	replyToId?: string;
	providerData?: Record<string, unknown>;
	channelId?: string;
	displayName?: string;
	hostContextId?: string;
	deliveryId?: string;
	operatorIntent?: string;
	hostReceipt?: {
		url: string;
		token: string;
		leaseToken: string;
	};
}

export interface PhoneChannelRecord {
	channelId: string;
	provider: string;
	transport: PhoneTransport;
	conversationId: string;
	from: string;
	sender: string;
	participants: string[];
	outboundRecipients?: string[];
	displayName: string;
	lastMessageId?: string;
	updatedAt: string;
	providerData?: Record<string, unknown>;
	hostManaged?: boolean;
	hostContextId?: string;
	deliveryId?: string;
}

export interface PhoneOutboundAttachment {
	filePath: string;
	filename: string;
}

export interface PhoneSendRequest {
	channel: PhoneChannelRecord;
	text: string;
	attachments?: PhoneOutboundAttachment[];
	preferredTransport?: PhoneTransport | "auto";
	replyToId?: string;
}

export interface PhoneSendResult {
	providerMessageId: string;
	transport?: PhoneTransport;
	status?: string;
}

export interface PhoneMessagingProvider {
	readonly name: string;
	sendMessage(request: PhoneSendRequest): Promise<PhoneSendResult>;
}
