import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { SlackBase } from "../src/adapters/slack-base.js";
import { SlackSocketAdapter } from "../src/adapters/slack-socket.js";
import { SlackWebhookAdapter } from "../src/adapters/slack-webhook.js";
import { withHostDeliveryScope } from "../src/adapters/host-delivery-scope.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "../src/adapters/types.js";
import type { ChannelPulse } from "../src/engagement/channel-pulse.js";
import type { ChannelStore } from "../src/store.js";
import { collectSlackThreadMessagesFromLog, collectThreadMessages, formatThreadTranscript } from "../src/tools/read-thread.js";
import { createReactToMessageTool } from "../src/tools/react-to-message.js";

const BOT_ID = "U1111111111";
const REACTOR_ID = "U2222222222";
const OTHER_BOT_ID = "U3333333333";
const DENIED_USER_ID = "U4444444444";
const TEAM_ID = "T1111111111";

function store(): ChannelStore {
	return { processAttachments: () => [] } as unknown as ChannelStore;
}

function reactionEvent(input: {
	channel: string;
	messageTs: string;
	eventTs: string;
	user?: string;
	itemUser?: string;
	reaction?: string;
	itemType?: string;
}) {
	return {
		type: "reaction_added",
		user: input.user || REACTOR_ID,
		reaction: input.reaction || "thumbsup",
		item_user: input.itemUser || BOT_ID,
		item: {
			type: input.itemType || "message",
			channel: input.channel,
			ts: input.messageTs,
		},
		event_ts: input.eventTs,
	};
}

