const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

export class LocalChatModelError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "LocalChatModelError";
		this.code = code;
	}
}

async function boundedText(response, maximumBytes = MAXIMUM_RESPONSE_BYTES) {
	if (!response.body) throw new LocalChatModelError("local_model_response_invalid", "local model response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let body = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > maximumBytes) {
			await reader.cancel("local model response exceeded its byte bound");
			throw new LocalChatModelError(
				"local_model_response_too_large",
				"local model response exceeded its byte bound",
			);
		}
		body += decoder.decode(value, { stream: true });
	}
	body += decoder.decode();
	return body;
}

export class LocalChatModelGateway {
	constructor({ config, fetchImpl = globalThis.fetch }) {
		this.models = new Map(
			(config.phone?.apiAgent?.localModels ?? []).map((model) => [model.id, model]),
		);
		this.fetch = fetchImpl;
	}

	has(modelId) {
		return this.models.has(modelId);
	}

	describe(modelId) {
		const model = this.models.get(modelId);
		return model ? { id: model.id, displayName: model.displayName } : undefined;
	}

	async complete(modelId, messages, signal) {
		const model = this.models.get(modelId);
		if (!model) throw new LocalChatModelError("local_model_denied", "local model is not approved");
		if (!Array.isArray(messages) || messages.length === 0) {
			throw new LocalChatModelError("local_model_input_invalid", "local model messages are required");
		}
		const body = JSON.stringify({
			model: model.providerModel,
			messages,
			stream: false,
			max_tokens: model.maximumOutputTokens,
			repetition_penalty: model.repetitionPenalty,
		});
		if (Buffer.byteLength(body, "utf8") > model.maximumRequestBytes) {
			throw new LocalChatModelError(
				"local_model_request_too_large",
				"local model request exceeded its byte bound",
			);
		}
		const timeoutSignal = AbortSignal.timeout(model.requestTimeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let response;
		try {
			response = await this.fetch(`${model.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${model.apiKey}`,
					"content-type": "application/json",
				},
				body,
				signal: requestSignal,
			});
		} catch {
			throw new LocalChatModelError(
				"local_model_result_uncertain",
				requestSignal.aborted
					? "local model request timed out"
					: "local model request failed before a definitive response",
			);
		}
		const responseBody = await boundedText(response);
		if (!response.ok) {
			throw new LocalChatModelError(
				"local_model_rejected",
				`local model gateway returned HTTP ${response.status}`,
			);
		}
		let parsed;
		try {
			parsed = JSON.parse(responseBody);
		} catch {
			throw new LocalChatModelError("local_model_response_invalid", "local model response was not JSON");
		}
		if (parsed?.model !== model.providerModel) {
			throw new LocalChatModelError("local_model_identity_mismatch", "local model response identity did not match");
		}
		const content = parsed?.choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim()) {
			throw new LocalChatModelError("local_model_response_invalid", "local model response had no text");
		}
		return content.trim();
	}
}
