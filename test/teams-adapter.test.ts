import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamsWebhookAdapter } from "../src/adapters/teams-webhook.js";
import { formatTeamsTarget, parseTeamsTarget } from "../src/adapters/teams-target.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import { ChannelStore } from "../src/store.js";
import { resolveMessageTarget } from "../src/tools/send-message.js";
import { resolveReactionTarget } from "../src/tools/react-to-message.js";
import { collectChannels, collectTeamsThreads } from "../src/tools/list-channels.js";
import { collectTeamsThreadMessages } from "../src/tools/read-thread.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT_ID = "00000000-0000-0000-0000-000000000004";
const TEAM_ID = "00000000-0000-0000-0000-000000000002";
const CHANNEL_CONVERSATION = "example-conversation-channel-0001";
const GROUP_CONVERSATION = "example-conversation-group-0001";
const PERSONAL_CONVERSATION = "example-conversation-personal-0001";
const OUT_OF_SCOPE_CONVERSATION = "example-conversation-0002";
const SELF_ID = "28:example-self";
const PERSON_ID = "29:example-person";
const OTHER_AGENT_ID = "28:example-agent";

interface FakeAppState {
	handlers: Map<string, (context: any) => Promise<unknown> | unknown>;
	created: Array<{ conversationId: string; activity: any }>;
	replies: Array<{ conversationId: string; messageId: string; activity: any }>;
	updates: Array<{ conversationId: string; messageId: string; activity: any }>;
	deletes: Array<{ conversationId: string; messageId: string }>;
	reactions: Array<{ conversationId: string; messageId: string; reaction: string }>;
}

function fakeApp(state: FakeAppState): any {
	let nextId = 1700000000100;
	return {
		on: (name: string, callback: (context: any) => Promise<unknown> | unknown) => {
			state.handlers.set(name, callback);
		},
		initialize: async () => {},
		stop: async () => {},
		send: async () => ({ id: String(nextId++) }),
		reply: async () => ({ id: String(nextId++) }),
		server: { handleRequest: async () => ({ status: 202, body: { accepted: true } }) },
		api: {
			conversations: {
				createActivity: async (conversationId: string, activity: any) => {
					state.created.push({ conversationId, activity });
					return { id: String(nextId++) };
				},
				replyToActivity: async (conversationId: string, messageId: string, activity: any) => {
					state.replies.push({ conversationId, messageId, activity });
					return { id: String(nextId++) };
				},
				updateActivity: async (conversationId: string, messageId: string, activity: any) => {
					state.updates.push({ conversationId, messageId, activity });
				},
				deleteActivity: async (conversationId: string, messageId: string) => {
					state.deletes.push({ conversationId, messageId });
				},
				addReaction: async (conversationId: string, messageId: string, reaction: string) => {
					state.reactions.push({ conversationId, messageId, reaction });
				},
				getMembers: async () => [
					{ id: PERSON_ID, name: "Example Person" },
					{ id: OTHER_AGENT_ID, name: "Example Agent" },
				],
			},
		},
	};
}

