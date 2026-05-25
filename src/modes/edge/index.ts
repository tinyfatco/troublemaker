import { getModel, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RuntimeEventSink, WebTurnInput, WebTurnSettings } from "../../core/runtime-contract.js";
import { normalizeThinkingLevelForModel } from "../../model-thinking.js";
import type { EdgeHostBridge } from "./host-bridge.js";
import { createEdgeAgentSession } from "./pi-session.js";
import { createEdgeBashTool } from "./tools.js";

export interface EdgeWebChatOptions {
	input: WebTurnInput;
	history?: AgentMessage[];
	promptMessage?: AgentMessage;
	settings?: WebTurnSettings;
	modelApiKey: string;
	modelBaseUrl?: string;
	hostBridge: EdgeHostBridge;
	emit: RuntimeEventSink;
}

export interface EdgeWebChatResult {
	messages: AgentMessage[];
	newMessages: AgentMessage[];
}

const DEFAULT_SYSTEM_PROMPT = `You are Troublemaker, a practical AI agent running in TinyFat's hosted web console.

You can answer directly for ordinary conversation. Use the bash tool only when shell access, repository inspection, or local execution is required. In edge mode bash wakes the host container, so batch related shell work thoughtfully.`;

const DEFAULT_EDGE_FIREWORKS_MODEL_ID = "accounts/fireworks/models/glm-5p1";

function createFireworksModel(settings: WebTurnSettings = {}, baseUrl = "https://tinyfat.com/api/fireworks"): Model<Api> {
	const modelId = settings.modelId || DEFAULT_EDGE_FIREWORKS_MODEL_ID;
	const model = getModel("fireworks" as any, modelId as any);
	if (!model) {
		throw new Error(`Fireworks model not found: ${modelId}`);
	}
	return { ...model, baseUrl };
}

export async function runEdgeWebChat(options: EdgeWebChatOptions): Promise<EdgeWebChatResult> {
	await options.emit({ type: "status", status: "accepted", message: "Edge turn accepted", mode: "edge" });

	const model = createFireworksModel(options.settings, options.modelBaseUrl);
	const agent = createEdgeAgentSession({
		systemPrompt: options.settings?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
		model,
		apiKey: options.modelApiKey,
		thinkingLevel: normalizeThinkingLevelForModel(model, options.settings?.thinkingLevel),
		sessionId: options.input.channelId,
		initialMessages: options.history,
		tools: [createEdgeBashTool(options.hostBridge, options.emit)],
		emit: options.emit,
	});

	const initialMessageCount = agent.state.messages.length;
	const promptMessage = options.promptMessage ?? options.input.message;
	await options.emit({ type: "status", status: "connecting", message: "Edge runtime ready", mode: "edge" });
	if (typeof promptMessage === "string") {
		await agent.prompt(promptMessage);
	} else {
		await agent.prompt(promptMessage);
	}
	await agent.waitForIdle();
	await options.emit({ type: "run_complete", channelId: options.input.channelId, mode: "edge" });

	const messages = agent.state.messages.slice();
	return {
		messages,
		newMessages: messages.slice(initialMessageCount),
	};
}

export type { AgentMessage as EdgeAgentMessage };
