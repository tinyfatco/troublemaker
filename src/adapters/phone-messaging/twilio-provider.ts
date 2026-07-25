import type { PhoneMessagingProvider, PhoneSendRequest, PhoneSendResult } from "./types.js";

export interface TwilioProviderConfig {
	accountSid: string;
	authToken: string;
	fromNumber?: string;
	messagingServiceSid?: string;
}

export class TwilioProvider implements PhoneMessagingProvider {
	readonly name = "twilio";
	private accountSid: string;
	private authToken: string;
	private fromNumber?: string;
	private messagingServiceSid?: string;

	constructor(config: TwilioProviderConfig) {
		this.accountSid = config.accountSid;
		this.authToken = config.authToken;
		this.fromNumber = config.fromNumber;
		this.messagingServiceSid = config.messagingServiceSid;
	}

	async sendMessage(request: PhoneSendRequest): Promise<PhoneSendResult> {
		if (request.attachments?.length) {
			throw new Error("Twilio phone messaging does not support local file attachments yet; send a public media URL instead.");
		}

		const params = new URLSearchParams();
		params.set("Body", request.text);

		const providerData = request.channel.providerData || {};
		const from = typeof providerData.twilioFrom === "string" ? providerData.twilioFrom : (request.channel.sender || this.fromNumber);
		const serviceSid = typeof providerData.messagingServiceSid === "string" ? providerData.messagingServiceSid : this.messagingServiceSid;
		const recipients = outboundRecipientsFor(request.channel, from);
		params.set("To", recipients[0]);
		recipients.slice(1).forEach((recipient, index) => {
			params.set(`OtherRecipients${index}`, recipient);
		});

		if (serviceSid) {
			params.set("MessagingServiceSid", serviceSid);
		} else if (from) {
			params.set("From", from);
		} else {
			throw new Error("Twilio send requires From or MessagingServiceSid");
		}

		const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
		const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
			method: "POST",
			headers: {
				"Authorization": `Basic ${auth}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params,
		});

		const payload = await response.json().catch(() => ({})) as { sid?: string; status?: string; message?: string };
		if (!response.ok) {
			throw new Error(`Twilio send failed: ${payload.message || `HTTP ${response.status}`}`);
		}

		return {
			providerMessageId: payload.sid || String(Date.now()),
			transport: recipients.length > 1 || request.channel.transport === "mms" ? "mms" : "sms",
			status: payload.status || "accepted",
		};
	}
}

function outboundRecipientsFor(channel: PhoneSendRequest["channel"], fromAddress: string | undefined): string[] {
	const ownAddresses = new Set([channel.sender, fromAddress].filter((value): value is string => Boolean(value)).map(normalizePhoneAddress));
	const candidates = channel.outboundRecipients?.length
		? channel.outboundRecipients
		: [channel.from];
	const recipients = Array.from(new Set(candidates.map(normalizePhoneAddress).filter(Boolean)))
		.filter((recipient) => !ownAddresses.has(recipient));
	if (recipients.length === 0) {
		throw new Error("Twilio send requires at least one non-sender recipient");
	}
	return recipients;
}

function normalizePhoneAddress(value: string): string {
	return value.trim().toLowerCase();
}
