import { LocalChatModelGateway, validateLocalModelCatalog } from "./local-chat-model.mjs";
import { requireHostdOpenAiModel } from "./openai-models.mjs";

const MAXIMUM_STREAM_BYTES = 2 * 1024 * 1024;

function inputText(role, text) {
	return {
		role,
		content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
	};
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

function nudgeFormat() {
	return {
		format: {
			type: "json_schema",
			name: "phone_config_nudge",
			strict: true,
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { reply: { type: "string" } },
				required: ["reply"],
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
		"Hostd already sent the authoritative catalog and current-selection menu.",
		"Use the authenticated choices below only to interpret a fuzzy request:",
		choices,
		current
			? `The committed selection is ${current.id} (${current.name}).`
			: `The committed selection ${selectedModel} is no longer in the catalog.`,
		"Give concise, accurate advice in plain text suitable for SMS.",
		`Keep the reply within ${config.maximumReplyCharacters} characters.`,
		"Set selected_model only when the person clearly chooses one listed model; otherwise return null.",
		"Never render a model menu and never use a '(current)' label.",
		"You have no tools, cannot contact another number or agent, and must not imply that you performed an external action.",
	].join("\n");
}

function nudgePrompt(config, catalog, selectedModel) {
	const current = catalog.find((model) => model.id === selectedModel);
	return [
		"You are Luna sending one optional follow-up after Hostd already sent configuration help.",
		current
			? `The committed selection is ${current.name}.`
			: `The committed selection is ${selectedModel}.`,
		"Return one brief friendly greeting or nudge in plain SMS text.",
		"Do not list models, change a selection, use a '(current)' label, or imply an external action.",
		`Keep the reply within ${Math.min(config.maximumReplyCharacters, 240)} characters.`,
	].join("\n");
}

function exactCatalogMatch(catalog, body) {
	const wanted = body.trim().toLocaleLowerCase("en-US");
	return catalog.find((model) => (
		model.id.toLocaleLowerCase("en-US") === wanted
		|| model.name.toLocaleLowerCase("en-US") === wanted
	));
}

function selectedLabel(catalog, selectedModel) {
	return catalog.find((model) => model.id === selectedModel)?.name ?? selectedModel;
}

function switchReply(catalog, selectedModel) {
	return `Switched to ${selectedLabel(catalog, selectedModel)}. /chat to talk.`;
}

function configHelp(config, catalog, selectedModel) {
	if (!catalog) {
		return `Config mode. Current: ${selectedModel}. Catalog refresh pending. /chat to talk.`;
	}
	const current = selectedLabel(catalog, selectedModel);
	const models = catalog.map((model) => (
		`${model.name}${model.id === selectedModel ? " (current)" : ""}: ${model.about}`
	));
	const reply = [
		`Config mode. Current: ${current}.`,
		"Models:",
		...models,
		"Text a name or id to switch, /chat to talk.",
	].join("\n");
	if (reply.length > config.maximumReplyCharacters) {
		throw new Error("phone API configuration help exceeded its character bound");
	}
	return reply;
}

function cleanAdvisorReply(reply) {
	return reply.replace(/\s*\(current\)/giu, "").trim();
}

function boundedSignal(timeoutMs, signal) {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export class PhoneApiAgent {
	constructor({ config, store, openAiGateway, localChatGateway }) {
		this.config = config;
		this.store = store;
		this.openAiGateway = openAiGateway;
		this.localChatGateway = localChatGateway ?? new LocalChatModelGateway({ config });
		this.pendingCatalogRefresh = null;
	}

	readCachedCatalog() {
		const cached = this.store.getPhoneModelCatalogCache();
		if (!cached) return undefined;
		try {
			const models = validateLocalModelCatalog(
				JSON.parse(cached.catalogJson),
				this.config.phone.apiAgent.localCatalog.maximumModels,
			);
			return {
				models,
				stale: Date.now() - Date.parse(cached.refreshedAt)
					> this.config.phone.apiAgent.catalogTtlSeconds * 1000,
			};
		} catch {
			return undefined;
		}
	}

	async refreshCatalog(signal) {
		const models = await this.localChatGateway.listModels(signal);
		this.store.setPhoneModelCatalogCache(JSON.stringify({ data: models }));
		return models;
	}

	refreshCatalogInBackground() {
		if (this.pendingCatalogRefresh) return;
		this.pendingCatalogRefresh = this.refreshCatalog()
			.catch(() => undefined)
			.finally(() => { this.pendingCatalogRefresh = null; });
	}

	async completeHosted(target, turn, body, signal, { thinkingOverride } = {}) {
		const policy = this.config.phone.apiAgent;
		const model = requireHostdOpenAiModel(turn.model, "phone API advisor model");
		if (model.id !== policy.advisorModel) {
			throw new Error("phone API configuration turn did not use the configured advisor");
		}
		const response = await this.openAiGateway.completeDirectPhone(
			target,
			turn.contextId,
			turn.model,
			body.max_output_tokens,
			body,
			signal,
			{ thinkingOverride },
		);
		return collectOutputText(response);
	}

	async complete(turn, signal, { providerComplianceRetry = false } = {}) {
		const policy = this.config.phone.apiAgent;
		const target = this.config.targetsById.get(turn.targetId);
		if (!target) throw new Error("phone API turn selected an unavailable agent target");
		const session = this.store.getPhoneApiSession(turn.threadTarget);
		if (!session) throw new Error("phone API session is missing");

		const cached = this.readCachedCatalog();
		const isChatModelTurn = turn.mode === "chat" && !turn.isModeCommand;
		if (!isChatModelTurn && (!cached || cached.stale)) this.refreshCatalogInBackground();

		if (turn.isModeCommand) {
			if (turn.mode === "config") {
				return {
					reply: configHelp(policy, cached?.models, session.selectedModel),
					selectedModel: undefined,
					allowedModels: cached?.models.map((model) => model.id) ?? [],
				};
			}
			if (turn.mode === "chat") {
				const catalog = cached?.models;
				const reply = `Chat mode is on with ${catalog ? selectedLabel(catalog, turn.model) : turn.model}.`;
				if (reply.length > policy.maximumReplyCharacters) {
					throw new Error("phone API chat command reply exceeded its character bound");
				}
				return {
					reply,
					selectedModel: undefined,
					allowedModels: catalog?.map((model) => model.id) ?? [turn.model],
				};
			}
			throw new Error("phone API mode command is invalid");
		}

		if (turn.mode === "chat") {
			const catalog = await this.refreshCatalog(signal);
			const allowedModels = catalog.map((model) => model.id);
			if (!allowedModels.includes(turn.model)) {
				throw new Error("phone API turn selected a model outside the authenticated catalog");
			}
			const history = this.store.listPhoneApiHistory(
				turn.threadTarget,
				turn.modelGeneration,
				policy.maximumHistoryMessages,
			);
			const output = await this.localChatGateway.complete(turn.model, [
				...history.map((message) => ({ role: message.role, content: message.body })),
				{ role: "user", content: turn.inboundBody },
				...(providerComplianceRetry ? [{
					role: "user",
					content: "Rewrite your answer to my previous message for carrier-safe SMS. Return only the replacement reply, and do not mention or repeat alcohol, sexual, hateful, firearm, tobacco, or cannabis content.",
				}] : []),
			], signal, { catalog });
			if (output.length > policy.maximumReplyCharacters) {
				throw new Error("phone API chat reply exceeded its character bound");
			}
			return { reply: output, selectedModel: undefined, allowedModels };
		}

		if (turn.mode !== "config") throw new Error("phone API turn mode is invalid");
		const catalog = cached?.models;
		if (!catalog) throw new Error("phone API configuration catalog cache is unavailable");
		const allowedModels = catalog.map((model) => model.id);

		if (turn.isConfigNudge) {
			const model = requireHostdOpenAiModel(turn.model, "phone API advisor model");
			const body = {
				model: model.id,
				input: [
					inputText("developer", nudgePrompt(policy, catalog, session.selectedModel)),
					inputText("user", "Send one brief friendly configuration greeting."),
				],
				stream: true,
				store: false,
				prompt_cache_key: "phone-api-agent-v3:config-nudge",
				max_output_tokens: Math.min(policy.maximumOutputTokens, 128),
				reasoning: { effort: "low" },
				service_tier: "default",
				tools: [],
				tool_choice: "none",
				parallel_tool_calls: false,
				text: nudgeFormat(),
			};
			const output = await this.completeHosted(
				target,
				turn,
				body,
				boundedSignal(policy.configNudgeTimeoutMs, signal),
				{ thinkingOverride: "low" },
			);
			let result;
			try {
				result = JSON.parse(output);
			} catch {
				throw new Error("phone API configuration nudge was not valid JSON");
			}
			const reply = cleanAdvisorReply(typeof result?.reply === "string" ? result.reply : "");
			if (!reply || reply.length > Math.min(policy.maximumReplyCharacters, 240)) {
				throw new Error("phone API configuration nudge was invalid");
			}
			return { reply, selectedModel: undefined, allowedModels };
		}

		const exact = exactCatalogMatch(catalog, turn.inboundBody);
		if (exact) {
			return {
				reply: switchReply(catalog, exact.id),
				selectedModel: exact.id,
				allowedModels,
			};
		}

		const model = requireHostdOpenAiModel(turn.model, "phone API advisor model");
		const body = {
			model: model.id,
			input: [
				inputText("developer", configPrompt(policy, catalog, session.selectedModel)),
				inputText("user", turn.inboundBody),
			],
			stream: true,
			store: false,
			prompt_cache_key: "phone-api-agent-v3:config-fuzzy",
			max_output_tokens: policy.maximumOutputTokens,
			reasoning: { effort: model.thinking },
			service_tier: "default",
			tools: [],
			tool_choice: "none",
			parallel_tool_calls: false,
			text: configFormat(allowedModels),
		};
		const output = await this.completeHosted(target, turn, body, signal);
		let result;
		try {
			result = JSON.parse(output);
		} catch {
			throw new Error("phone API configuration response was not valid JSON");
		}
		const selectedModel = result?.selected_model === null ? undefined : result?.selected_model;
		if (selectedModel !== undefined && !allowedModels.includes(selectedModel)) {
			throw new Error("phone API configuration response selected an unapproved model");
		}
		const advisorReply = cleanAdvisorReply(typeof result?.reply === "string" ? result.reply : "");
		const reply = selectedModel === undefined ? advisorReply : switchReply(catalog, selectedModel);
		if (!reply || reply.length > policy.maximumReplyCharacters) {
			throw new Error("phone API configuration reply was invalid");
		}
		return { reply, selectedModel, allowedModels };
	}
}
