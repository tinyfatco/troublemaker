import { LocalChatModelGateway } from "./local-chat-model.mjs";
import { requireHostdOpenAiModel } from "./openai-models.mjs";

const MAXIMUM_STREAM_BYTES = 2 * 1024 * 1024;

function inputText(role, text) {
	return {
		role,
		content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
	};
}

function commandInput(mode, body) {
	const command = body.trim().toLowerCase();
	if (command === "/config") {
		return "I entered configuration mode. Help me choose an approved model for this text conversation.";
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

function configPrompt(config, catalog, selectedModel) {
	const current = catalog.find((model) => model.id === selectedModel);
	const choices = catalog
		.map((model) => `- ${model.id} (${model.name}): ${model.about}`)
		.join("\n");
	return [
		"You are Luna, TinyFat's model-selection advisor over SMS.",
		"The only approved chat models are the authenticated local catalog entries below:",
		choices,
		current
			? `The currently selected chat model is ${current.id} (${current.name}).`
			: `The current selection ${selectedModel} is no longer in the catalog; help the person choose a listed model.`,
		"Give concise, accurate advice in plain text suitable for SMS.",
		`Keep the reply within ${config.maximumReplyCharacters} characters.`,
		"Set selected_model only when the person clearly chooses one listed model; otherwise return null.",
		"You have no tools, cannot contact another number or agent, and must not imply that you performed an external action.",
	].join("\n");
}

export class PhoneApiAgent {
	constructor({ config, store, openAiGateway, localChatGateway }) {
		this.config = config;
		this.store = store;
		this.openAiGateway = openAiGateway;
		this.localChatGateway = localChatGateway ?? new LocalChatModelGateway({ config });
	}

	async complete(turn, signal, { providerComplianceRetry = false } = {}) {
		const policy = this.config.phone.apiAgent;
		const target = this.config.targetsById.get(turn.targetId);
		if (!target) throw new Error("phone API turn selected an unavailable agent target");
		const session = this.store.getPhoneApiSession(turn.threadTarget);
		if (!session) throw new Error("phone API session is missing");
		const catalog = await this.localChatGateway.listModels(signal);
		const allowedModels = catalog.map((model) => model.id);
		if (turn.isModeCommand) {
			const selected = catalog.find((model) => model.id === turn.model);
			if (!selected) {
				throw new Error("phone API chat command selected a model outside the authenticated catalog");
			}
			const reply = `Chat mode is on with ${selected.name}.`;
			if (reply.length > policy.maximumReplyCharacters) {
				throw new Error("phone API chat command reply exceeded its character bound");
			}
			return { reply, selectedModel: undefined, allowedModels };
		}
		let output;
		if (turn.mode === "chat") {
			if (!allowedModels.includes(turn.model)) {
				throw new Error("phone API turn selected a model outside the authenticated catalog");
			}
			const history = this.store.listPhoneApiHistory(
				turn.threadTarget,
				turn.modelGeneration,
				policy.maximumHistoryMessages,
			);
			output = await this.localChatGateway.complete(turn.model, [
				...history.map((message) => ({ role: message.role, content: message.body })),
				{ role: "user", content: commandInput(turn.mode, turn.inboundBody) },
				...(providerComplianceRetry ? [{
					role: "user",
					content: "Rewrite your answer to my previous message for carrier-safe SMS. Return only the replacement reply, and do not mention or repeat alcohol, sexual, hateful, firearm, tobacco, or cannabis content.",
				}] : []),
			], signal, { catalog });
		} else if (turn.mode === "config") {
			const model = requireHostdOpenAiModel(turn.model, "phone API advisor model");
			if (model.id !== policy.advisorModel) {
				throw new Error("phone API configuration turn did not use the configured advisor");
			}
			const body = {
				model: model.id,
				input: [
					inputText("developer", configPrompt(policy, catalog, session.selectedModel)),
					inputText("user", commandInput(turn.mode, turn.inboundBody)),
				],
				stream: true,
				store: false,
				prompt_cache_key: "phone-api-agent-v2:config",
				max_output_tokens: policy.maximumOutputTokens,
				reasoning: { effort: model.thinking },
				service_tier: "default",
				tools: [],
				tool_choice: "none",
				parallel_tool_calls: false,
				text: configFormat(allowedModels),
			};
			const response = await this.openAiGateway.completeDirectPhone(
				target,
				turn.contextId,
				turn.model,
				policy.maximumOutputTokens,
				body,
				signal,
			);
			output = await collectOutputText(response);
		} else {
			throw new Error("phone API turn mode is invalid");
		}
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
			if (selectedModel !== undefined && !allowedModels.includes(selectedModel)) {
				throw new Error("phone API configuration response selected an unapproved model");
			}
			if (reply.length > policy.maximumReplyCharacters) {
				throw new Error("phone API configuration reply exceeded its character bound");
			}
			return { reply, selectedModel, allowedModels };
		}
		if (output.length > policy.maximumReplyCharacters) {
			throw new Error("phone API chat reply exceeded its character bound");
		}
		return { reply: output, selectedModel: undefined, allowedModels };
	}
}
