import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamsWebhookAdapter } from "../src/adapters/teams-webhook.js";
import { formatTeamsTarget, parseTeamsTarget } from "../src/adapters/teams-target.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import { ChannelStore } from "../src/store.js";
import { resolveMessageTarget } from "../src/tools/send-message.js";
import { resolveReactionTarget } from "../src/tools/react-to-message.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const TEAM_ID = "00000000-0000-0000-0000-000000000002";
const ALLOWED_CONVERSATION = "example-conversation-0001";
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
	fromType?: string;
	text?: string;
	mentioned?: boolean;
	replyToId?: string;
}): any {
	const conversationType = input.conversationType ?? "channel";
	return {
		type: "message",
		id: input.id,
		timestamp: "2026-01-01T00:00:00.000Z",
		serviceUrl: "https://example.com/teams",
		text: input.text ?? "Example message",
		replyToId: input.replyToId,
		from: { id: input.fromId ?? PERSON_ID, name: "Example Sender", type: input.fromType ?? "person" },
		recipient: { id: SELF_ID, name: "Example Agent", type: "bot" },
		conversation: {
			id: input.conversationId ?? ALLOWED_CONVERSATION,
			name: "Example Conversation",
			conversationType,
			tenantId: TENANT_ID,
		},
		channelData: {
			channel: { id: "example-channel-0001", name: "Example Channel" },
			...(conversationType === "channel" ? { team: { id: TEAM_ID, name: "Example Team" } } : {}),
			tenant: { id: TENANT_ID },
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
		workingDir,
		store: new ChannelStore({ workingDir, botToken: "" }),
		allowedTenantIds: [TENANT_ID],
		allowedTeamIds: [TEAM_ID],
		allowedConversationIds: [ALLOWED_CONVERSATION],
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
	assert.equal(events[1].replyTarget, formatTeamsTarget(ALLOWED_CONVERSATION, "1700000000005"));

	const topLevelId = await adapter.postMessage(ALLOWED_CONVERSATION, "**Example** top-level message");
	assert.equal(appState.created.at(-1)?.activity.textFormat, "markdown");
	const replyId = await adapter.postInThread(ALLOWED_CONVERSATION, "1700000000005", "Example reply");
	assert.equal(appState.replies.at(-1)?.messageId, "1700000000005", "channel replies preserve the native thread root");
	await adapter.updateMessage(ALLOWED_CONVERSATION, replyId, "Edited reply");
	await adapter.addReaction(ALLOWED_CONVERSATION, replyId, ":eyes:");
	await adapter.deleteMessage(ALLOWED_CONVERSATION, replyId);
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

	running.add(ALLOWED_CONVERSATION);
	await appState.handlers.get("message")!({ activity: activity({
		id: "1700000000007",
		conversationType: "channel",
		mentioned: true,
		text: "<at>Example Agent</at> steer this",
	}) });
	await settle();
	assert.equal(steers.length, 1, "busy Teams direct messages soft-steer instead of aborting the active run");

	const target = formatTeamsTarget(ALLOWED_CONVERSATION, "1700000000005");
	assert.deepEqual(parseTeamsTarget(target), {
		conversationId: ALLOWED_CONVERSATION,
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
