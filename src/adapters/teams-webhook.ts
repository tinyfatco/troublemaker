import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { App } from "@microsoft/teams.apps";
import {
	MessageActivityInput,
	TypingActivityInput,
	Client as TeamsApiClient,
	type CloudEnvironment,
	type IMessageActivityInput,
	type MessageReactionType,
} from "@microsoft/teams.api";
import { MomSettingsManager, type WorkingOutputTarget } from "../context.js";
import type { ChannelPulse, PulseRecordMetadata } from "../engagement/channel-pulse.js";
import * as log from "../log.js";
import type { Attachment, ChannelStore } from "../store.js";
import { createTwoMessageContext } from "./context.js";
import { markdownToTeams } from "./teams-format.js";
import { formatTeamsTarget } from "./teams-target.js";
import type {
	ChannelInfo,
	AdapterReadiness,
	MomContext,
	MomEvent,
	MomHandler,
	PlatformAdapter,
	SlackThreadTargetInfo,
	ThreadTranscriptMessage,
	UserInfo,
	WorkingOutputContextOptions,
} from "./types.js";
import {
	routeWorkspaceChannelEvent,
	WorkspaceChannelQueue,
	WorkspaceDeliveryLedger,
} from "./workspace-channel-runtime.js";

type TeamsConversationType = "personal" | "groupChat" | "channel" | string;

interface TeamsAccount {
	id: string;
	name?: string;
	aadObjectId?: string;
	type?: string;
}

interface TeamsAttachment {
	contentType: string;
	contentUrl?: string;
	name?: string;
	content?: Record<string, unknown>;
}

interface TeamsActivity {
	type: string;
	id: string;
	action?: string;
	timestamp?: Date | string;
	serviceUrl?: string;
	text?: string;
	replyToId?: string;
	from: TeamsAccount;
	recipient: TeamsAccount;
	conversation: { id: string; name?: string; conversationType?: TeamsConversationType; tenantId?: string };
	channelData?: {
		channel?: { id?: string; name?: string };
		team?: { id?: string; name?: string };
		tenant?: { id?: string };
	};
	entities?: Array<{ type?: string; mentioned?: TeamsAccount; text?: string | null }>;
	attachments?: TeamsAttachment[];
	reactionsAdded?: Array<{ type?: string; user?: { id?: string; displayName?: string } }>;
	reactionsRemoved?: Array<{ type?: string; user?: { id?: string; displayName?: string } }>;
	membersAdded?: TeamsAccount[];
	membersRemoved?: TeamsAccount[];
	value?: Record<string, unknown>;
}

interface TeamsActivityContext {
	activity: TeamsActivity;
	send(activity: IMessageActivityInput): Promise<{ id: string }>;
}

interface TeamsAppLike {
	initialize(): Promise<void>;
	stop(): Promise<void>;
	on(name: string, callback: (context: TeamsActivityContext) => Promise<unknown> | unknown): unknown;
	send(conversationId: string, activity: IMessageActivityInput | TypingActivityInput): Promise<{ id: string }>;
	reply(conversationId: string, messageId: string, activity: IMessageActivityInput): Promise<{ id: string }>;
	server: {
		handleRequest(request: { body: unknown; headers: Record<string, string | string[]> }): Promise<{ status: number; body?: unknown }>;
	};
	api: {
		http?: ConstructorParameters<typeof TeamsApiClient>[1] & {
			get<T = unknown>(url: string, config?: { responseType?: string; timeout?: number; maxContentLength?: number }): Promise<{ data: T }>;
		};
		conversations: {
			createActivity(conversationId: string, activity: IMessageActivityInput | TypingActivityInput): Promise<{ id: string }>;
			replyToActivity(conversationId: string, id: string, activity: IMessageActivityInput): Promise<{ id: string }>;
			updateActivity(conversationId: string, id: string, activity: IMessageActivityInput): Promise<unknown>;
			deleteActivity(conversationId: string, id: string): Promise<void>;
			addReaction(conversationId: string, activityId: string, reactionType: MessageReactionType): Promise<void>;
			getMembers(conversationId: string): Promise<Array<{ id: string; name: string; aadObjectId?: string }>>;
		};
	};
}

interface TeamsConversationRecord {
	id: string;
	type: TeamsConversationType;
	name: string;
	serviceUrl: string;
	verifiedAt: string;
	teamId?: string;
	tenantId: string;
	channelId?: string;
}

type TeamsScopeOperation = "inbound" | "lifecycle" | "reaction" | "list" | "read" | "history" | "file" | "outbound";

interface TeamsScopeRequest {
	operation: TeamsScopeOperation;
	conversationId?: string;
	activity?: TeamsActivity;
	requireKnown?: boolean;
	refreshIdentity?: boolean;
	requireDirectActor?: boolean;
}

type TeamsScopeDecision =
	| { allowed: true; record: TeamsConversationRecord }
	| { allowed: false; reason: string };

interface PendingUpload {
	id: string;
	conversationId: string;
	filePath: string;
	filename: string;
	size: number;
	createdAt: string;
}

export interface TeamsWebhookConfig {
	clientId: string;
	clientSecret?: string;
	managedIdentityClientId?: "system" | (string & {});
	tenantId?: string;
	serviceUrl?: string;
	cloud?: CloudEnvironment;
	messagingEndpoint?: `/${string}`;
	workingDir: string;
	store: ChannelStore;
	pulse?: ChannelPulse;
	allowedTenantIds?: Iterable<string>;
	allowedTeamIds?: Iterable<string>;
	allowedConversationIds?: Iterable<string>;
	allowedDmUsers?: Iterable<string>;
	directChannelMessages?: boolean;
	onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
	/** Test seams for deterministic identity-expiry coverage. */
	now?: () => number;
	identityMaxAgeMs?: number;
	/** Test seam; production always constructs the authenticated Microsoft app. */
	app?: TeamsAppLike;
}

