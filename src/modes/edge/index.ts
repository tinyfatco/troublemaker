import { getModel, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RuntimeEventSink, WebTurnInput, WebTurnProjectContext, WebTurnSettings } from "../../core/runtime-contract.js";
import { normalizeThinkingLevelForModel } from "../../model-thinking.js";
import type { EdgeManagedProjectBridge, EdgeHostBridge } from "./host-bridge.js";
import { createEdgeAgentSession } from "./pi-session.js";
import { createEdgeBashTool, createEdgeDeployPreviewTool } from "./tools.js";

export interface EdgeWebChatOptions {
	input: WebTurnInput;
	history?: AgentMessage[];
	promptMessage?: AgentMessage;
	settings?: WebTurnSettings;
	modelApiKey: string;
	modelBaseUrl?: string;
	hostBridge?: EdgeHostBridge;
	managedProjectBridge?: EdgeManagedProjectBridge;
	emit: RuntimeEventSink;
}

export interface EdgeWebChatResult {
	messages: AgentMessage[];
	newMessages: AgentMessage[];
}

const DEFAULT_SYSTEM_PROMPT = `You are Troublemaker, a practical AI agent running in TinyFat's hosted web console.

You can answer directly for ordinary conversation. Use the bash tool only when shell access, repository inspection, or local execution is required. In edge mode bash wakes the host container, so batch related shell work thoughtfully.`;

const DEFAULT_NO_HOST_SYSTEM_PROMPT = `You are Troublemaker, a practical AI agent running as a TinyFat Tiny Agent.

You can answer directly for ordinary conversation, help the user get oriented, create static website drafts, and deploy managed TinyFat website previews when the deploy_preview tool is available. This plan is edge-backed only: do not claim shell access, container access, email access, arbitrary file access, or command-line tools. If asked to run commands, inspect a repository, read local files, execute bash, or report command output, say you cannot execute hosted/container tools on this plan and offer a command, checklist, managed preview deploy, or upgrade path instead. Never invent command output or imply that a command ran. If the user needs email, public forms, custom domains, or hosted execution, explain that those unlock on paid TinyFat plans.`;

const DEFAULT_EDGE_FIREWORKS_MODEL_ID = "accounts/fireworks/models/minimax-m2p7";

function createFireworksModel(settings: WebTurnSettings = {}, baseUrl = "https://tinyfat.com/api/fireworks"): Model<Api> {
	const modelId = settings.modelId || DEFAULT_EDGE_FIREWORKS_MODEL_ID;
	const model = getModel("fireworks" as any, modelId as any);
	if (!model) {
		throw new Error(`Fireworks model not found: ${modelId}`);
	}
	return { ...model, baseUrl };
}

function projectPrompt(project: WebTurnProjectContext | undefined, deployAvailable: boolean): string {
	if (!project) return "";

	const lines = [
		"",
		"Current TinyFat website project:",
		`- Name: ${project.displayName || project.slug}`,
		`- Slug: ${project.slug}`,
	];
	if (project.previewUrl) lines.push(`- Preview URL: ${project.previewUrl}`);
	if (project.productionUrl) lines.push(`- Production URL: ${project.productionUrl}`);
	if (project.state) lines.push(`- Project state: ${project.state}`);

	if (deployAvailable) {
		lines.push(
			"",
			"When the user asks to create, update, publish, or deploy this website preview, generate a complete static HTML document and call deploy_preview. The deploy_preview tool publishes index.html to the managed preview URL. After the tool succeeds, give the user the URL and a concise summary of what changed.",
		);
	} else {
		lines.push(
			"",
			"You can discuss this selected project, but no managed deploy tool is currently available in this turn.",
		);
	}

	return lines.join("\n");
}

function systemPromptFor(options: EdgeWebChatOptions): string {
	const base = options.settings?.systemPrompt || (options.hostBridge ? DEFAULT_SYSTEM_PROMPT : DEFAULT_NO_HOST_SYSTEM_PROMPT);
	const project = projectPrompt(options.input.project, !!options.managedProjectBridge);
	return project ? `${base}\n${project}` : base;
}

export async function runEdgeWebChat(options: EdgeWebChatOptions): Promise<EdgeWebChatResult> {
	await options.emit({ type: "status", status: "accepted", message: "Edge turn accepted", mode: "edge" });

	const model = createFireworksModel(options.settings, options.modelBaseUrl);
	const tools = [
		...(options.hostBridge ? [createEdgeBashTool(options.hostBridge, options.emit)] : []),
		...(options.input.project && options.managedProjectBridge
			? [createEdgeDeployPreviewTool(options.input.project, options.managedProjectBridge)]
			: []),
	];
	const agent = createEdgeAgentSession({
		systemPrompt: systemPromptFor(options),
		model,
		apiKey: options.modelApiKey,
		thinkingLevel: normalizeThinkingLevelForModel(model, options.settings?.thinkingLevel),
		sessionId: options.input.channelId,
		initialMessages: options.history,
		tools,
		terminalToolNames: options.input.project && options.managedProjectBridge ? ["deploy_preview"] : [],
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
