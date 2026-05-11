import { LoopProvider } from "./loop-provider.js";
import { TwilioProvider } from "./twilio-provider.js";
import type { PhoneChannelRecord, PhoneMessagingProvider, PhoneTransport } from "./types.js";

export class PhoneProviderRegistry {
	private providers = new Map<string, PhoneMessagingProvider>();
	private defaultProvider?: string;

	register(provider: PhoneMessagingProvider, makeDefault = false): void {
		this.providers.set(provider.name, provider);
		if (makeDefault || !this.defaultProvider) this.defaultProvider = provider.name;
	}

	get(name: string): PhoneMessagingProvider | undefined {
		return this.providers.get(name);
	}

	available(): string[] {
		return Array.from(this.providers.keys());
	}

	select(record: PhoneChannelRecord, preferredTransport?: PhoneTransport | "auto"): PhoneMessagingProvider {
		if (preferredTransport === "sms") {
			const smsProvider = this.providers.get("twilio") || this.providers.get(record.provider);
			if (smsProvider) return smsProvider;
		}

		const provider = this.providers.get(record.provider) || (this.defaultProvider ? this.providers.get(this.defaultProvider) : undefined);
		if (!provider) {
			throw new Error(`No phone messaging provider configured for ${record.provider}. Available: ${this.available().join(", ") || "none"}`);
		}
		return provider;
	}
}

export function createPhoneProviderRegistryFromEnv(): PhoneProviderRegistry {
	const registry = new PhoneProviderRegistry();
	const preferred = (process.env.MOM_PHONE_DEFAULT_PROVIDER || "").toLowerCase();

	const loopApiKey = process.env.LOOPMESSAGE_API_KEY || process.env.MOM_LOOPMESSAGE_API_KEY;
	if (loopApiKey) {
		registry.register(new LoopProvider({
			apiKey: loopApiKey,
			baseUrl: process.env.LOOPMESSAGE_BASE_URL || process.env.MOM_LOOPMESSAGE_BASE_URL,
			senderId: process.env.LOOPMESSAGE_SENDER_ID || process.env.MOM_LOOPMESSAGE_SENDER_ID,
		}), preferred === "loop");
	}

	const twilioSid = process.env.TWILIO_ACCOUNT_SID || process.env.MOM_TWILIO_ACCOUNT_SID;
	const twilioToken = process.env.TWILIO_AUTH_TOKEN || process.env.MOM_TWILIO_AUTH_TOKEN;
	if (twilioSid && twilioToken) {
		registry.register(new TwilioProvider({
			accountSid: twilioSid,
			authToken: twilioToken,
			fromNumber: process.env.TWILIO_PHONE_NUMBER || process.env.MOM_TWILIO_PHONE_NUMBER,
			messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.MOM_TWILIO_MESSAGING_SERVICE_SID,
		}), preferred === "twilio");
	}

	return registry;
}
