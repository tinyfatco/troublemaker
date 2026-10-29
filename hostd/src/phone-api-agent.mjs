import { requireHostdOpenAiModel } from "./openai-models.mjs";

const MAXIMUM_STREAM_BYTES = 2 * 1024 * 1024;

function inputText(role, text) {
	return {
		role,
		content: [{ type: "input_text", text }],
	};
}

function commandInput(mode, body) {
	const command = body.trim().toLowerCase();
	if (command === "/config") {
		return "I entered configuration mode. Help me choose an approved model for this text conversation.";
	}
	if (command === "/chat") {
		return "I entered chat mode. Briefly confirm that chat mode is active and ask what I want to discuss.";
	}
	return body;
}

async function collectOutputText(response) {
	if (!response.body) throw new Error("phone API model response has no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let output = "";
	let observedBytes = 0;
	let terminal = false;
	let terminalError;
	const consume = (line) => {
		if (!line.startsWith("data:")) return;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return;
		let event;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
			output += event.delta;
		}
		if (["response.completed", "response.incomplete", "response.failed"].includes(event?.type)) {
			terminal = true;
			if (event.type !== "response.completed") terminalError = event.type;
		}
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		observedBytes += value.byteLength;
		if (observedBytes > MAXIMUM_STREAM_BYTES) {
			await reader.cancel("phone API model response exceeded the stream bound");
			throw new Error("phone API model response exceeded the stream bound");
		}
		buffer += decoder.decode(value, { stream: true });
		let newline;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			consume(buffer.slice(0, newline).replace(/\r$/, ""));
			buffer = buffer.slice(newline + 1);
		}
	}
	buffer += decoder.decode();
	for (const line of buffer.split("\n")) consume(line.replace(/\r$/, ""));
	if (!response.ok) throw new Error(`phone API model returned HTTP ${response.status}`);
	if (!terminal || terminalError) {
		throw new Error(terminalError ?? "phone API model response lacked a terminal event");
	}
	if (!output.trim()) throw new Error("phone API model returned no text");
	return output.trim();
}

function configFormat(allowedModels) {
	return {
		format: {
			type: "json_schema",
			name: "phone_model_advice",
			strict: true,
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					reply: { type: "string" },
					selected_model: {
						anyOf: [
							{ type: "string", enum: allowedModels },
							{ type: "null" },
						],
					},
				},
				required: ["reply", "selected_model"],
			},
		},
	};
}

function systemPrompt(config, turn, selectedModel) {
	const allowed = config.allowedModels.join(", ");
	if (turn.mode === "config") {
		return [
			"You are Luna, TinyFat's model-selection advisor over SMS.",
			`The only approved models are: ${allowed}.`,
			`The currently selected chat model is ${selectedModel}.`,
			"Luna is the economical default for normal conversation. Sol is the deeper, more expensive option for work that genuinely benefits from it.",
			"Give concise, accurate advice in plain text suitable for SMS.",
			`Keep the reply within ${config.maximumReplyCharacters} characters.`,
			"Set selected_model only when the person clearly chooses one approved model; otherwise return null.",
			"You have no tools, cannot contact another number or agent, and must not imply that you performed an external action.",
		].join("\n");
	}
	return [
		"You are Luna, a concise conversational agent replying over SMS.",
		`This turn uses the sender's approved model selection: ${turn.model}.`,
		"Stay within the current conversation. You have no tools and cannot contact another number or agent.",
		`Keep the reply within ${config.maximumReplyCharacters} characters.`,
		"Never claim an external action was performed. Keep the reply compact and useful.",
	].join("\n");
}

export class PhoneApiAgent {
	constructor({ config, store, openAiGateway }) {
		this.config = config;
		this.store = store;
		this.openAiGateway = openAiGateway;
	}

	async complete(turn, signal) {
		const policy = this.config.phone.apiAgent;
		if (!policy.allowedModels.includes(turn.model)) {
			throw new Error("phone API turn selected a model outside its allowlist");
		}
		const target = this.config.targetsById.get(turn.targetId);
		if (!target) throw new Error("phone API turn selected an unavailable agent target");
		const session = this.store.getPhoneApiSession(turn.threadTarget);
		if (!session) throw new Error("phone API session is missing");
		const history = this.store.listPhoneApiHistory(
			turn.threadTarget,
			policy.maximumHistoryMessages,
		);
		const model = requireHostdOpenAiModel(turn.model, "phone API turn model");
		const body = {
			model: model.id,
			input: [
				inputText("developer", systemPrompt(policy, turn, session.selectedModel)),
				...history.map((message) => inputText(message.role, message.body)),
				inputText("user", commandInput(turn.mode, turn.inboundBody)),
			],
			stream: true,
			store: false,
			prompt_cache_key: `phone-api-agent-v1:${turn.mode}`,
			max_output_tokens: policy.maximumOutputTokens,
			reasoning: { effort: model.thinking },
			service_tier: "default",
			tools: [],
			tool_choice: "none",
			parallel_tool_calls: false,
			text: turn.mode === "config"
				? configFormat(policy.allowedModels)
				: { format: { type: "text" } },
		};
		const response = await this.openAiGateway.completeDirectPhone(
			target,
			turn.contextId,
			turn.model,
			policy.maximumOutputTokens,
			body,
			signal,
		);
		const output = await collectOutputText(response);
		if (turn.mode === "config") {
			let result;
			try {
				result = JSON.parse(output);
			} catch {
				throw new Error("phone API configuration response was not valid JSON");
			}
			const reply = typeof result?.reply === "string" ? result.reply.trim() : "";
			const selectedModel = result?.selected_model === null
				? undefined
				: result?.selected_model;
			if (!reply) throw new Error("phone API configuration response had no reply");
			if (selectedModel !== undefined && !policy.allowedModels.includes(selectedModel)) {
				throw new Error("phone API configuration response selected an unapproved model");
			}
			if (reply.length > policy.maximumReplyCharacters) {
				throw new Error("phone API configuration reply exceeded its character bound");
			}
			return { reply, selectedModel };
		}
		if (output.length > policy.maximumReplyCharacters) {
			throw new Error("phone API chat reply exceeded its character bound");
		}
		return { reply: output, selectedModel: undefined };
	}
}