const DEFAULT_IDENTITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export class TeamsWebhookAdapter implements PlatformAdapter {
	readonly name = "teams";
	readonly maxMessageLength = 28_000;
	readonly formatInstructions = `## Microsoft Teams Formatting (Markdown)
Use standard Markdown. Teams supports **bold**, _italic_, lists, links, blockquotes, inline code, and fenced code blocks.
Mention people only when their exact Teams mention identity is available.`;

	private readonly app: TeamsAppLike;
	private readonly workingDir: string;
	private readonly store: ChannelStore;
	private readonly pulse?: ChannelPulse;
	private readonly allowedTenantIds?: ReadonlySet<string>;
	private readonly allowedTeamIds?: ReadonlySet<string>;
	private readonly allowedConversationIds?: ReadonlySet<string>;
	private readonly allowedDmUsers?: ReadonlySet<string>;
	private readonly directChannelMessages: boolean;
	private readonly onAmbientMessage?: (channelId: string, event: MomEvent, adapter: PlatformAdapter) => void;
	private readonly now: () => number;
	private readonly identityMaxAgeMs: number;
	private readonly queues = new Map<string, WorkspaceChannelQueue>();
	private readonly deliveryLedger: WorkspaceDeliveryLedger;
	private readonly conversations = new Map<string, TeamsConversationRecord>();
	private readonly users = new Map<string, UserInfo>();
	private readonly userConversations = new Map<string, Set<string>>();
	private readonly sentMessages = new Map<string, { text: string; threadTs?: string }>();
	private readonly pendingUploads = new Map<string, PendingUpload>();
	private readonly conversationsPath: string;
	private readonly uploadsPath: string;
	private handler!: MomHandler;
	private botUserId: string | null = null;
	private initialized = false;
	private signedInboundProof?: { conversationId: string; observedAt: number };
	private outboundProof?: { conversationId: string; observedAt: number };

	constructor(config: TeamsWebhookConfig) {
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.pulse = config.pulse;
		this.allowedTenantIds = normalizedSet(config.allowedTenantIds);
		this.allowedTeamIds = normalizedSet(config.allowedTeamIds);
		this.allowedConversationIds = normalizedSet(config.allowedConversationIds);
		this.allowedDmUsers = normalizedSet(config.allowedDmUsers);
		this.directChannelMessages = config.directChannelMessages ?? false;
		this.onAmbientMessage = config.onAmbientMessage;
		this.now = config.now ?? Date.now;
		this.identityMaxAgeMs = config.identityMaxAgeMs ?? DEFAULT_IDENTITY_MAX_AGE_MS;
		if (!Number.isFinite(this.identityMaxAgeMs) || this.identityMaxAgeMs <= 0) {
			throw new Error("Teams identity maximum age must be positive");
		}
		this.conversationsPath = join(this.workingDir, "teams-conversations.json");
		this.uploadsPath = join(this.workingDir, "teams-pending-uploads.json");
		this.deliveryLedger = new WorkspaceDeliveryLedger(
			join(this.workingDir, "teams-inbound-deliveries.jsonl"),
			"Teams delivery ledger is unreadable",
		);
		this.loadRuntimeState();

		this.app = config.app ?? new App({
			clientId: config.clientId,
			...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
			...(config.managedIdentityClientId ? { managedIdentityClientId: config.managedIdentityClientId } : {}),
			...(config.tenantId ? { tenantId: config.tenantId } : {}),
			...(config.serviceUrl ? { serviceUrl: config.serviceUrl } : {}),
			...(config.cloud ? { cloud: config.cloud } : {}),
			messagingEndpoint: config.messagingEndpoint ?? "/api/messages",
			activity: { mentions: { stripText: false } },
			dangerouslyAllowUnauthenticatedRequests: false,
		}) as unknown as TeamsAppLike;

		this.app.on("message", (context) => this.handleMessage(context.activity));
		this.app.on("messageReaction", (context) => this.handleReaction(context.activity));
		this.app.on("installationUpdate", (context) => this.handleConversationLifecycle(context.activity));
		this.app.on("conversationUpdate", (context) => this.handleConversationLifecycle(context.activity));
		this.app.on("file.consent.accept", (context) => this.handleFileConsent(context, true));
		this.app.on("file.consent.decline", (context) => this.handleFileConsent(context, false));
	}

	setHandler(handler: MomHandler): void {
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (!this.handler) throw new Error("TeamsWebhookAdapter: handler not set");
		await this.app.initialize();
		this.initialized = true;
		log.logConnected();
	}

	async stop(): Promise<void> {
		this.initialized = false;
		await this.app.stop();
	}

	getReadiness(): AdapterReadiness {
		const signedInbound = Boolean(this.signedInboundProof);
		const successfulOutbound = Boolean(
			this.signedInboundProof
			&& this.outboundProof
			&& this.signedInboundProof.conversationId === this.outboundProof.conversationId
			&& this.outboundProof.observedAt >= this.signedInboundProof.observedAt,
		);
		const currentIdentity = this.signedInboundProof
			? this.evaluateScope({ operation: "read", conversationId: this.signedInboundProof.conversationId }).allowed
			: false;
		const ready = this.initialized && signedInbound && successfulOutbound && currentIdentity;
		return {
			ready,
			reason: !this.initialized
				? "adapter_not_initialized"
				: !signedInbound
					? "awaiting_signed_inbound"
					: !currentIdentity
						? "conversation_identity_stale"
						: !successfulOutbound ? "awaiting_successful_outbound" : "ready",
			checks: {
				initialized: this.initialized,
				signedInbound,
				successfulOutbound,
				currentIdentity,
			},
		};
	}

	dispatch(req: IncomingMessage, res: ServerResponse): void {
		if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST" });
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		let length = 0;
		req.on("data", (chunk: Buffer) => {
			length += chunk.length;
			if (length <= 2 * 1024 * 1024) chunks.push(chunk);
		});
		req.on("end", () => {
			if (length > 2 * 1024 * 1024) {
				res.writeHead(413);
				res.end();
				return;
			}
			let body: unknown;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				res.writeHead(400);
				res.end("Invalid JSON");
				return;
			}
			const headers: Record<string, string | string[]> = {};
			for (const [key, value] of Object.entries(req.headers)) {
				if (typeof value === "string" || Array.isArray(value)) headers[key] = value;
			}
			void this.app.server.handleRequest({ body, headers })
				.then((response) => {
					res.writeHead(response.status, { "content-type": "application/json" });
					res.end(response.body === undefined ? undefined : JSON.stringify(response.body));
				})
				.catch((error) => {
					log.logWarning("Teams request failed", error instanceof Error ? error.message : String(error));
					if (!res.headersSent) res.writeHead(500);
					res.end();
				});
		});
	}

	async postMessage(
		channel: string,
		text: string,
		attachments: Array<{ filePath: string; filename: string }> = [],
	): Promise<string> {
		this.requireScope({ operation: "outbound", conversationId: channel });
		const sent = await this.apiForConversation(channel).conversations.createActivity(channel, messageActivity(text));
		this.rememberSentMessage(channel, sent.id, text);
		this.noteOutboundSuccess(channel);
		for (const attachment of attachments) await this.uploadFile(channel, attachment.filePath, attachment.filename);
		return sent.id;
	}

	async postResponseMessage(event: MomEvent, text: string): Promise<string> {
		const rootId = this.resolveResponseThread(event);
		return rootId ? this.postInThread(event.channel, rootId, text) : this.postMessage(event.channel, text);
	}

	async updateMessage(channel: string, id: string, text: string): Promise<void> {
		this.requireScope({ operation: "outbound", conversationId: channel });
		await this.apiForConversation(channel).conversations.updateActivity(channel, id, messageActivity(text));
		this.rememberSentMessage(channel, id, text, this.sentMessages.get(`${channel}:${id}`)?.threadTs);
	}

	async deleteMessage(channel: string, id: string): Promise<void> {
		this.requireScope({ operation: "outbound", conversationId: channel });
		await this.apiForConversation(channel).conversations.deleteActivity(channel, id);
		this.sentMessages.delete(`${channel}:${id}`);
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const conversation = this.requireScope({ operation: "outbound", conversationId: channel });
		const api = this.apiForConversation(channel);
		const sent = conversation.type === "channel"
			? await api.conversations.replyToActivity(channel, threadTs, messageActivity(text))
			: await api.conversations.createActivity(channel, messageActivity(text));
		this.rememberSentMessage(channel, sent.id, text, conversation.type === "channel" ? threadTs : undefined);
		this.noteOutboundSuccess(channel);
		return sent.id;
	}

	async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
		this.requireScope({ operation: "outbound", conversationId: channel });
		await this.apiForConversation(channel).conversations.addReaction(channel, messageTs, normalizeTeamsReaction(emoji));
	}

	async uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void> {
		const conversation = this.requireScope({ operation: "file", conversationId: channel });
		const filename = title || basename(filePath);
		const size = statSync(filePath).size;
		if (conversation.type === "personal") {
			const upload: PendingUpload = {
				id: randomUUID(),
				conversationId: channel,
				filePath,
				filename,
				size,
				createdAt: new Date().toISOString(),
			};
			this.pendingUploads.set(upload.id, upload);
			this.persistPendingUploads();
			const activity = messageActivity("");
			activity.attachments = [{
				contentType: "application/vnd.microsoft.teams.card.file.consent",
				name: filename,
				content: {
					description: "File from Troublemaker",
					sizeInBytes: size,
					acceptContext: { uploadId: upload.id },
					declineContext: { uploadId: upload.id },
				},
			}];
			await this.apiForConversation(channel).conversations.createActivity(channel, activity);
			return;
		}

		const contentType = mimeTypeFor(filename);
		if (!contentType.startsWith("image/")) {
			throw new Error("Microsoft Teams file-consent uploads work only in personal chats; share this file through OneDrive or SharePoint in a channel or group chat");
		}
		const data = readFileSync(filePath);
		if (data.byteLength > 4 * 1024 * 1024) throw new Error("Microsoft Teams inline images are limited to 4 MiB");
		const activity = messageActivity(title || "");
		activity.attachments = [{
			contentType,
			contentUrl: `data:${contentType};base64,${data.toString("base64")}`,
			name: filename,
		}];
		const api = this.apiForConversation(channel);
		if (threadTs && conversation?.type === "channel") await api.conversations.replyToActivity(channel, threadTs, activity);
		else await api.conversations.createActivity(channel, activity);
	}

	async setTyping(channel: string): Promise<void> {
		this.requireScope({ operation: "outbound", conversationId: channel });
		await this.apiForConversation(channel).conversations.createActivity(channel, new TypingActivityInput());
	}

	getUser(userId: string): UserInfo | undefined {
		const conversations = this.userConversations.get(userId);
		if (!conversations || !Array.from(conversations).some((conversationId) =>
			this.evaluateScope({ operation: "list", conversationId }).allowed)) return undefined;
		return this.users.get(userId);
	}

	getChannel(channelId: string): ChannelInfo | undefined {
		const decision = this.evaluateScope({ operation: "list", conversationId: channelId });
		return decision.allowed ? { id: decision.record.id, name: decision.record.name } : undefined;
	}

	getAllUsers(): UserInfo[] {
		return Array.from(this.users.values()).filter((user) => Boolean(this.getUser(user.id)));
	}

	getAllChannels(): ChannelInfo[] {
		return Array.from(this.conversations.values())
			.filter((conversation) => this.evaluateScope({ operation: "list", conversationId: conversation.id }).allowed)
			.map((conversation) => ({ id: conversation.id, name: conversation.name }));
	}

	logToFile(entry: object): void {
		appendFileSync(join(this.workingDir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channel: string, text: string, ts: string, metadata: { threadTs?: string } = {}): void {
		const conversation = this.requireScope({ operation: "history", conversationId: channel });
		this.rememberSentMessage(channel, ts, text, metadata.threadTs);
		const historyRoot = this.historyRoot(conversation, metadata.threadTs || ts);
		void this.store.logMessage({
			date: new Date().toISOString(),
			ts,
			threadTs: historyRoot,
			channel: `teams:${conversation.name}`,
			channelId: channel,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		} as Parameters<ChannelStore["logMessage"]>[0]);
		if (this.pulse && this.botUserId) {
			this.pulse.record(channel, this.botUserId, text.length, text, this.pulseMetadata(channel, ts, metadata.threadTs, true));
		}
	}

	enqueueEvent(event: MomEvent): boolean {
		if (!event.channel || !this.evaluateScope({ operation: "inbound", conversationId: event.channel }).allowed) return false;
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning("Teams event queue full", event.text.substring(0, 80));
			return false;
		}
		queue.enqueue(async () => { await this.handler.handleEvent(event, this, true); });
		return true;
	}

	createWorkingOutputContext(
		target: WorkingOutputTarget,
		_store: ChannelStore,
		options: WorkingOutputContextOptions,
	): MomContext {
		if (target.platform !== "teams" || !target.channelId) {
			throw new Error("Teams working output requires a valid conversation ID.");
		}
		this.requireScope({ operation: "outbound", conversationId: target.channelId });
		const event: MomEvent = {
			type: this.conversations.get(target.channelId)?.type === "personal" ? "dm" : "mention",
			channel: target.channelId,
			ts: `working-${Date.now()}`,
			user: "system",
			text: "",
			directlyAddressed: false,
			replyTarget: formatTeamsTarget(target.channelId),
			replyTargetDescription: "Configured Microsoft Teams working-output destination",
			attachments: [],
		};
		const context = this.twoMessageContext(event, false, {
			verbose: "messages-only",
			toolStreaming: options.toolStreaming,
			presentation: options.presentation,
			windowMinutes: options.windowMinutes,
		});
		return { ...context, workingReplyTarget: formatTeamsTarget(target.channelId) };
	}

	createContext(event: MomEvent, _store: ChannelStore, isEvent?: boolean): MomContext {
		this.requireScope({ operation: "read", conversationId: event.channel });
		const settings = new MomSettingsManager(this.workingDir);
		const ambiguousAmbient = event.sourceEventType === "ambient_evaluation" && !event.threadTs;
		return this.twoMessageContext(event, isEvent, {
			verbose: ambiguousAmbient ? "messages-only" : settings.getVerbose(event.channel, "teams"),
			toolStreaming: ambiguousAmbient ? "off" : settings.getTeamsToolStreaming(),
			presentation: settings.getTeamsToolStreamPresentation(),
			windowMinutes: settings.getTeamsToolStreamWindowMinutes(),
		});
	}

	async readThread(channel: string, threadTs: string, limit = 40): Promise<ThreadTranscriptMessage[]> {
		const conversation = this.requireScope({ operation: "read", conversationId: channel });
		const bounded = Math.max(1, Math.min(Math.floor(limit) || 40, 100));
		const historyRoot = this.historyRoot(conversation, threadTs);
		return this.readLogMessages()
			.filter((entry) => entry.channelId === channel && (
				conversation.type === "personal" || conversation.type === "groupChat"
					? true
					: (entry.threadTs || entry.ts) === historyRoot
			))
			.sort((a, b) => a.date.localeCompare(b.date))
			.slice(-bounded)
			.map((entry) => ({
				date: entry.date,
				ts: entry.ts,
				threadTs: historyRoot,
				channelId: channel,
				channelName: conversation.name,
				sender: entry.displayName || entry.userName || (entry.isBot ? "Agent" : entry.user),
				text: entry.text,
				isRoot: conversation.type === "channel" ? entry.ts === historyRoot : false,
				isBot: entry.isBot,
				directlyAddressed: entry.directlyAddressed,
				sourceEventType: entry.sourceEventType || "teams_log",
			}));
	}

	async listThreads(limit = 20): Promise<SlackThreadTargetInfo[]> {
		const bounded = Math.max(1, Math.min(Math.floor(limit) || 20, 50));
		const threads = new Map<string, SlackThreadTargetInfo & { participantSet: Set<string> }>();
		for (const entry of this.readLogMessages()) {
			const decision = this.evaluateScope({ operation: "list", conversationId: entry.channelId });
			if (!decision.allowed) continue;
			const conversation = decision.record;
			const directConversation = conversation.type === "personal" || conversation.type === "groupChat";
			const threadTs = this.historyRoot(conversation, entry.threadTs || entry.ts);
			const target = directConversation
				? formatTeamsTarget(entry.channelId)
				: formatTeamsTarget(entry.channelId, threadTs);
			const sender = entry.displayName || entry.userName || (entry.isBot ? "Agent" : entry.user);
			const existing = threads.get(target);
			if (!existing) {
				threads.set(target, {
					channelId: entry.channelId,
					channelName: conversation.name,
					threadTs,
					sendTarget: target,
					rootPreview: entry.text.slice(0, 180) || "(no text captured)",
					lastPreview: entry.text.slice(0, 180) || "(no text captured)",
					participants: [],
					participantSet: new Set([sender]),
					messageCount: 1,
					lastSeen: entry.date,
					source: "log",
				});
				continue;
			}
			existing.participantSet.add(sender);
			existing.messageCount += 1;
			if (!directConversation && entry.ts === threadTs) existing.rootPreview = entry.text.slice(0, 180) || existing.rootPreview;
			if (entry.date >= existing.lastSeen) {
				existing.lastSeen = entry.date;
				existing.lastPreview = entry.text.slice(0, 180) || existing.lastPreview;
			}
		}
		return Array.from(threads.values())
			.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
			.slice(0, bounded)
			.map(({ participantSet, ...thread }) => ({ ...thread, participants: Array.from(participantSet).slice(0, 4) }));
	}

	private twoMessageContext(
		event: MomEvent,
		isEvent: boolean | undefined,
		settings: {
			verbose: ReturnType<MomSettingsManager["getVerbose"]>;
			toolStreaming: ReturnType<MomSettingsManager["getTeamsToolStreaming"]>;
			presentation: ReturnType<MomSettingsManager["getTeamsToolStreamPresentation"]>;
			windowMinutes: number;
		},
	): MomContext {
		const eventFilename = isEvent ? event.text.match(/^\[(?:EVENT|ATTENTION):([^:]+):/)?.[1] : undefined;
		const responseThread = this.resolveResponseThread(event);
		const threadMessages: string[] = [];
		let workingMessageId: string | null = null;
		const post = (channel: string, text: string) => responseThread
			? this.postInThread(channel, responseThread, text)
			: this.postMessage(channel, text);
		return createTwoMessageContext(
			{
				post,
				update: (channel, id, text) => this.updateMessage(channel, id, text),
				delete: (channel, id) => this.deleteMessage(channel, id),
				formatStatus: (text) => `_${text}_`,
				throttleMs: 0,
				maxLength: this.maxMessageLength,
			},
			{
				headerLine: eventFilename ? `_Starting event: ${eventFilename}_` : "",
				event,
				user: this.users.get(event.user),
				channels: this.getAllChannels(),
				users: this.getAllUsers(),
				channelName: this.conversations.get(event.channel)?.name,
				isEvent,
				verbose: settings.verbose,
				toolStreaming: settings.toolStreaming,
				workingStreamPresentation: settings.presentation,
				workingStreamWindowMs: settings.windowMinutes * 60_000,
			},
			{
				onWorkingUpdate: (id) => { workingMessageId = id; },
				logBotResponse: (channel, text, id) => this.logBotResponse(channel, text, id, { threadTs: responseThread }),
				respondInThread: async (text) => {
					const root = responseThread || workingMessageId;
					if (root) threadMessages.push(await this.postInThread(event.channel, root, text));
				},
				sendTyping: () => this.setTyping(event.channel),
				uploadFile: (filePath, title) => this.uploadFile(event.channel, filePath, title, responseThread),
				deleteMessages: async (workingId, finalId) => {
					for (const id of threadMessages.splice(0).reverse()) {
						try { await this.deleteMessage(event.channel, id); } catch { /* best effort */ }
					}
					if (workingId) await this.deleteMessage(event.channel, workingId);
					if (finalId) await this.deleteMessage(event.channel, finalId);
				},
			},
		);
	}

	private resolveResponseThread(event: MomEvent): string | undefined {
		const conversation = this.conversations.get(event.channel);
		if (conversation?.type !== "channel") return undefined;
		const placement = new MomSettingsManager(this.workingDir).getTeamsResponsePlacement();
		return placement === "channel" ? undefined : event.threadTs;
	}

	private async handleMessage(activity: TeamsActivity): Promise<void> {
		if (!validInboundActivity(activity)) return;
		const scope = this.evaluateScope({
			operation: "inbound",
			activity,
			refreshIdentity: true,
			requireDirectActor: true,
		});
		if (!scope.allowed) return;
		const conversation = scope.record;
		this.botUserId = activity.recipient.id || this.botUserId;
		if (this.botUserId) this.pulse?.setSelfId(this.botUserId);
		if (activity.from.id === this.botUserId) return;
		this.rememberUser(activity.from, conversation.id);
		this.noteSignedInbound(conversation.id);

		const type = conversation.type;
		const directConversation = type === "personal" || type === "groupChat";
		const deliveryId = `message:${activity.conversation.id}:${activity.id}`;
		if (!this.deliveryLedger.claim(deliveryId)) return;
		const mentioned = activity.entities?.some((entity) =>
			entity.type === "mention" && entity.mentioned?.id === activity.recipient.id,
		) ?? false;
		const directlyAddressed = directConversation || mentioned || this.directChannelMessages;
		const text = stripTeamsMentions(activity.text || "", activity.entities || []);
		const rootId = activity.replyToId || activity.id;
		const historyRoot = this.historyRoot(conversation, rootId);
		const threadTs = type === "channel" ? rootId : undefined;
		const replyTarget = formatTeamsTarget(activity.conversation.id, threadTs);
		const attachments = await this.processAttachments(activity);
		const sourceEventType = type === "personal"
			? "teams_dm"
			: type === "groupChat"
				? "teams_group_chat"
				: mentioned
					? "teams_mention"
					: this.directChannelMessages ? "teams_channel_direct" : "teams_message";
		const user = this.users.get(activity.from.id);

		await this.store.logMessage({
			date: activityDate(activity),
			ts: activity.id,
			threadTs: historyRoot,
			channel: `teams:${conversation.name}`,
			channelId: activity.conversation.id,
			user: activity.from.id,
			userName: user?.userName,
			displayName: user?.displayName,
			text,
			attachments,
			isBot: activity.from.type === "bot",
			directlyAddressed,
			sourceEventType,
		} as Parameters<ChannelStore["logMessage"]>[0]);
		this.pulse?.record(
			activity.conversation.id,
			activity.from.id,
			text.length,
			text,
			this.pulseMetadata(activity.conversation.id, activity.id, threadTs, directlyAddressed),
		);

		const event: MomEvent = {
			type: directConversation ? "dm" : "mention",
			channel: activity.conversation.id,
			ts: activity.id,
			user: activity.from.id,
			teamId: activity.channelData?.team?.id,
			text,
			rawText: activity.text || text,
			attachments,
			sourceEventType,
			directlyAddressed,
			threadTs,
			replyTarget,
			replyTargetDescription: threadTs
				? "Microsoft Teams channel thread containing this message"
				: "Microsoft Teams conversation containing this message",
		};

		if (directlyAddressed) {
			await routeWorkspaceChannelEvent({
				handler: this.handler,
				adapter: this,
				event,
				queue: this.getQueue(activity.conversation.id),
				onAccepted: () => this.deliveryLedger.complete(deliveryId),
			});
		} else {
			const attention = new MomSettingsManager(this.workingDir).getTeamsChannelAttention(activity.conversation.id);
			if (attention === "ambient") this.onAmbientMessage?.(activity.conversation.id, event, this);
			this.deliveryLedger.complete(deliveryId);
		}
		void this.refreshMembers(activity.conversation.id);
	}

	private async handleReaction(activity: TeamsActivity): Promise<void> {
		if (!validInboundActivity(activity) || activity.from.id === activity.recipient.id) return;
		const scope = this.evaluateScope({
			operation: "reaction",
			activity,
			requireKnown: true,
			refreshIdentity: true,
			requireDirectActor: true,
		});
		if (!scope.allowed) return;
		const conversation = scope.record;
		const messageId = activity.replyToId;
		const reaction = activity.reactionsAdded?.[0]?.type;
		if (!messageId || !reaction) return;
		const sent = this.sentMessages.get(`${activity.conversation.id}:${messageId}`)
			?? this.findLoggedBotMessage(activity.conversation.id, messageId);
		if (!sent) return;
		const deliveryId = `reaction:${activity.conversation.id}:${activity.id}:${messageId}:${activity.from.id}:${reaction}`;
		if (!this.deliveryLedger.claim(deliveryId)) return;
		this.rememberUser(activity.from, conversation.id);
		const threadTs = this.historyRoot(conversation, sent.threadTs || messageId);
		const target = formatTeamsTarget(activity.conversation.id, messageId);
		const replyTarget = conversation.type === "channel"
			? formatTeamsTarget(activity.conversation.id, threadTs)
			: formatTeamsTarget(activity.conversation.id);
		const reactor = this.users.get(activity.from.id)?.displayName || activity.from.name || activity.from.id;
		const event: MomEvent = {
			type: conversation.type === "personal" || conversation.type === "groupChat" ? "dm" : "mention",
			channel: activity.conversation.id,
			ts: activity.id,
			user: activity.from.id,
			text: [
				`[Microsoft Teams reaction steering] ${reactor} reacted with ${reaction} to your exact message ${target}.`,
				`Reacted-to message: "${sent.text.slice(0, 500)}"`,
				`Conversation reply target: ${replyTarget}.`,
				"Treat this as lightweight direct feedback about that specific message, not blanket approval for unrelated consequential actions.",
			].join("\n"),
			rawText: reaction,
			sourceEventType: "teams_reaction_added",
			directlyAddressed: true,
			threadTs: conversation.type === "channel" ? threadTs : undefined,
			replyTarget,
			replyTargetDescription: "Microsoft Teams conversation containing the agent message that received this reaction",
			attachments: [],
		};
		this.logToFile({
			date: activityDate(activity),
			ts: activity.id,
			threadTs,
			channel: `teams:${conversation.name}`,
			channelId: activity.conversation.id,
			user: activity.from.id,
			displayName: reactor,
			text: `${reactor} reacted with ${reaction} to the agent message: ${sent.text.slice(0, 500)}`,
			attachments: [],
			isBot: false,
			directlyAddressed: true,
			sourceEventType: "teams_reaction_added",
		});
		await routeWorkspaceChannelEvent({
			handler: this.handler,
			adapter: this,
			event,
			queue: this.getQueue(activity.conversation.id),
			onAccepted: () => this.deliveryLedger.complete(deliveryId),
		});
	}

	private async handleConversationLifecycle(activity: TeamsActivity): Promise<void> {
		if (!validInboundActivity(activity)) return;
		const removing = activity.type === "installationUpdate" && activity.action === "remove";
		const scope = this.evaluateScope({
			operation: "lifecycle",
			activity,
			requireKnown: removing,
			refreshIdentity: !removing,
		});
		if (!scope.allowed) return;
		this.botUserId = activity.recipient.id || this.botUserId;
		if (this.botUserId) this.pulse?.setSelfId(this.botUserId);
		if (removing) {
			this.conversations.delete(activity.conversation.id);
			this.persistConversations();
			return;
		}
		for (const account of activity.membersAdded || []) {
			if (this.acceptsActor(scope.record, account)) this.rememberUser(account, scope.record.id);
		}
		void this.refreshMembers(activity.conversation.id);
	}

	private async handleFileConsent(context: TeamsActivityContext, accepted: boolean): Promise<Record<string, unknown>> {
		if (!validInboundActivity(context.activity)) return { status: 403 };
		const scope = this.evaluateScope({
			operation: "file",
			activity: context.activity,
			requireKnown: true,
			refreshIdentity: true,
			requireDirectActor: true,
		});
		if (!scope.allowed) return { status: 403 };
		const value = context.activity.value || {};
		const contextValue = value.context as { uploadId?: unknown } | undefined;
		const uploadId = typeof contextValue?.uploadId === "string" ? contextValue.uploadId : undefined;
		if (!uploadId) return { status: 400 };
		const upload = this.pendingUploads.get(uploadId);
		if (!upload || upload.conversationId !== context.activity.conversation.id) return { status: 404 };
		this.pendingUploads.delete(uploadId);
		this.persistPendingUploads();
		if (!accepted) return { status: 200 };
		const uploadInfo = value.uploadInfo as {
			uploadUrl?: unknown;
			contentUrl?: unknown;
			uniqueId?: unknown;
			fileType?: unknown;
		} | undefined;
		if (typeof uploadInfo?.uploadUrl !== "string") return { status: 400 };
		const response = await fetch(uploadInfo.uploadUrl, {
			method: "PUT",
			headers: { "content-length": String(upload.size), "content-range": `bytes 0-${upload.size - 1}/${upload.size}` },
			body: readFileSync(upload.filePath),
		});
		if (!response.ok) throw new Error(`Teams file upload returned HTTP ${response.status}`);
		const activity = messageActivity("");
		activity.attachments = [{
			contentType: "application/vnd.microsoft.teams.card.file.info",
			contentUrl: typeof uploadInfo.contentUrl === "string" ? uploadInfo.contentUrl : undefined,
			name: upload.filename,
			content: {
				uniqueId: typeof uploadInfo.uniqueId === "string" ? uploadInfo.uniqueId : upload.id,
				fileType: typeof uploadInfo.fileType === "string" ? uploadInfo.fileType : extname(upload.filename).slice(1),
			},
		}];
		await context.send(activity);
		return { status: 200 };
	}

	private async processAttachments(activity: TeamsActivity): Promise<Attachment[]> {
		const candidates = (activity.attachments || []).map((attachment) => {
			const content = attachment.content || {};
			if (typeof content.downloadUrl === "string" && attachment.name) {
				return { url: content.downloadUrl, name: attachment.name, botAuth: false };
			}
			if (attachment.contentType.startsWith("image/") && attachment.contentUrl && attachment.name) {
				return { url: attachment.contentUrl, name: attachment.name, botAuth: true };
			}
			return null;
		}).filter((entry): entry is { url: string; name: string; botAuth: boolean } => Boolean(entry));
		if (candidates.length === 0) return [];
		const directory = join(this.workingDir, "attachments");
		mkdirSync(directory, { recursive: true });
		const attachments: Attachment[] = [];
		for (const candidate of candidates) {
			const safeName = candidate.name.replace(/[^a-zA-Z0-9._-]/g, "_");
			const local = `attachments/${Date.now()}_${randomUUID()}_${safeName}`;
			try {
				let data: Buffer;
				if (candidate.botAuth) {
					if (!this.app.api.http) throw new Error("authenticated attachment client is unavailable");
					const response = await this.app.api.http.get<ArrayBuffer>(candidate.url, {
						responseType: "arraybuffer",
						timeout: 30_000,
						maxContentLength: 25 * 1024 * 1024,
					});
					data = Buffer.from(response.data);
				} else {
					const response = await fetch(candidate.url, { signal: AbortSignal.timeout(30_000) });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const declaredSize = Number(response.headers.get("content-length") || 0);
					if (declaredSize > 25 * 1024 * 1024) throw new Error("file exceeds 25 MiB inbound limit");
					data = Buffer.from(await response.arrayBuffer());
				}
				if (data.byteLength > 25 * 1024 * 1024) throw new Error("file exceeds 25 MiB inbound limit");
				await writeFile(join(this.workingDir, local), data, { mode: 0o600 });
				attachments.push({ original: candidate.name, local });
			} catch (error) {
				log.logWarning("Teams attachment download failed", error instanceof Error ? error.message : String(error));
			}
		}
		return attachments;
	}

	private evaluateScope(request: TeamsScopeRequest): TeamsScopeDecision {
		const conversationId = request.activity?.conversation?.id || request.conversationId;
		if (!conversationId || (request.conversationId && request.activity && request.conversationId !== conversationId)) {
			return { allowed: false, reason: "conversation_identity_missing" };
		}

		const existing = this.conversations.get(conversationId);
		let record = existing;
		if (request.activity) {
			const candidate = this.authoritativeRecord(request.activity);
			if (!candidate) return { allowed: false, reason: "authoritative_identity_missing" };
			if (request.requireKnown && !existing) return { allowed: false, reason: "conversation_identity_unknown" };
			if (existing && !sameConversationIdentity(existing, candidate)) {
				return { allowed: false, reason: "conversation_identity_conflict" };
			}
			record = candidate;
		}

		if (!record || !completeConversationIdentity(record)) {
			return { allowed: false, reason: "conversation_identity_missing" };
		}
		if (!request.activity && !this.isIdentityFresh(record)) {
			return { allowed: false, reason: "conversation_identity_stale" };
		}
		if (this.allowedTenantIds && !this.allowedTenantIds.has(record.tenantId)) {
			return { allowed: false, reason: "tenant_out_of_scope" };
		}
		if (record.type === "channel" && this.allowedTeamIds && !this.allowedTeamIds.has(record.teamId!)) {
			return { allowed: false, reason: "team_out_of_scope" };
		}
		if (this.allowedConversationIds && !this.allowedConversationIds.has(record.id)) {
			return { allowed: false, reason: "conversation_out_of_scope" };
		}
		if (request.requireDirectActor && (record.type === "personal" || record.type === "groupChat")) {
			const actor = request.activity?.from;
			if (!actor || !this.acceptsActor(record, actor)) {
				return { allowed: false, reason: "direct_actor_out_of_scope" };
			}
		}
		if (request.refreshIdentity && request.activity) this.rememberConversation(record);
		return { allowed: true, record };
	}

	private requireScope(request: TeamsScopeRequest): TeamsConversationRecord {
		const decision = this.evaluateScope(request);
		if (!decision.allowed) {
			throw new Error(`Microsoft Teams ${request.operation} rejected: ${decision.reason}`);
		}
		return decision.record;
	}

	private authoritativeRecord(activity: TeamsActivity): TeamsConversationRecord | undefined {
		const type = activity.conversation?.conversationType;
		if (type !== "personal" && type !== "groupChat" && type !== "channel") return undefined;
		const conversationId = activity.conversation.id?.trim();
		const channelTenantId = activity.channelData?.tenant?.id?.trim();
		const conversationTenantId = activity.conversation.tenantId?.trim();
		const tenantIds = new Set([channelTenantId, conversationTenantId].filter((value): value is string => Boolean(value)));
		if (!conversationId || tenantIds.size !== 1) return undefined;
		const tenantId = Array.from(tenantIds)[0];
		const teamId = activity.channelData?.team?.id?.trim();
		const channelId = activity.channelData?.channel?.id?.trim();
		if (type === "channel" && (!teamId || !channelId)) return undefined;
		const serviceUrl = normalizeHttpsServiceUrl(activity.serviceUrl);
		if (!serviceUrl) return undefined;
		return {
			id: conversationId,
			type,
			name: activity.channelData?.channel?.name || activity.conversation.name || conversationId,
			serviceUrl,
			verifiedAt: new Date(this.now()).toISOString(),
			tenantId,
			...(type === "channel" ? { teamId, channelId } : {}),
		};
	}

	private isIdentityFresh(record: TeamsConversationRecord): boolean {
		const verifiedAt = Date.parse(record.verifiedAt);
		return Number.isFinite(verifiedAt)
			&& verifiedAt <= this.now() + 5 * 60_000
			&& this.now() - verifiedAt <= this.identityMaxAgeMs;
	}

	private acceptsActor(record: TeamsConversationRecord, account: TeamsAccount): boolean {
		if (record.type !== "personal" && record.type !== "groupChat") return true;
		if (!this.allowedDmUsers) return true;
		return [account.id, account.aadObjectId]
			.filter((value): value is string => Boolean(value))
			.some((value) => this.allowedDmUsers!.has(value));
	}

	private rememberConversation(record: TeamsConversationRecord): void {
		this.conversations.set(record.id, record);
		this.persistConversations();
	}

	private rememberUser(account: TeamsAccount, conversationId: string): void {
		const displayName = account.name || account.id;
		this.users.set(account.id, { id: account.id, userName: displayName, displayName });
		let conversations = this.userConversations.get(account.id);
		if (!conversations) {
			conversations = new Set();
			this.userConversations.set(account.id, conversations);
		}
		conversations.add(conversationId);
	}

	private async refreshMembers(conversationId: string): Promise<void> {
		const scope = this.evaluateScope({ operation: "list", conversationId });
		if (!scope.allowed) return;
		try {
			const members = await this.apiForConversation(conversationId).conversations.getMembers(conversationId);
			for (const member of members) {
				if (this.acceptsActor(scope.record, member)) this.rememberUser(member, conversationId);
			}
		} catch (error) {
			log.logWarning("Teams member refresh failed", error instanceof Error ? error.message : String(error));
		}
	}

	private apiForConversation(conversationId: string): TeamsAppLike["api"] {
		const serviceUrl = this.conversations.get(conversationId)?.serviceUrl?.replace(/\/+$/, "");
		const defaultUrl = (this.app.api as { serviceUrl?: string }).serviceUrl?.replace(/\/+$/, "");
		if (!serviceUrl || !this.app.api.http || serviceUrl === defaultUrl) return this.app.api;
		return new TeamsApiClient(serviceUrl, this.app.api.http) as unknown as TeamsAppLike["api"];
	}

	private historyRoot(conversation: TeamsConversationRecord, messageRoot: string): string {
		return conversation.type === "personal" || conversation.type === "groupChat"
			? conversation.id
			: messageRoot;
	}

	private noteOutboundSuccess(conversationId: string): void {
		if (this.signedInboundProof?.conversationId !== conversationId) return;
		this.outboundProof = { conversationId, observedAt: this.now() };
	}

	private noteSignedInbound(conversationId: string): void {
		const existingProofIsReady = Boolean(
			this.signedInboundProof
			&& this.outboundProof
			&& this.signedInboundProof.conversationId === this.outboundProof.conversationId
			&& this.outboundProof.observedAt >= this.signedInboundProof.observedAt
			&& this.evaluateScope({ operation: "read", conversationId: this.signedInboundProof.conversationId }).allowed,
		);
		if (existingProofIsReady) return;
		this.signedInboundProof = { conversationId, observedAt: this.now() };
		this.outboundProof = undefined;
	}

	private rememberSentMessage(channel: string, id: string, text: string, threadTs?: string): void {
		this.sentMessages.set(`${channel}:${id}`, { text, threadTs });
		while (this.sentMessages.size > 2_000) this.sentMessages.delete(this.sentMessages.keys().next().value as string);
	}

	private findLoggedBotMessage(channel: string, id: string): { text: string; threadTs?: string } | undefined {
		const entry = this.readLogMessages().reverse().find((candidate) =>
			candidate.channelId === channel && candidate.ts === id && candidate.isBot,
		);
		return entry ? { text: entry.text, threadTs: entry.threadTs } : undefined;
	}

	private readLogMessages(): Array<{
		date: string;
		ts: string;
		threadTs?: string;
		channelId: string;
		user: string;
		userName?: string;
		displayName?: string;
		text: string;
		isBot: boolean;
		directlyAddressed?: boolean;
		sourceEventType?: string;
	}> {
		const path = join(this.workingDir, "log.jsonl");
		if (!existsSync(path)) return [];
		try {
			return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
				.filter((entry) => entry && typeof entry === "object" && typeof entry.channelId === "string"
					&& typeof entry.ts === "string" && typeof entry.text === "string" && typeof entry.date === "string");
		} catch {
			return [];
		}
	}

	private pulseMetadata(channel: string, messageId: string, threadTs?: string, directlyAddressed = false): PulseRecordMetadata {
		return {
			messageId,
			threadTs: threadTs || messageId,
			replyTarget: formatTeamsTarget(channel, threadTs),
			replyTargetDescription: threadTs
				? "Microsoft Teams channel thread containing this message"
				: "Microsoft Teams conversation containing this message",
			directlyAddressed,
		};
	}

	private getQueue(channelId: string): WorkspaceChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new WorkspaceChannelQueue((error) => {
				log.logWarning("Teams queue error", error instanceof Error ? error.message : String(error));
			});
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private loadRuntimeState(): void {
		for (const record of readPrivateJson<TeamsConversationRecord[]>(this.conversationsPath, [])) {
			if (record?.id && record.name && record.type) this.conversations.set(record.id, record);
		}
		for (const upload of readPrivateJson<PendingUpload[]>(this.uploadsPath, [])) {
			if (upload?.id && upload.conversationId && upload.filePath && existsSync(upload.filePath)) {
				this.pendingUploads.set(upload.id, upload);
			}
		}
	}

	private persistConversations(): void {
		writePrivateJson(this.conversationsPath, Array.from(this.conversations.values()));
	}

	private persistPendingUploads(): void {
		writePrivateJson(this.uploadsPath, Array.from(this.pendingUploads.values()));
	}
}

function messageActivity(text: string): MessageActivityInput {
	return new MessageActivityInput(markdownToTeams(text), { textFormat: "markdown" });
}

function normalizedSet(values: Iterable<string> | undefined, lowerCase = false): ReadonlySet<string> | undefined {
	if (values === undefined) return undefined;
	return new Set(Array.from(values, (value) => lowerCase ? value.trim().toLowerCase() : value.trim()).filter(Boolean));
}

function completeConversationIdentity(record: TeamsConversationRecord): boolean {
	if (!record.id || !record.tenantId || !record.serviceUrl || !record.verifiedAt) return false;
	if (record.type !== "personal" && record.type !== "groupChat" && record.type !== "channel") return false;
	return record.type !== "channel" || Boolean(record.teamId && record.channelId);
}

function sameConversationIdentity(left: TeamsConversationRecord, right: TeamsConversationRecord): boolean {
	return left.id === right.id
		&& left.type === right.type
		&& left.tenantId === right.tenantId
		&& left.teamId === right.teamId
		&& left.channelId === right.channelId;
}

function normalizeHttpsServiceUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return url.toString().replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

function validInboundActivity(activity: TeamsActivity): boolean {
	return Boolean(activity?.id && activity.conversation?.id && activity.from?.id && activity.recipient?.id);
}

function stripTeamsMentions(text: string, entities: TeamsActivity["entities"]): string {
	let result = text;
	for (const entity of entities || []) {
		if (entity.type === "mention" && entity.text) result = result.replaceAll(entity.text, "");
	}
	return result.replace(/<at>[^<]*<\/at>/gi, "").trim();
}

function activityDate(activity: TeamsActivity): string {
	const value = activity.timestamp;
	const date = value instanceof Date ? value : value ? new Date(value) : new Date();
	return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeTeamsReaction(value: string): MessageReactionType {
	const normalized = value.trim().toLowerCase().replace(/^:|:$/g, "");
	const aliases: Record<string, MessageReactionType> = {
		thumbsup: "like",
		"+1": "like",
		like: "like",
		heart: "heart",
		eyes: "1f440_eyes",
		white_check_mark: "2705_whiteheavycheckmark",
		check: "2705_whiteheavycheckmark",
		rocket: "launch",
		pushpin: "1f4cc_pushpin",
	};
	if (aliases[normalized]) return aliases[normalized];
	if (!/^[a-z0-9_+-]{1,100}$/.test(normalized)) throw new Error("Invalid Microsoft Teams reaction type");
	return normalized;
}

function mimeTypeFor(filename: string): string {
	switch (extname(filename).toLowerCase()) {
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".gif": return "image/gif";
		case ".webp": return "image/webp";
		case ".pdf": return "application/pdf";
		case ".txt":
		case ".md": return "text/plain";
		default: return "application/octet-stream";
	}
}

function readPrivateJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			log.logWarning("Teams private runtime state is unreadable", basename(path));
		}
		return fallback;
	}
}

function writePrivateJson(path: string, value: unknown): void {
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}