function activity(input: {
	id: string;
	conversationId?: string;
	conversationType?: "personal" | "groupChat" | "channel";
	fromId?: string;
	fromName?: string;
	fromAadObjectId?: string;
	fromType?: string;
	text?: string;
	mentioned?: boolean;
	replyToId?: string;
	omitTenant?: boolean;
	tenantId?: string;
	omitTeam?: boolean;
	omitConversationType?: boolean;
	omitServiceUrl?: boolean;
}): any {
	const conversationType = input.conversationType ?? "channel";
	const tenantId = input.tenantId ?? TENANT_ID;
	const defaultConversationId = conversationType === "channel"
		? CHANNEL_CONVERSATION
		: conversationType === "groupChat" ? GROUP_CONVERSATION : PERSONAL_CONVERSATION;
	return {
		type: "message",
		id: input.id,
		timestamp: "2026-01-01T00:00:00.000Z",
		serviceUrl: input.omitServiceUrl ? undefined : "https://example.com/teams",
		text: input.text ?? "Example message",
		replyToId: input.replyToId,
		from: {
			id: input.fromId ?? PERSON_ID,
			name: input.fromName ?? "Example Sender",
			aadObjectId: input.fromAadObjectId,
			type: input.fromType ?? "person",
		},
		recipient: { id: SELF_ID, name: "Example Agent", type: "bot" },
		conversation: {
			id: input.conversationId ?? defaultConversationId,
			name: "Example Conversation",
			conversationType: input.omitConversationType ? undefined : conversationType,
			tenantId: input.omitTenant ? undefined : tenantId,
		},
		channelData: {
			channel: { id: "example-channel-0001", name: "Example Channel" },
			...(conversationType === "channel" && !input.omitTeam ? { team: { id: TEAM_ID, name: "Example Team" } } : {}),
			...(input.omitTenant ? {} : { tenant: { id: tenantId } }),
		},
		entities: input.mentioned
			? [{ type: "mention", mentioned: { id: SELF_ID }, text: "<at>Example Agent</at>" }]
			: [],
		attachments: [],
	};
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

const workingDir = mkdtempSync(join(tmpdir(), "troublemaker-teams-test-"));
try {
	const appState: FakeAppState = {
		handlers: new Map(),
		created: [],
		replies: [],
		updates: [],
		deletes: [],
		reactions: [],
	};
	const events: MomEvent[] = [];
	const steers: MomEvent[] = [];
	const ambient: MomEvent[] = [];
	const running = new Set<string>();
	const handler: MomHandler = {
		isRunning: (channel) => running.has(channel),
		handleEvent: async (event) => { events.push(event); },
		handleSlashCommand: async () => false,
		handleSteer: (event) => { steers.push(event); },
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
	const adapter = new TeamsWebhookAdapter({
		clientId: "00000000-0000-0000-0000-000000000003",
		clientSecret: "synthetic-client-secret",
		tenantId: TENANT_ID,
		workingDir,
		store: new ChannelStore({ workingDir, botToken: "" }),
		allowedTenantIds: [TENANT_ID],
		allowedTeamIds: [TEAM_ID],
		allowedConversationIds: [CHANNEL_CONVERSATION, GROUP_CONVERSATION, PERSONAL_CONVERSATION],
		allowedDmUsers: [PERSON_ID, OTHER_AGENT_ID],
		onAmbientMessage: (_channel, event) => { ambient.push(event); },
		app: fakeApp(appState),
	});
	adapter.setHandler(handler);
	await adapter.start();

	assert.equal(appState.handlers.has("message"), true, "message ingress is registered");
	assert.equal(appState.handlers.has("messageReaction"), true, "reaction ingress is registered");
	assert.equal(appState.handlers.has("installationUpdate"), true, "installation lifecycle establishes proactive destinations");
	assert.equal(appState.handlers.has("conversationUpdate"), true, "conversation lifecycle refreshes Teams metadata");
	assert.equal(appState.handlers.has("file.consent.accept"), true, "native personal-chat file consent is registered");
	assert.equal(adapter.getReadiness().reason, "awaiting_signed_inbound", "gateway startup alone does not establish Teams readiness");

	const groupAgentMessage = activity({
		id: "1700000000001",
		conversationType: "groupChat",
		fromId: OTHER_AGENT_ID,
		fromType: "bot",
		text: "Unmentioned authorized agent handoff",
	});
	await appState.handlers.get("message")!({ activity: groupAgentMessage });
	await settle();
	assert.equal(events.length, 1, "an unmentioned agent message in an established group DM is first-class inbound collaboration");
	assert.equal(events[0].directlyAddressed, true);
	assert.equal(events[0].sourceEventType, "teams_group_chat");
	assert.equal(events[0].channel, GROUP_CONVERSATION);

	await appState.handlers.get("message")!({ activity: groupAgentMessage });
	await settle();
	assert.equal(events.length, 1, "duplicate provider delivery does not create another turn");

	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000002",
		conversationType: "groupChat",
		fromId: SELF_ID,
		fromType: "bot",
		text: "Exact self echo",
	}) });
	await settle();
	assert.equal(events.length, 1, "exact authenticated self echo is rejected");

	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000003",
		conversationId: OUT_OF_SCOPE_CONVERSATION,
		conversationType: "groupChat",
		text: "Out of scope",
	}) });
	await settle();
	assert.equal(events.length, 1, "an unestablished out-of-scope conversation is rejected");

	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000004",
		conversationType: "channel",
		text: "Ambient channel note",
	}) });
	await settle();
	assert.equal(ambient.length, 1, "unmentioned channel messages enter ambient routing");
	assert.equal(events.length, 1);

	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000005",
		conversationType: "channel",
		text: "<at>Example Agent</at> please handle this",
		mentioned: true,
	}) });
	await settle();
	assert.equal(events.length, 2, "an explicit channel mention creates a direct turn");
	assert.equal(events[1].text, "please handle this", "the bot mention is removed without clipping the message");
	assert.equal(events[1].threadTs, "1700000000005");
	assert.equal(events[1].replyTarget, formatTeamsTarget(CHANNEL_CONVERSATION, "1700000000005"));

	assert.equal(adapter.getReadiness().reason, "awaiting_successful_outbound");
	const topLevelId = await adapter.postMessage(CHANNEL_CONVERSATION, "**Example** top-level message");
	assert.equal(appState.created.at(-1)?.activity.textFormat, "markdown");
	assert.equal(adapter.getReadiness().ready, true, "readiness requires signed inbound and successful outbound in the same conversation");
	const replyId = await adapter.postInThread(CHANNEL_CONVERSATION, "1700000000005", "Example reply");
	assert.equal(appState.replies.at(-1)?.messageId, "1700000000005", "channel replies preserve the native thread root");
	await adapter.updateMessage(CHANNEL_CONVERSATION, replyId, "Edited reply");
	await adapter.addReaction(CHANNEL_CONVERSATION, replyId, ":eyes:");
	await adapter.deleteMessage(CHANNEL_CONVERSATION, replyId);
	assert.equal(appState.updates.at(-1)?.messageId, replyId);
	assert.equal(appState.reactions.at(-1)?.reaction, "1f440_eyes");
	assert.equal(appState.deletes.at(-1)?.messageId, replyId);

	await appState.handlers.get("messageReaction")!({ activity: {
		...activity({ id: "1700000000006", conversationType: "channel", fromId: PERSON_ID }),
		type: "messageReaction",
		replyToId: topLevelId,
		reactionsAdded: [{ type: "heart", user: { id: PERSON_ID, displayName: "Example Person" } }],
	} });
	await settle();
	assert.equal(events.at(-1)?.sourceEventType, "teams_reaction_added", "reactions to exact agent-authored messages become lightweight steering");

	running.add(CHANNEL_CONVERSATION);
	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000007",
		conversationType: "channel",
		mentioned: true,
		text: "<at>Example Agent</at> steer this",
	}) });
	await settle();
	assert.equal(steers.length, 1, "busy Teams direct messages soft-steer instead of aborting the active run");

	const beforeAdversarial = events.length;
	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000008",
		conversationType: "groupChat",
		fromId: "29:example-unlisted",
		fromName: PERSON_ID,
		text: "Display-name lookalike",
	}) });
	await settle();
	assert.equal(events.length, beforeAdversarial, "direct-message allowlists compare provider IDs and never display names");

	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000009",
		conversationType: "channel",
		mentioned: true,
		omitTenant: true,
	}) });
	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000010",
		conversationType: "channel",
		mentioned: true,
		omitTeam: true,
	}) });
	await settle();
	assert.equal(events.length, beforeAdversarial, "missing authoritative tenant or team identity rejects inbound activity");

	const groupBotMessage = await adapter.postMessage(GROUP_CONVERSATION, "Example group response");
	await appState.handlers.get("messageReaction")!({ activity: {
		...activity({
			id: "1700000000011",
			conversationType: "groupChat",
			fromId: "29:example-unlisted",
			fromName: PERSON_ID,
		}),
		type: "messageReaction",
		replyToId: groupBotMessage,
		reactionsAdded: [{ type: "heart", user: { id: "29:example-unlisted", displayName: "Example Person" } }],
	} });
	await settle();
	assert.equal(events.length, beforeAdversarial, "direct-message reactions enforce the same provider-ID user gate as messages");

	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000012",
		conversationType: "groupChat",
		fromId: PERSON_ID,
		text: "Second durable conversation message",
	}) });
	await settle();
	const groupHistory = await adapter.readThread(GROUP_CONVERSATION, GROUP_CONVERSATION, 40);
	assert.equal(groupHistory.length, 2, "group-chat history uses one durable conversation root");
	const groupListings = (await adapter.listThreads()).filter((entry) => entry.channelId === GROUP_CONVERSATION);
	assert.equal(groupListings.length, 1, "group-chat listing does not create one thread per message");
	assert.equal(groupListings[0]?.sendTarget, formatTeamsTarget(GROUP_CONVERSATION));
	const collectedGroupHistory = await collectTeamsThreadMessages(
		workingDir,
		formatTeamsTarget(GROUP_CONVERSATION),
		[adapter],
	);
	assert.equal(collectedGroupHistory?.messages.length, 2, "read_thread accepts the durable group-chat conversation target");
	assert.equal(adapter.getReadiness().ready, true, "an established canary proof remains ready while its identity is current");

	const target = formatTeamsTarget(CHANNEL_CONVERSATION, "1700000000005");
	assert.deepEqual(parseTeamsTarget(target), {
		conversationId: CHANNEL_CONVERSATION,
		messageId: "1700000000005",
		target,
	});
	assert.equal(resolveMessageTarget(target, [adapter])?.adapter, adapter, "send_message resolves Teams thread targets");
	assert.equal(resolveReactionTarget(target, "heart", [adapter]).platform, "teams", "react_to_message resolves Teams exact-message targets");

	const ledger = readFileSync(join(workingDir, "teams-inbound-deliveries.jsonl"), "utf8");
	assert.match(ledger, /"claimedAt"/);
	assert.match(ledger, /"completedAt"/);
	await adapter.stop();
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}

