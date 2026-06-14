import { getModel, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ChannelInfo, UserInfo } from "../../adapters/types.js";
import type { VerbosityLevel } from "../../context.js";
import type { RuntimeEventSink, WebTurnInput, WebTurnProjectContext, WebTurnSettings } from "../../core/runtime-contract.js";
import { normalizeThinkingLevelForModel } from "../../model-thinking.js";
import type { EdgeManagedProjectBridge, EdgeHostBridge, EdgeWorkspaceBridge } from "./host-bridge.js";
import { createEdgeAgentSession } from "./pi-session.js";
import { createTroublemakerEdgeTurn } from "./troublemaker-extension.js";
import {
	createEdgeBashTool,
	createEdgeDeployPreviewTool,
	createEdgeEditFileTool,
	createEdgeReadFileTool,
	createEdgeWriteFileTool,
} from "./tools.js";

export interface EdgeWebChatOptions {
	input: WebTurnInput;
	history?: AgentMessage[];
	promptMessage?: AgentMessage;
	settings?: WebTurnSettings;
	modelApiKey: string;
	modelBaseUrl?: string;
	hostBridge?: EdgeHostBridge;
	workspaceBridge?: EdgeWorkspaceBridge;
	managedProjectBridge?: EdgeManagedProjectBridge;
	workspacePath?: string;
	workspaceContext?: string;
	channels?: ChannelInfo[];
	users?: UserInfo[];
	skills?: Skill[];
	channelName?: string;
	verbosity?: VerbosityLevel;
	surface?: "web" | "email";
	emitRunComplete?: boolean;
	emit: RuntimeEventSink;
}

export interface EdgeWebChatResult {
	messages: AgentMessage[];
	newMessages: AgentMessage[];
}

const DEFAULT_SYSTEM_PROMPT = `You are Troublemaker, a practical AI agent running in TinyFat's hosted web console.

You can answer directly for ordinary conversation. Use the bash tool only when shell access, repository inspection, or local execution is required. In edge mode bash wakes the host container, so batch related shell work thoughtfully.`;

const DEFAULT_NO_HOST_SYSTEM_PROMPT = `You are Troublemaker, a practical AI agent running as a TinyFat Tiny Agent.

You can answer directly for ordinary conversation, help the user get oriented, create static website drafts, keep concise notes, and deploy managed TinyFat website previews when the deploy_preview tool is available. This plan is edge-backed only: do not claim shell access, container access, command-line execution, hosted MCP tools, background scheduling, or long-running jobs. You may read, write, and edit files only through the edge-native workspace tools when they are available; those tools operate on the agent's encrypted TinyFat workspace, not a Linux container. If asked to run commands, inspect a repository through shell, execute bash, or report command output, say you cannot execute hosted/container tools on this plan and offer a command, checklist, managed preview deploy, or upgrade path instead. Never invent command output or imply that a command ran. If the user needs hosted execution, browser automation, scheduled work, or arbitrary MCP tools, explain that those unlock on the TinyFat Agent plan.`;

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

function workspacePrompt(options: EdgeWebChatOptions): string {
	const lines: string[] = [];
	const workspacePath = options.workspacePath || "/data";
	if (options.workspaceBridge) {
		lines.push(
			"",
			`Encrypted workspace: ${workspacePath}`,
			"- Use read, write, and edit for workspace text files when that helps the user.",
			"- Paths are relative to the workspace root; never use absolute paths or parent-directory traversal.",
			"- Treat BOOTSTRAP.md and AGENTS.md as durable instructions when they are present.",
		);
	}
	return lines.join("\n");
}

function surfacePrompt(options: EdgeWebChatOptions): string {
	if (options.surface !== "email") return "";
	const channel = options.channelName || options.input.channelId;
	return [
		"",
		`Current surface: Email (${channel})`,
		"Reply in clear, human email prose. Do not mention internal runtime details, tool calls, JSON, or logs unless the user explicitly asks.",
		"When the sender is asking for setup help or says hello, begin a light onboarding flow using the loaded workspace context.",
	].join("\n");
}

function systemPromptFor(options: EdgeWebChatOptions): string {
	const base = options.settings?.systemPrompt || (options.hostBridge ? DEFAULT_SYSTEM_PROMPT : DEFAULT_NO_HOST_SYSTEM_PROMPT);
	const project = projectPrompt(options.input.project, !!options.managedProjectBridge);
	const workspace = workspacePrompt(options);
	const surface = surfacePrompt(options);
	return `${base}${workspace}${project}${surface}`;
}

export function createEdgeWebChatTools(
	options: Pick<EdgeWebChatOptions, "hostBridge" | "input" | "managedProjectBridge" | "workspaceBridge" | "emit">,
): AgentTool<any>[] {
	return [
		...(options.hostBridge ? [createEdgeBashTool(options.hostBridge, options.emit)] : []),
		...(options.workspaceBridge
			? [
				createEdgeReadFileTool(options.workspaceBridge),
				createEdgeWriteFileTool(options.workspaceBridge),
				createEdgeEditFileTool(options.workspaceBridge),
			]
			: []),
		...(options.input.project && options.managedProjectBridge
			? [createEdgeDeployPreviewTool(options.input.project, options.managedProjectBridge)]
			: []),
	];
}

export async function runEdgeWebChat(options: EdgeWebChatOptions): Promise<EdgeWebChatResult> {
	await options.emit({ type: "status", status: "accepted", message: "Edge turn accepted", mode: "edge" });

	const model = createFireworksModel(options.settings, options.modelBaseUrl);
	const tools = createEdgeWebChatTools(options);
	const turn = createTroublemakerEdgeTurn(options.input, {
		systemPrompt: systemPromptFor(options),
		workspaceContext: options.workspaceContext,
		channels: options.channels,
		users: options.users,
		skills: options.skills,
		channelName: options.channelName,
		verbosity: options.verbosity,
	});
	const agent = createEdgeAgentSession({
		systemPrompt: turn.systemPrompt,
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
	const promptMessage = options.promptMessage ?? turn.promptMessage;
	await options.emit({ type: "status", status: "connecting", message: "Edge runtime ready", mode: "edge" });
	if (typeof promptMessage === "string") {
		await agent.prompt(promptMessage);
	} else {
		await agent.prompt(promptMessage);
	}
	await agent.waitForIdle();
	if (options.emitRunComplete !== false) {
		await options.emit({ type: "run_complete", channelId: options.input.channelId, mode: "edge" });
	}

	const messages = agent.state.messages.slice();
	return {
		messages,
		newMessages: messages.slice(initialMessageCount),
	};
}

export type { AgentMessage as EdgeAgentMessage };
