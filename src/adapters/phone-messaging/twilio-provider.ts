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
		params.set("To", request.channel.from);
		params.set("Body", request.text);

		const providerData = request.channel.providerData || {};
		const from = typeof providerData.twilioFrom === "string" ? providerData.twilioFrom : (request.channel.sender || this.fromNumber);
		const serviceSid = typeof providerData.messagingServiceSid === "string" ? providerData.messagingServiceSid : this.messagingServiceSid;

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
			transport: "sms",
			status: payload.status || "accepted",
		};
	}
}