const staleDir = mkdtempSync(join(tmpdir(), "troublemaker-teams-scope-test-"));
try {
	let now = 1_000;
	const state: FakeAppState = {
		handlers: new Map(),
		created: [],
		replies: [],
		updates: [],
		deletes: [],
		reactions: [],
	};
	const accepted: MomEvent[] = [];
	const adapter = new TeamsWebhookAdapter({
		clientId: "00000000-0000-0000-0000-000000000003",
		clientSecret: "synthetic-client-secret",
		tenantId: TENANT_ID,
		workingDir: staleDir,
		store: new ChannelStore({ workingDir: staleDir, botToken: "" }),
		allowedTenantIds: [TENANT_ID],
		allowedConversationIds: [PERSONAL_CONVERSATION],
		allowedDmUsers: [PERSON_ID],
		now: () => now,
		identityMaxAgeMs: 1_000,
		app: fakeApp(state),
	});
	adapter.setHandler({
		isRunning: () => false,
		handleEvent: async (event) => { accepted.push(event); },
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	});
	await adapter.start();
	await state.handlers.get("message")!({ activity: activity({
		id: "example-scope-message-0001",
		conversationType: "personal",
		fromId: PERSON_ID,
	}) });
	await settle();
	assert.equal(accepted.length, 1);
	await adapter.postMessage(PERSONAL_CONVERSATION, "Example reply");
	assert.equal(adapter.getReadiness().ready, true);

	now = 2_001;
	assert.equal(adapter.getChannel(PERSONAL_CONVERSATION), undefined, "stale identity is hidden from channel listing");
	assert.equal(adapter.getAllChannels().length, 0, "stale identity cannot appear in enumerable destinations");
	assert.equal((await adapter.listThreads()).length, 0, "stale identity cannot expose local history listings");
	assert.equal(collectChannels(staleDir, [adapter]).some((channel) => channel.adapter === "teams"), false, "generic channel listing cannot revive stale Teams log rows");
	assert.equal((await collectTeamsThreads(staleDir, [])).length, 0, "Teams history has no raw-log fallback without an authorizing adapter");
	assert.equal(await collectTeamsThreadMessages(staleDir, formatTeamsTarget(PERSONAL_CONVERSATION), []), null, "Teams history reads require an authorizing adapter");
	await assert.rejects(
		adapter.readThread(PERSONAL_CONVERSATION, PERSONAL_CONVERSATION),
		/conversation_identity_stale/,
		"stale identity rejects history reads",
	);
	await assert.rejects(
		adapter.postMessage(PERSONAL_CONVERSATION, "Rejected stale send"),
		/conversation_identity_stale/,
		"stale identity rejects outbound messages",
	);
	await assert.rejects(
		adapter.uploadFile(PERSONAL_CONVERSATION, "missing-example-file.txt"),
		/conversation_identity_stale/,
		"stale identity rejects files before touching a local path",
	);
	assert.equal(adapter.getReadiness().ready, false, "stale scope invalidates a prior canary readiness proof");

	await state.handlers.get("conversationUpdate")!({ activity: {
		...activity({
			id: "example-scope-lifecycle-0001",
			conversationType: "personal",
			fromId: PERSON_ID,
			omitServiceUrl: true,
		}),
		type: "conversationUpdate",
	} });
	assert.equal(adapter.getChannel(PERSONAL_CONVERSATION), undefined, "incomplete lifecycle activity cannot refresh stale identity");
	await adapter.stop();
} finally {
	rmSync(staleDir, { recursive: true, force: true });
}

