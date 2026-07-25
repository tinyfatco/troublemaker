import type { WorkingOutputTarget } from "../context.js";
import type { ChannelStore } from "../store.js";
import { createTwoMessageContext } from "./context.js";
import type {
	ChannelInfo,
	MomContext,
	MomEvent,
	UserInfo,
	WorkingOutputContextOptions,
} from "./types.js";

/**
 * Workspace-neutral behavior for TinyFat's internal customer collaboration
 * surfaces. Mattermost and Rocket.Chat provide these primitives; this module
 * owns the product semantics layered on top of them.
 */
export interface WorkspaceChannelTransport {
	readonly platform: string;
	readonly maxMessageLength: number;
	readonly formatStatus?: (text: string) => string;
	assertWorkingTarget(target: WorkingOutputTarget): void;
	postMessage(channel: string, text: string): Promise<string>;
	updateMessage(channel: string, id: string, text: string): Promise<void>;
	deleteMessage(channel: string, id: string): Promise<void>;
	postInThread(channel: string, rootId: string, text: string): Promise<string>;
	uploadFile(channel: string, filePath: string, title?: string, rootId?: string): Promise<void>;
	logBotResponse(channel: string, text: string, id: string, metadata: { threadTs?: string }): void;
	getUser(userId: string): UserInfo | undefined;
	getChannel(channelId: string): ChannelInfo | undefined;
	getAllUsers(): UserInfo[];
	getAllChannels(): ChannelInfo[];
	describeReplyTarget(channelId: string, rootId?: string): string;
}

export function createWorkspaceWorkingOutputContext(
	transport: WorkspaceChannelTransport,
	target: WorkingOutputTarget,
	_store: ChannelStore,
	options: WorkingOutputContextOptions,
): MomContext {
	transport.assertWorkingTarget(target);
	const event: MomEvent = {
		type: "mention",
		channel: target.channelId,
		ts: `working-${Date.now()}`,
		user: "system",
		text: "",
		directlyAddressed: false,
		replyTarget: `${transport.platform}:${target.channelId}`,
		replyTargetDescription: transport.describeReplyTarget(target.channelId),
		attachments: [],
	};
	const context = createTwoMessageContext(
		{
			post: (channel, text) => transport.postMessage(channel, text),
			update: (channel, id, text) => transport.updateMessage(channel, id, text),
			delete: (channel, id) => transport.deleteMessage(channel, id),
			formatStatus: transport.formatStatus ?? ((text) => `_${text}_`),
			throttleMs: 0,
			maxLength: transport.maxMessageLength,
		},
		{
			headerLine: "",
			event,
			channels: transport.getAllChannels(),
			users: transport.getAllUsers(),
			channelName: transport.getChannel(target.channelId)?.name,
			verbose: "messages-only",
			toolStreaming: options.toolStreaming,
			workingStreamPresentation: options.presentation,
			workingStreamWindowMs: options.windowMinutes * 60_000,
		},
	);
	return { ...context, workingReplyTarget: target.channelId };
}

export function createWorkspaceMessageContext(
	transport: WorkspaceChannelTransport,
	event: MomEvent,
	_store: ChannelStore,
	{
		isEvent,
		responseThreadId,
	}: {
		isEvent?: boolean;
		responseThreadId?: string;
	} = {},
): MomContext {
	const user = transport.getUser(event.user);
	const eventFilename = isEvent ? event.text.match(/^\[(?:EVENT|ATTENTION):([^:]+):/)?.[1] : undefined;
	const threadMessages: string[] = [];
	let workingMessageId: string | null = null;
	const post = (channel: string, text: string) => responseThreadId
		? transport.postInThread(channel, responseThreadId, text)
		: transport.postMessage(channel, text);

	return createTwoMessageContext(
		{
			post,
			update: (channel, id, text) => transport.updateMessage(channel, id, text),
			delete: (channel, id) => transport.deleteMessage(channel, id),
			formatStatus: transport.formatStatus ?? ((text) => `_${text}_`),
			throttleMs: 0,
			maxLength: transport.maxMessageLength,
		},
		{
			headerLine: eventFilename ? `_Starting event: ${eventFilename}_` : "",
			event,
			user,
			channels: transport.getAllChannels(),
			users: transport.getAllUsers(),
			channelName: transport.getChannel(event.channel)?.name,
			isEvent,
			// Customer collaboration is a strict messages-only surface. The
			// agent authors visible prose with send_message; the harness may
			// surface only opted-in progress labels and forced runtime errors.
			verbose: "messages-only",
			toolStreaming: "off",
		},
		{
			onWorkingUpdate: (id) => {
				workingMessageId = id;
			},
			logBotResponse: (channel, text, id) => {
				transport.logBotResponse(channel, text, id, { threadTs: responseThreadId });
			},
			respondInThread: async (text) => {
				const rootId = responseThreadId || workingMessageId;
				if (!rootId) return;
				threadMessages.push(await transport.postInThread(event.channel, rootId, text));
			},
			uploadFile: (filePath, title) => {
				return transport.uploadFile(event.channel, filePath, title, responseThreadId);
			},
			deleteMessages: async (workingId, finalId) => {
				for (const id of threadMessages.splice(0).reverse()) {
					try {
						await transport.deleteMessage(event.channel, id);
					} catch {
						// Best-effort cleanup must continue through the full set.
					}
				}
				if (workingId) await transport.deleteMessage(event.channel, workingId);
				if (finalId) await transport.deleteMessage(event.channel, finalId);
			},
		},
	);
}
