import { createHash, randomUUID } from "node:crypto";
import type {
	PhoneMessagingProvider,
	PhoneSendRequest,
	PhoneSendResult,
} from "./types.js";

interface HostManagedPhoneProviderConfig {
	endpoint: string;
	token: string;
	contextId: string;
}

interface HostManagedResponse {
	ok?: boolean;
	messageId?: string;
	status?: string;
	error?: string;
}

export class HostManagedPhoneProvider implements PhoneMessagingProvider {
	readonly name = "hostd";
	private readonly endpoint: string;
	private readonly token: string;
	private readonly contextId: string;

	constructor(config: HostManagedPhoneProviderConfig) {
		this.endpoint = config.endpoint.trim();
		this.token = config.token.trim();
		this.contextId = config.contextId.trim();
		if (!this.endpoint || !this.token || !this.contextId) {
			throw new Error("HostManagedPhoneProvider requires endpoint, token, and contextId");
		}
	}

	async sendMessage(request: PhoneSendRequest): Promise<PhoneSendResult> {
		if (!request.channel.hostManaged || request.channel.hostContextId !== this.contextId) {
			throw new Error("Host-managed phone channel is outside this runtime context");
		}
		if (request.attachments?.length) {
			throw new Error("Host-managed phone delivery supports direct text messages only");
		}
		const digest = createHash("sha256").update(request.text, "utf8").digest("hex").slice(0, 24);
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				context_id: this.contextId,
				thread_target: request.channel.channelId,
				agent_body: request.text,
				idempotency_key: `${this.contextId}:${randomUUID()}:${digest}`,
			}),
			signal: AbortSignal.timeout(35_000),
		});
		const responseText = await response.text();
		let result: HostManagedResponse = {};
		try {
			result = responseText ? JSON.parse(responseText) as HostManagedResponse : {};
		} catch {
			// Keep arbitrary gateway response text out of the model-visible error.
		}
		if (!response.ok || !result.ok) {
			throw new Error(result.error || `Host-managed phone delivery failed with HTTP ${response.status}`);
		}
		if (!result.messageId) throw new Error("Host-managed phone delivery response lacks a message id");
		return {
			providerMessageId: result.messageId,
			transport: "sms",
			status: result.status,
		};
	}
}
