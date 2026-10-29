const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/u;

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

function parseJson(body, code, message) {
	try {
		return JSON.parse(body);
	} catch {
		throw new LocalChatModelError(code, message);
	}
}

function requestSignal(timeoutMs, signal) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function validateCatalog(raw, maximumModels) {
	if (!Array.isArray(raw?.data) || raw.data.length === 0 || raw.data.length > maximumModels) {
		throw new LocalChatModelError("local_model_catalog_invalid", "local model catalog has an invalid size");
	}
	const models = raw.data.map((entry) => {
		const id = typeof entry?.id === "string" ? entry.id.trim().toLowerCase() : "";
		const name = typeof entry?.name === "string" ? entry.name.trim() : "";
		const about = typeof entry?.about === "string" ? entry.about.trim() : "";
		if (!MODEL_ID.test(id) || !name || name.length > 80 || CONTROL.test(name)
			|| !about || about.length > 500 || CONTROL.test(about)) {
			throw new LocalChatModelError("local_model_catalog_invalid", "local model catalog entry is invalid");
		}
		return Object.freeze({ id, name, about });
	});
	if (new Set(models.map((model) => model.id)).size !== models.length) {
		throw new LocalChatModelError("local_model_catalog_invalid", "local model catalog repeats an ID");
	}
	return Object.freeze(models);
}

export class LocalChatModelGateway {
	constructor({ config, fetchImpl = globalThis.fetch }) {
		this.catalogConfig = config.phone?.apiAgent?.localCatalog;
		this.fetch = fetchImpl;
	}

	async listModels(signal) {
		const catalog = this.catalogConfig;
		if (!catalog) throw new LocalChatModelError("local_model_catalog_denied", "local model catalog is not configured");
		const combinedSignal = requestSignal(catalog.requestTimeoutMs, signal);
		let response;
		try {
			response = await this.fetch(`${catalog.baseUrl}/models`, {
				headers: { authorization: `Bearer ${catalog.apiKey}` },
				signal: combinedSignal,
			});
		} catch {
			throw new LocalChatModelError(
				"local_model_result_uncertain",
				combinedSignal.aborted
					? "local model catalog request timed out"
					: "local model catalog request failed before a definitive response",
			);
		}
		const responseBody = await boundedText(response, catalog.maximumCatalogBytes);
		if (!response.ok) {
			throw new LocalChatModelError(
				"local_model_catalog_rejected",
				`local model catalog returned HTTP ${response.status}`,
			);
		}
		return validateCatalog(
			parseJson(responseBody, "local_model_catalog_invalid", "local model catalog was not JSON"),
			catalog.maximumModels,
		);
	}

	async complete(modelId, messages, signal, { catalog: suppliedCatalog } = {}) {
		const policy = this.catalogConfig;
		if (!policy) throw new LocalChatModelError("local_model_denied", "local model catalog is not configured");
		if (!Array.isArray(messages) || messages.length === 0
			|| messages.some((message) => !["user", "assistant"].includes(message?.role)
				|| typeof message?.content !== "string" || !message.content.trim())) {
			throw new LocalChatModelError(
				"local_model_input_invalid",
				"local model messages must contain only user and assistant text",
			);
		}
		const catalog = suppliedCatalog ?? await this.listModels(signal);
		if (!catalog.some((model) => model.id === modelId)) {
			throw new LocalChatModelError("local_model_denied", "local model is absent from the authenticated catalog");
		}
		const body = JSON.stringify({
			model: modelId,
			messages,
			stream: false,
			max_tokens: policy.maximumOutputTokens,
			repetition_penalty: policy.repetitionPenalty,
		});
		if (Buffer.byteLength(body, "utf8") > policy.maximumRequestBytes) {
			throw new LocalChatModelError(
				"local_model_request_too_large",
				"local model request exceeded its byte bound",
			);
		}
		const combinedSignal = requestSignal(policy.requestTimeoutMs, signal);
		let response;
		try {
			response = await this.fetch(`${policy.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${policy.apiKey}`,
					"content-type": "application/json",
				},
				body,
				signal: combinedSignal,
			});
		} catch {
			throw new LocalChatModelError(
				"local_model_result_uncertain",
				combinedSignal.aborted
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
		const parsed = parseJson(
			responseBody,
			"local_model_response_invalid",
			"local model response was not JSON",
		);
		if (parsed?.model !== modelId) {
			throw new LocalChatModelError("local_model_identity_mismatch", "local model response identity did not match");
		}
		const content = parsed?.choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim()) {
			throw new LocalChatModelError("local_model_response_invalid", "local model response had no text");
		}
		return content.trim();
	}
}