function socketReactionListener(adapter: SlackSocketAdapter): (payload: any) => Promise<void> {
	(adapter as any).setupEventHandlers();
	const listeners = (adapter as any).socketClient.listeners("reaction_added");
	assert.equal(listeners.length, 1, "Socket Mode registers one reaction_added listener");
	return listeners[0];
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

interface HandlerState {
	events: MomEvent[];
	steers: MomEvent[];
	running: Set<string>;
	isRunningCalls: number;
	slashCalls: number;
	pendingCalls: number;
	stopCalls: number;
}

function makeHandler(state: HandlerState): MomHandler {
	return {
		isRunning: (channel) => {
			state.isRunningCalls++;
			return state.running.has(channel);
		},
		handleEvent: async (event) => { state.events.push(event); },
		handleSlashCommand: async () => { state.slashCalls++; return false; },
		handleSteer: (event) => { state.steers.push(event); },
		handleStop: async () => { state.stopCalls++; },
		resolvePendingInput: () => { state.pendingCalls++; return false; },
	};
}

class LiveThreadSlackAdapter extends SlackBase {
	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	configure(client: unknown): void {
		(this as any).webClient = client;
		this.botUserId = BOT_ID;
		this.channels.set("C7777777777", { id: "C7777777777", name: "example-channel" });
		this.users.set(REACTOR_ID, { id: REACTOR_ID, userName: "example-reactor", displayName: "Example Reactor" });
	}
}

const socketWorkingDir = mkdtempSync(join(tmpdir(), "tm-slack-reaction-socket-"));
const webhookWorkingDir = mkdtempSync(join(tmpdir(), "tm-slack-reaction-webhook-"));
const liveWorkingDir = mkdtempSync(join(tmpdir(), "tm-slack-reaction-live-"));

try {
	let pulseCalls = 0;
	let ambientCalls = 0;
	let apiLookups = 0;
	const state: HandlerState = {
		events: [],
		steers: [],
		running: new Set(["C2222222222"]),
		isRunningCalls: 0,
		slashCalls: 0,
		pendingCalls: 0,
		stopCalls: 0,
	};
	const pulse = {
		record: () => { pulseCalls++; },
		setSelfId: () => {},
	} as unknown as ChannelPulse;
	const socket = new SlackSocketAdapter({
		appToken: "xapp-test",
		botToken: "xoxb-test",
		workingDir: socketWorkingDir,
		store: store(),
		pulse,
		allowedDmUserIds: [REACTOR_ID],
		onAmbientMessage: () => { ambientCalls++; },
	});
	socket.setHandler(makeHandler(state));
	(socket as any).botUserId = BOT_ID;
	(socket as any).users.set(REACTOR_ID, {
		id: REACTOR_ID,
		userName: "example-reactor",
		displayName: "Example Reactor",
	});
	(socket as any).webClient = {
		reactions: {
			get: async ({ timestamp }: { timestamp: string }) => {
				apiLookups++;
				if (timestamp === "1710000001.000200") {
					return { message: { ts: timestamp, text: "Allowed direct-message promise." } };
				}
				if (timestamp === "1710000002.000300") {
					return { message: { ts: timestamp, text: "Busy-channel promise." } };
				}
				return {
					message: {
						ts: timestamp,
						thread_ts: "1710000000.000050",
						text: "I can carry out the scoped follow-up after approval.",
					},
				};
			},
		},
	};
	const onSocketReaction = socketReactionListener(socket);

	let acknowledgements = 0;
	await onSocketReaction({
		event: reactionEvent({
			channel: "C1111111111",
			messageTs: "1710000000.000100",
			eventTs: "1710000100.000100",
			itemUser: OTHER_BOT_ID,
		}),
		body: { team_id: TEAM_ID, event_id: "Ev1111111111" },
		ack: () => { acknowledgements++; },
	});
	await settle();
	assert.equal(acknowledgements, 1, "a non-owner workspace reaction is acknowledged once");
	assert.equal(apiLookups, 0, "non-owner filtering happens before Slack API lookup");
	assert.equal(pulseCalls, 0, "non-owner filtering happens before channel pulse");
	assert.equal(ambientCalls, 0, "non-owner reactions never reach ambient engagement");
	assert.equal(state.isRunningCalls, 0, "non-owner reactions never reach wake routing");
	assert.equal(state.events.length, 0, "non-owner reactions create no prompt/run");
	assert.equal(existsSync(join(socketWorkingDir, "log.jsonl")), false, "non-owner reactions create no workspace log evidence");

	await onSocketReaction({
		event: reactionEvent({
			channel: "C1111111111",
			messageTs: "1710000000.000100",
			eventTs: "1710000101.000100",
			user: BOT_ID,
		}),
		body: { team_id: TEAM_ID, event_id: "Ev2222222222" },
		ack: () => { acknowledgements++; },
	});
	assert.equal(apiLookups, 0, "self-reactions are ignored before lookup");
	assert.equal(state.events.length, 0, "self-reactions never wake the agent");

	await onSocketReaction({
		event: reactionEvent({
			channel: "C1111111111",
			messageTs: "1710000000.000100",
			eventTs: "1710000101.000200",
			itemType: "file",
		}),
		body: { team_id: TEAM_ID, event_id: "Ev2222222223" },
		ack: () => { acknowledgements++; },
	});
	assert.equal(apiLookups, 0, "non-message reactions are ignored before lookup");
	assert.equal(state.events.length, 0, "non-message reactions never wake the agent");

	await onSocketReaction({
		event: reactionEvent({
			channel: "not-a-slack-channel",
			messageTs: "not-a-timestamp",
			eventTs: "1710000101.000300",
		}),
		body: { team_id: TEAM_ID, event_id: "Ev2222222224" },
		ack: () => { acknowledgements++; },
	});
	assert.equal(apiLookups, 0, "malformed reaction targets are ignored before lookup");
	assert.equal(state.events.length, 0, "malformed reaction targets never wake the agent");
	assert.equal(existsSync(join(socketWorkingDir, "log.jsonl")), false, "malformed reaction targets are not logged");

	await onSocketReaction({
		event: reactionEvent({
			channel: "D1111111111",
			messageTs: "1710000000.000100",
			eventTs: "1710000102.000100",
			user: DENIED_USER_ID,
		}),
		body: { team_id: TEAM_ID, event_id: "Ev3333333333" },
		ack: () => { acknowledgements++; },
	});
	assert.equal(apiLookups, 0, "a denied DM reaction is filtered before lookup");
	assert.equal(state.events.length, 0, "a denied DM reaction does not wake the agent");
	assert.equal(existsSync(join(socketWorkingDir, "log.jsonl")), false, "a denied DM reaction is not logged");

	const idlePayload = {
		event: reactionEvent({
			channel: "C1111111111",
			messageTs: "1710000000.000100",
			eventTs: "1710000103.000100",
		}),
		body: { team_id: TEAM_ID, event_id: "Ev4444444444" },
		ack: () => { acknowledgements++; },
	};
	await onSocketReaction(idlePayload);
	await settle();
	assert.equal(state.events.length, 1, "an owner-authored reaction starts an idle Socket Mode run");
	assert.equal(state.events[0]?.sourceEventType, "slack_reaction_added");
	assert.equal(state.events[0]?.directlyAddressed, true);
	assert.equal(state.events[0]?.threadTs, "1710000000.000050", "reaction lookup resolves the original thread root");
	assert.equal(state.events[0]?.replyTarget, "slack:C1111111111:1710000000.000050");
	assert.match(state.events[0]?.text || "", /Example Reactor \(U2222222222\)/, "reaction prompt identifies the reacting user");
	assert.match(state.events[0]?.text || "", /:thumbsup:/, "reaction prompt identifies the emoji");
	assert.match(state.events[0]?.text || "", /slack:C1111111111:1710000000\.000100/, "reaction prompt identifies the exact reacted-to message");
	assert.match(state.events[0]?.text || "", /lightweight direct feedback and steering/, "reaction prompt explains the lightweight steering boundary");
	assert.match(state.events[0]?.text || "", /not blanket approval/, "reaction prompt rejects unrelated consequential approval");

	const logEntries = readFileSync(join(socketWorkingDir, "log.jsonl"), "utf8")
		.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(logEntries.length, 1, "the owning reaction writes one append-only evidence row");
	assert.equal(logEntries[0]?.sourceEventType, "slack_reaction_added");
	assert.equal(logEntries[0]?.threadTs, "1710000000.000050", "reaction evidence stays in the resolved thread");
	assert.equal(logEntries[0]?.targetMessageTs, "1710000000.000100");

	await onSocketReaction(idlePayload);
	await settle();
	assert.equal(apiLookups, 1, "Socket Mode retry dedupe happens before a repeated lookup");
	assert.equal(state.events.length, 1, "Socket Mode retry dedupe creates only one turn");
	assert.equal(readFileSync(join(socketWorkingDir, "log.jsonl"), "utf8").trim().split("\n").length, 1, "Socket Mode retry dedupe creates only one evidence row");

	await onSocketReaction({
		event: reactionEvent({
			channel: "D2222222222",
			messageTs: "1710000001.000200",
			eventTs: "1710000104.000100",
		}),
		body: { team_id: TEAM_ID, event_id: "Ev5555555555" },
		ack: () => { acknowledgements++; },
	});
	await settle();
	assert.equal(state.events.length, 2, "an allowlisted DM reaction can start a direct turn");
	assert.equal(state.events[1]?.type, "dm");

	await onSocketReaction({
		event: reactionEvent({
			channel: "C2222222222",
			messageTs: "1710000002.000300",
			eventTs: "1710000105.000100",
			reaction: "eyes",
		}),
		body: { team_id: TEAM_ID, event_id: "Ev6666666666" },
		ack: () => { acknowledgements++; },
	});
	assert.equal(state.steers.length, 1, "an owner reaction steers an already-running channel");
	assert.equal(state.steers[0]?.sourceEventType, "slack_reaction_added");
	assert.equal(state.events.length, 2, "busy reaction steering does not start a parallel run");
	assert.equal(state.slashCalls, 0, "reactions bypass slash-command routing");
	assert.equal(state.pendingCalls, 0, "reactions bypass pending free-text input");
	assert.equal(state.stopCalls, 0, "reactions bypass stop handling");
	assert.equal(pulseCalls, 0, "reaction steering does not enter channel pulse");
	assert.equal(ambientCalls, 0, "reaction steering does not enter ambient engagement");

	const fallback = collectSlackThreadMessagesFromLog(
		socketWorkingDir,
		"slack:C1111111111:1710000000.000050",
	);
	assert.equal(fallback?.messages.length, 1, "read_thread log fallback retains the reaction evidence in its thread");
	assert.equal(fallback?.messages[0]?.sourceEventType, "slack_reaction_added");
	assert.match(fallback?.messages[0]?.text || "", /reacted with :thumbsup:/, "fallback reaction evidence is useful without live Slack access");

	const webhookState: HandlerState = {
		events: [],
		steers: [],
		running: new Set(["C4444444444"]),
		isRunningCalls: 0,
		slashCalls: 0,
		pendingCalls: 0,
		stopCalls: 0,
	};
	let webhookLookups = 0;
	let webhookPulseCalls = 0;
	let webhookAmbientCalls = 0;
	let releaseLookup!: () => void;
	const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
	const webhook = new SlackWebhookAdapter({
		botToken: "xoxb-test",
		signingSecret: "fake-signing-secret",
		workingDir: webhookWorkingDir,
		store: store(),
		pulse: {
			record: () => { webhookPulseCalls++; },
			setSelfId: () => {},
		} as unknown as ChannelPulse,
		onAmbientMessage: () => { webhookAmbientCalls++; },
	});
	webhook.setHandler(makeHandler(webhookState));
	(webhook as any).botUserId = BOT_ID;
	(webhook as any).webClient = {
		reactions: {
			get: async ({ timestamp }: { timestamp: string }) => {
				webhookLookups++;
				if (timestamp === "1710000003.000399") {
					return { message: { ts: timestamp, text: "Another app's message." } };
				}
				await lookupGate;
				return { message: { ts: timestamp, text: "Webhook-owned message." } };
			},
		},
	};
	await (webhook as any).dispatchEvent({
		type: "event_callback",
		team_id: TEAM_ID,
		event_id: "Ev7000000000",
		event: reactionEvent({
			channel: "C3333333333",
			messageTs: "1710000003.000399",
			eventTs: "1710000106.000099",
			itemUser: OTHER_BOT_ID,
		}),
	}, {
		writeHead() { return this; },
		end() { return this; },
	});
	assert.equal(webhookLookups, 0, "webhook non-owner filtering also happens before Slack API lookup");
	assert.equal(webhookPulseCalls, 0, "webhook non-owner filtering happens before channel pulse");
	assert.equal(webhookAmbientCalls, 0, "webhook non-owner reactions never reach ambient engagement");
	assert.equal(webhookState.isRunningCalls, 0, "webhook non-owner reactions never reach wake routing");
	assert.equal(webhookState.events.length, 0, "webhook non-owner reactions create no prompt/run");
	assert.equal(existsSync(join(webhookWorkingDir, "log.jsonl")), false, "webhook non-owner reactions create no workspace log evidence");

	const webhookPayload = {
		type: "event_callback",
		team_id: TEAM_ID,
		event_id: "Ev7777777777",
		event: reactionEvent({
			channel: "C3333333333",
			messageTs: "1710000003.000400",
			eventTs: "1710000106.000100",
		}),
	};
	const response = {
		status: 0,
		ended: false,
		writeHead(status: number) { this.status = status; return this; },
		end() { this.ended = true; return this; },
	};
	const webhookProcessing = (webhook as any).dispatchEvent(webhookPayload, response);
	assert.equal(response.status, 200, "the webhook acknowledges reaction_added before message lookup completes");
	assert.equal(response.ended, true, "the webhook response ends immediately");
	releaseLookup();
	await webhookProcessing;
	await webhook.lastRunDone;
	assert.equal(webhookState.events.length, 1, "the webhook adapter gives owner reactions the same idle-run behavior");
	assert.equal(webhookState.events[0]?.sourceEventType, "slack_reaction_added");
	assert.equal(webhookState.events[0]?.directlyAddressed, true);

	await (webhook as any).dispatchEvent(webhookPayload, {
		writeHead() { return this; },
		end() { return this; },
	});
	assert.equal(webhookLookups, 1, "webhook retry dedupe happens before a repeated lookup");
	assert.equal(webhookState.events.length, 1, "webhook retry dedupe creates only one turn");

	await (webhook as any).dispatchEvent({
		...webhookPayload,
		event_id: "Ev8888888888",
		event: reactionEvent({
			channel: "C4444444444",
			messageTs: "1710000004.000500",
			eventTs: "1710000107.000100",
		}),
	}, {
		writeHead() { return this; },
		end() { return this; },
	});
	assert.equal(webhookState.steers.length, 1, "the webhook adapter gives owner reactions the same busy-steer behavior");

	const signedPayload = {
		type: "event_callback",
		team_id: TEAM_ID,
		event_id: "Ev9999999999",
		event: reactionEvent({
			channel: "C3333333333",
			messageTs: "1710000005.000550",
			eventTs: "1710000108.000100",
		}),
	};
	const signedBody = JSON.stringify(signedPayload);
	const signedTimestamp = Math.floor(Date.now() / 1000).toString();
	const signedRequest = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
	signedRequest.headers = {
		"x-slack-request-timestamp": signedTimestamp,
		"x-slack-signature": `v0=${createHmac("sha256", "fake-signing-secret")
			.update(`v0:${signedTimestamp}:${signedBody}`)
			.digest("hex")}`,
	};
	const signedResponse = {
		status: 0,
		ended: false,
		writeHead(status: number) { this.status = status; return this; },
		end() { this.ended = true; return this; },
	};
	webhook.dispatch(signedRequest as any, signedResponse as any);
	signedRequest.emit("data", Buffer.from(signedBody));
	signedRequest.emit("end");
	await settle();
	await webhook.lastRunDone;
	assert.equal(signedResponse.status, 200, "a correctly signed reaction webhook is acknowledged");
	assert.equal(signedResponse.ended, true);
	assert.equal(webhookState.events.length, 2, "the signed webhook ingress creates the same owner reaction turn");

	const reactionCalls: Array<{ channel: string; messageTs: string; emoji: string }> = [];
	let postedText = 0;
	const reactionAdapter = {
		name: "slack",
		addReaction: async (channel: string, messageTs: string, emoji: string) => {
			reactionCalls.push({ channel, messageTs, emoji });
		},
		postMessage: async () => { postedText++; return "1710000999.000100"; },
		postInThread: async () => { postedText++; return "1710000999.000200"; },
	} as unknown as PlatformAdapter;
	const reactTool = createReactToMessageTool([reactionAdapter]);
	assert.equal(Check(reactTool.parameters, {
		label: "Acknowledge the exact update",
		show: true,
		target: "slack:C5555555555:1710000005.000600",
		emoji: ":thumbsup:",
	}), true, "react_to_message accepts a safe label, optional show flag, exact target, and colon-wrapped emoji");
	assert.equal(Check(reactTool.parameters, {
		target: "slack:C5555555555:1710000005.000600",
		emoji: "thumbsup",
	}), false, "react_to_message requires a label");
	assert.equal(Check(reactTool.parameters, {
		label: "   ",
		target: "slack:C5555555555:1710000005.000600",
		emoji: "thumbsup",
	}), false, "react_to_message schema rejects an unsafe blank label");
	await assert.rejects(
		(reactTool.execute as any)("blank-label", { label: "  ", target: "slack:C5555555555:1710000005.000600", emoji: "thumbsup" }),
		/requires a nonblank label/,
	);
	await assert.rejects(
		(reactTool.execute as any)("non-slack", { label: "Reject another platform", target: "mattermost:mmmmmmmmmmmmmmmmmmmmmmmmmm:nnnnnnnnnnnnnnnnnnnnnnnnnn", emoji: "thumbsup" }),
		/exact Slack message target/,
	);
	await assert.rejects(
		(reactTool.execute as any)("channel-only", { label: "Reject a channel guess", target: "C5555555555", emoji: "thumbsup" }),
		/exact Slack message target/,
	);
	await assert.rejects(
		(reactTool.execute as any)("invalid-emoji", { label: "Reject malformed emoji", target: "slack:C5555555555:1710000005.000600", emoji: "::thumbs up::" }),
		/valid Slack emoji name/,
	);
	await (reactTool.execute as any)("valid-reaction", {
		label: "Acknowledge the exact update",
		target: "slack:C5555555555:1710000005.000600",
		emoji: ":thumbsup:",
	});
	assert.deepEqual(reactionCalls, [{
		channel: "C5555555555",
		messageTs: "1710000005.000600",
		emoji: "thumbsup",
	}], "react_to_message normalizes the emoji and calls the Slack reaction API exactly once");
	assert.equal(postedText, 0, "react_to_message never posts Slack text");
	await withHostDeliveryScope({
		source: "mcp-operator",
		eventId: "00000000-0000-4000-8000-000000000001",
		replyTarget: "phone-0123456789abcdef0123",
	}, async () => {
		await assert.rejects(
			(reactTool.execute as any)("relationship-reaction", {
				label: "Must stay relationship-scoped",
				target: "slack:C5555555555:1710000005.000600",
				emoji: "thumbsup",
			}),
			/Reactions are unavailable during an MCP relationship turn/,
		);
	});
	assert.equal(reactionCalls.length, 1, "MCP relationship turns cannot react outside the bound recipient");

	const live = new LiveThreadSlackAdapter({
		botToken: "xoxb-test",
		workingDir: liveWorkingDir,
		store: store(),
	});
	live.configure({
		conversations: {
			replies: async () => ({
				messages: [{
					ts: "1710000006.000700",
					user: BOT_ID,
					text: "Live transcript message with reactions.",
					reactions: [{
						name: "thumbsup",
						count: 2,
						users: [REACTOR_ID, OTHER_BOT_ID],
					}],
				}],
				response_metadata: {},
			}),
		},
	});
	const liveResult = await collectThreadMessages(
		liveWorkingDir,
		"slack:C7777777777:1710000006.000700",
		[live],
	);
	assert.equal(liveResult?.source, "slack-api");
	assert.deepEqual(liveResult?.messages[0]?.reactions, [{
		emoji: "thumbsup",
		count: 2,
		reactors: ["Example Reactor", OTHER_BOT_ID],
	}], "live read_thread preserves counts and resolves reactor names when metadata is available");
	const liveTranscript = formatThreadTranscript(liveResult!);
	assert.match(liveTranscript, /Reactions: :thumbsup: ×2 \(Example Reactor, U3333333333\)/, "formatted live transcript surfaces reaction summaries");

	console.log("slack-reactions ok");
} finally {
	rmSync(socketWorkingDir, { recursive: true, force: true });
	rmSync(webhookWorkingDir, { recursive: true, force: true });
	rmSync(liveWorkingDir, { recursive: true, force: true });
}