const tenantBoundaryDir = mkdtempSync(join(tmpdir(), "troublemaker-teams-tenant-test-"));
try {
	writeFileSync(join(tenantBoundaryDir, "teams-conversations.json"), `${JSON.stringify([{
		id: PERSONAL_CONVERSATION,
		type: "personal",
		name: "Example Conversation",
		serviceUrl: "https://example.com/teams",
		verifiedAt: new Date().toISOString(),
		tenantId: OTHER_TENANT_ID,
	}])}\n`, { mode: 0o600 });
	const state: FakeAppState = {
		handlers: new Map(),
		created: [],
		replies: [],
		updates: [],
		deletes: [],
		reactions: [],
	};
	const accepted: MomEvent[] = [];
	const adapter = new TeamsWebhookAdapter({
		clientId: "00000000-0000-0000-0000-000000000003",
		clientSecret: "synthetic-client-secret",
		tenantId: TENANT_ID,
		workingDir: tenantBoundaryDir,
		store: new ChannelStore({ workingDir: tenantBoundaryDir, botToken: "" }),
		app: fakeApp(state),
	});
	adapter.setHandler({
		isRunning: () => false,
		handleEvent: async (event) => { accepted.push(event); },
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	});
	await adapter.start();
	await state.handlers.get("message")!({ activity: activity({
		id: "example-tenant-message-0001",
		conversationType: "personal",
		tenantId: OTHER_TENANT_ID,
	}) });
	await settle();
	assert.equal(accepted.length, 0, "the configured authentication tenant rejects a different signed activity tenant without an optional allowlist");
	assert.equal(adapter.getChannel(PERSONAL_CONVERSATION), undefined, "cross-tenant cached identity is excluded from listing scope");
	await assert.rejects(
		adapter.postMessage(PERSONAL_CONVERSATION, "Rejected cross-tenant send"),
		/configured_tenant_mismatch/,
		"outbound scope rejects a cached conversation from outside the configured authentication tenant",
	);
	assert.equal(state.created.length, 0, "cross-tenant outbound scope rejects before calling the provider API");
	await adapter.stop();
} finally {
	rmSync(tenantBoundaryDir, { recursive: true, force: true });
}

const authDir = mkdtempSync(join(tmpdir(), "troublemaker-teams-auth-test-"));
try {
	const authenticatedAdapter = new TeamsWebhookAdapter({
		clientId: "00000000-0000-0000-0000-000000000003",
		clientSecret: "synthetic-client-secret",
		tenantId: TENANT_ID,
		workingDir: authDir,
		store: new ChannelStore({ workingDir: authDir, botToken: "" }),
	});
	authenticatedAdapter.setHandler({
		isRunning: () => false,
		handleEvent: async () => {},
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	});
	await authenticatedAdapter.start();
	const realApp = (authenticatedAdapter as unknown as {
		app: { server: { handleRequest(input: { headers: Record<string, string>; body: unknown }): Promise<{ status: number }> } };
	}).app;
	const unauthenticated = await realApp.server.handleRequest({
		headers: {},
		body: activity({ id: "example-auth-message-0001", conversationType: "personal" }),
	});
	assert.equal(unauthenticated.status, 401, "the production SDK rejects requests without Bot Connector authentication");
} finally {
	rmSync(authDir, { recursive: true, force: true });
}

console.log("teams adapter tests passed");
