import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceDeliveryLedger } from "../src/adapters/workspace-channel-runtime.js";
import { ZulipWebhookAdapter } from "../src/adapters/zulip-webhook.js";
import { ChannelStore } from "../src/store.js";

const CHANNEL_ID = "4";
const OTHER_CHANNEL_ID = "5";
const OUT_OF_SCOPE_CHANNEL_ID = "6";
const PROXY_TOKEN = "context-proxy-token";
const INBOUND_TOKEN = "context-inbound-token";
const RECEIPT_TOKEN = "context-receipt-token";
const receipts: string[] = [];
const outboundBodies: URLSearchParams[] = [];
const updateBodies: URLSearchParams[] = [];
let deleteCount = 0;
let nextMessageId = 100;
let subscribedStreams = [
	{ stream_id: Number(CHANNEL_ID), name: "customer · Casey", topics_policy: "empty_topic_only" },
	{ stream_id: Number(OTHER_CHANNEL_ID), name: "projects", topics_policy: "disable_empty_topic" },
];

async function readBody(request: import("node:http").IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

const upstream = createServer(async (request, response) => {
	const url = new URL(request.url || "/", "http://127.0.0.1");
	const send = (status: number, value: unknown) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	};
	if (url.pathname === "/receipt") {
		assert.equal(request.headers.authorization, `Bearer ${RECEIPT_TOKEN}`);
		const body = JSON.parse((await readBody(request)).toString("utf8"));
		receipts.push(body.status);
		send(200, { ok: true });
		return;
	}
	assert.equal(request.headers.authorization, `Bearer ${PROXY_TOKEN}`);
	if (request.method === "GET" && url.pathname === "/api/v1/users/me") {
		send(200, {
			result: "success",
			msg: "",
			user_id: 9,
			email: "agent@example.com",
			full_name: "Operator",
			is_bot: true,
		});
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/v1/streams") {
		send(200, { result: "success", msg: "", streams: subscribedStreams });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/v1/messages") {
		const body = new URLSearchParams((await readBody(request)).toString("utf8"));
		outboundBodies.push(body);
		send(200, { result: "success", msg: "", id: nextMessageId++ });
		return;
	}
	if (request.method === "PATCH" && /^\/api\/v1\/messages\/\d+$/.test(url.pathname)) {
		updateBodies.push(new URLSearchParams((await readBody(request)).toString("utf8")));
		send(200, { result: "success", msg: "" });
		return;
	}
	if (request.method === "DELETE" && /^\/api\/v1\/messages\/\d+$/.test(url.pathname)) {
		deleteCount += 1;
		send(200, { result: "success", msg: "" });
		return;
	}
	send(404, { result: "error", msg: "not found" });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddress = upstream.address() as AddressInfo;

const workingDir = mkdtempSync(join(tmpdir(), "zulip-host-managed-"));
const store = new ChannelStore({ workingDir, botToken: PROXY_TOKEN });
const handled: any[] = [];
const ambient: any[] = [];
const stopped: any[] = [];
const steered: any[] = [];
const pulseRecords: any[] = [];
let running = false;
let releaseRestartClaim: (() => void) | undefined;
const restartClaimGate = new Promise<void>((resolve) => {
	releaseRestartClaim = resolve;
});
const adapter = new ZulipWebhookAdapter({
	url: `http://127.0.0.1:${upstreamAddress.port}`,
	botToken: PROXY_TOKEN,
	inboundToken: INBOUND_TOKEN,
	agentName: "Operator",
	workingDir,
	store,
	pulse: {
		setSelfId: () => {},
		record: (...args: any[]) => pulseRecords.push(args),
	} as any,
	directChannelMessages: false,
	channelRefreshMs: 20,
	onAmbientMessage: (_channelId, event) => ambient.push(event),
});
adapter.setHandler({
	isRunning: () => running,
	handleEvent: async (event: any) => {
		handled.push(event);
		if (event.ts === "96") await restartClaimGate;
		return { yielded: false };
	},
	handleSlashCommand: async () => false,
	handleSteer: (event: any) => steered.push(event),
	handleStop: async (_channelId: string, _adapter: unknown, event: any) => {
		stopped.push(event);
	},
	resolvePendingInput: () => false,
} as any);

const inbound = createServer((request, response) => adapter.dispatch(request, response));
await new Promise<void>((resolve) => inbound.listen(0, "127.0.0.1", resolve));
const inboundAddress = inbound.address() as AddressInfo;

try {
	await adapter.start();
	assert.equal(adapter.getUser("9")?.displayName, "Operator");
	assert.equal(adapter.getChannel(CHANNEL_ID)?.name, "customer · Casey");
	assert.equal(adapter.getChannel(OTHER_CHANNEL_ID)?.name, "projects");
	await assert.rejects(
		adapter.postMessage(OUT_OF_SCOPE_CHANNEL_ID, "cross-context attempt"),
		/not a current known subscription/,
	);
	await assert.rejects(
		adapter.postMessage(OTHER_CHANNEL_ID, "missing topic"),
		/requires a topic target/,
	);

	const inboundResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deliveryId: "delivery-one",
			message: {
				id: 88,
				type: "stream",
				stream_id: Number(CHANNEL_ID),
				display_recipient: "customer · Casey",
				subject: "",
				sender_id: 8,
				sender_email: "casey@example.com",
				sender_full_name: "Casey",
				sender_is_bot: false,
				timestamp: Math.floor(Date.now() / 1000),
				content: "<p>Please review the customer note.</p>",
				raw_content: "Please review the customer note.",
				flags: ["mentioned"],
			},
			hostReceipt: {
				url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
				token: RECEIPT_TOKEN,
				leaseToken: "lease-one",
			},
		}),
	});
	assert.equal(inboundResponse.status, 202);
	for (let index = 0; index < 100 && !receipts.includes("completed"); index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual(receipts, ["running", "completed"]);
	assert.equal(handled.length, 1);
	assert.equal(handled[0].channel, CHANNEL_ID);
	assert.equal(handled[0].text, "Please review the customer note.");
	assert.equal(handled[0].threadTs, undefined);
	assert.equal(handled[0].replyTarget, `zulip:${CHANNEL_ID}`);
	assert.equal(handled[0].directlyAddressed, true);
	assert.equal(handled[0].sourceEventType, "zulip_mention");

	const ambientResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deliveryId: "delivery-two",
			message: {
				id: 89,
				type: "stream",
				stream_id: Number(CHANNEL_ID),
				display_recipient: "customer · Casey",
				subject: "",
				sender_id: 8,
				sender_email: "casey@example.com",
				sender_full_name: "Casey",
				sender_is_bot: false,
				timestamp: Math.floor(Date.now() / 1000),
				content: "<p>Ambient crew update.</p>",
				raw_content: "Ambient crew update.",
				is_mentioned: false,
			},
			hostReceipt: {
				url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
				token: RECEIPT_TOKEN,
				leaseToken: "lease-two",
			},
		}),
	});
	assert.equal(ambientResponse.status, 202);
	for (let index = 0; index < 100 && ambient.length === 0; index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(ambient.length, 1);
	assert.equal(ambient[0].directlyAddressed, false);
	assert.equal(ambient[0].sourceEventType, "zulip_channel_message");
	assert.equal(ambient[0].replyTarget, `zulip:${CHANNEL_ID}`);
	assert.equal(handled.length, 1, "ordinary Zulip messages do not bypass ambient evaluation");
	assert.equal(pulseRecords.length, 2, "human mention and ambient traffic both reach pulse accounting");

	const dmResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deliveryId: "delivery-dm",
			message: {
				id: 92,
				type: "private",
				recipient_id: 18,
				display_recipient: [
					{ id: 8, email: "casey@example.com", full_name: "Casey" },
					{ id: 9, email: "agent@example.com", full_name: "Operator" },
				],
				sender_id: 8,
				sender_email: "casey@example.com",
				sender_full_name: "Casey",
				sender_is_bot: false,
				timestamp: Math.floor(Date.now() / 1000),
				content: "<p>Hello <strong>Operator</strong>.</p>",
			},
			hostReceipt: {
				url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
				token: RECEIPT_TOKEN,
				leaseToken: "lease-dm",
			},
		}),
	});
	assert.equal(dmResponse.status, 202);
	for (let index = 0; index < 100 && handled.length < 2; index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(adapter.getChannel("dm:8")?.name, "DM: Casey");
	assert.equal(handled[1].type, "dm");
	assert.equal(handled[1].channel, "dm:8");
	assert.equal(handled[1].text, "Hello **Operator**.");
	assert.equal(handled[1].sourceEventType, "zulip_dm");
	assert.equal(handled[1].replyTarget, "zulip:dm:8");
	assert.equal(handled[1].directlyAddressed, true);
	assert.equal(pulseRecords.length, 3, "Zulip DMs reach direct pulse accounting");

	const groupDmResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deliveryId: "delivery-group-dm",
			message: {
				id: 94,
				type: "private",
				recipient_id: 19,
				display_recipient: [
					{ id: 12, email: "teammate@example.com", full_name: "Teammate" },
					{ id: 9, email: "agent@example.com", full_name: "Operator" },
					{ id: 8, email: "casey@example.com", full_name: "Casey" },
				],
				sender_id: 8,
				sender_email: "casey@example.com",
				sender_full_name: "Casey",
				sender_is_bot: false,
				timestamp: Math.floor(Date.now() / 1000),
				content: "<p>Hello group.</p>",
			},
			hostReceipt: {
				url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
				token: RECEIPT_TOKEN,
				leaseToken: "lease-group-dm",
			},
		}),
	});
	assert.equal(groupDmResponse.status, 202);
	for (let index = 0; index < 100 && handled.length < 3; index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(adapter.getChannel("dm:8,12")?.name, "Group DM: Casey, Teammate");
	assert.equal(handled[2].type, "dm");
	assert.equal(handled[2].channel, "dm:8,12");
	assert.equal(handled[2].replyTarget, "zulip:dm:8,12");
	assert.equal(handled[2].directlyAddressed, true);
	assert.equal(pulseRecords.length, 4, "Zulip group DMs reach direct pulse accounting");

	running = true;
	const stopReceiptStart = receipts.length;
	const stopPayload = {
		deliveryId: "delivery-dm-stop",
		message: {
			id: 95,
			type: "private",
			recipient_id: 18,
			display_recipient: [
				{ id: 8, email: "casey@example.com", full_name: "Casey" },
				{ id: 9, email: "agent@example.com", full_name: "Operator" },
			],
			sender_id: 8,
			sender_email: "casey@example.com",
			sender_full_name: "Casey",
			sender_is_bot: false,
			timestamp: Math.floor(Date.now() / 1000),
			content: "<p>stop</p>",
			raw_content: "stop",
		},
		hostReceipt: {
			url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
			token: RECEIPT_TOKEN,
			leaseToken: "lease-dm-stop",
		},
	};
	const stopResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(stopPayload),
	});
	assert.equal(stopResponse.status, 202);
	for (let index = 0; index < 100 && receipts.length < stopReceiptStart + 2; index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(stopped.length, 1, "a bare Zulip DM reaches the stop handler while work is active");
	assert.equal(stopped[0].type, "dm");
	assert.equal(stopped[0].channel, "dm:8");
	assert.equal(stopped[0].sourceEventType, "zulip_dm");
	assert.equal(stopped[0].replyTarget, "zulip:dm:8");
	assert.equal(steered.length, 0, "a bare Zulip DM stop never degrades into busy steering");
	assert.equal(handled.length, 3, "a bare Zulip DM stop never starts an ordinary model turn");
	assert.deepEqual(receipts.slice(stopReceiptStart), ["running", "completed"]);
	const duplicateStopResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(stopPayload),
	});
	assert.equal(duplicateStopResponse.status, 202);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(stopped.length, 1, "replayed stop delivery remains deduplicated");
	running = false;

	const topicResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deliveryId: "delivery-topic",
			message: {
				id: 93,
				type: "stream",
				stream_id: Number(OTHER_CHANNEL_ID),
				display_recipient: "projects",
				subject: "Road map / alpha",
				sender_id: 8,
				sender_email: "casey@example.com",
				sender_full_name: "Casey",
				sender_is_bot: false,
				timestamp: Math.floor(Date.now() / 1000),
				content: "<p>Topic mention.</p>",
				flags: ["mentioned"],
			},
			hostReceipt: {
				url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
				token: RECEIPT_TOKEN,
				leaseToken: "lease-topic",
			},
		}),
	});
	assert.equal(topicResponse.status, 202);
	for (let index = 0; index < 100 && handled.length < 4; index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(handled[3].threadTs, "Road map / alpha");
	assert.equal(handled[3].replyTarget, "zulip:5:topic:Road%20map%20%2F%20alpha");
	assert.equal(handled[3].replyTargetDescription, "Zulip channel topic Road map / alpha");
	assert.equal(pulseRecords.length, 6, "topic mentions retain direct pulse accounting after the stop DM");

	for (const [id, flags, deliveryId, leaseToken] of [
		[90, undefined, "delivery-bot-ambient", "lease-bot-ambient"],
		[91, ["mentioned"], "delivery-bot-mention", "lease-bot-mention"],
	] as const) {
		const response = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${INBOUND_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				deliveryId,
				message: {
					id,
					type: "stream",
					stream_id: Number(CHANNEL_ID),
					display_recipient: "customer · Casey",
					subject: "",
					sender_id: 10,
					sender_email: "other-agent@example.com",
					sender_full_name: "Other Agent",
					sender_is_bot: true,
					timestamp: Math.floor(Date.now() / 1000),
					content: flags ? "<p>@Operator bot mention.</p>" : "<p>Bot ambient update.</p>",
					raw_content: flags ? "@**Operator** bot mention." : "Bot ambient update.",
					...(flags ? { flags } : { is_mentioned: false }),
				},
				hostReceipt: {
					url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
					token: RECEIPT_TOKEN,
					leaseToken,
				},
			}),
		});
		assert.equal(response.status, 202);
	}
	for (let index = 0; index < 100 && receipts.filter((status) => status === "completed").length < 9; index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(receipts.filter((status) => status === "completed").length, 9);
	const logEntries = readFileSync(join(workingDir, "log.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const otherBotEntries = logEntries.filter((entry) => entry.ts === "90" || entry.ts === "91");
	assert.equal(otherBotEntries.length, 2);
	assert(otherBotEntries.every((entry) => entry.isBot === true), "other-bot messages are recorded as bot traffic");
	assert.equal(pulseRecords.length, 7, "explicit other-bot mentions reach direct pulse accounting");
	assert.equal(ambient.length, 1, "passive other-bot traffic never reaches ambient evaluation");
	assert.equal(handled.length, 5, "explicit other-bot mentions reach direct handling exactly once");
	assert.equal(handled[4].directlyAddressed, true);
	assert.equal(handled[4].sourceEventType, "zulip_mention");

	const restartClaimPayload = {
		deliveryId: "delivery-restart-claim",
		message: {
			id: 96,
			type: "private",
			recipient_id: 18,
			display_recipient: [
				{ id: 8, email: "casey@example.com", full_name: "Casey" },
				{ id: 9, email: "agent@example.com", full_name: "Operator" },
			],
			sender_id: 8,
			sender_email: "casey@example.com",
			sender_full_name: "Casey",
			sender_is_bot: false,
			timestamp: Math.floor(Date.now() / 1000),
			content: "<p>Keep this accepted turn restart-safe.</p>",
			raw_content: "Keep this accepted turn restart-safe.",
		},
		hostReceipt: {
			url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
			token: RECEIPT_TOKEN,
			leaseToken: "lease-restart-claim",
		},
	};
	const restartClaimResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(restartClaimPayload),
	});
	assert.equal(restartClaimResponse.status, 202);
	for (let index = 0; index < 100 && !handled.some((event) => event.ts === "96"); index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(
		handled.filter((event) => event.ts === "96").length,
		1,
		"the claimed delivery starts one turn",
	);
	const replayedClaimResponse = await fetch(`http://127.0.0.1:${inboundAddress.port}/zulip/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			...restartClaimPayload,
			hostReceipt: {
				...restartClaimPayload.hostReceipt,
				leaseToken: "lease-replayed-restart-claim",
			},
		}),
	});
	assert.equal(replayedClaimResponse.status, 202);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(
		handled.filter((event) => event.ts === "96").length,
		1,
		"a replay cannot launch an accepted in-flight turn again",
	);
	const restartClaimRecordsBeforeCompletion = readFileSync(
		join(workingDir, "zulip-inbound-deliveries.jsonl"),
		"utf8",
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((record) => record.deliveryId === restartClaimPayload.deliveryId);
	assert.equal(restartClaimRecordsBeforeCompletion.length, 1);
	assert.equal(typeof restartClaimRecordsBeforeCompletion[0].claimedAt, "string");
	const restartedLedger = new WorkspaceDeliveryLedger(
		join(workingDir, "zulip-inbound-deliveries.jsonl"),
		"restart-safe delivery ledger is unreadable",
	);
	assert.equal(
		restartedLedger.claim(restartClaimPayload.deliveryId),
		false,
		"a fresh resident process reloads and retains the in-flight claim",
	);
	releaseRestartClaim?.();
	for (let index = 0; index < 100; index++) {
		const records = readFileSync(join(workingDir, "zulip-inbound-deliveries.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((record) => record.deliveryId === restartClaimPayload.deliveryId);
		if (records.some((record) => typeof record.completedAt === "string")) break;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	const restartClaimRecords = readFileSync(join(workingDir, "zulip-inbound-deliveries.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((record) => record.deliveryId === restartClaimPayload.deliveryId);
	assert.equal(restartClaimRecords.length, 2);
	assert.equal(typeof restartClaimRecords[1].completedAt, "string");

	const posted = await adapter.postMessage(CHANNEL_ID, "Customer review is ready.");
	assert.equal(posted, "100");
	assert.equal(outboundBodies[0].get("to"), CHANNEL_ID);
	assert.equal(outboundBodies[0].get("topic"), "");
	assert.equal(outboundBodies[0].get("content"), "Customer review is ready.");
	const directPosted = await adapter.postMessage("dm:8", "Direct review is ready.");
	assert.equal(directPosted, "101");
	assert.equal(outboundBodies[1].get("type"), "direct");
	assert.equal(outboundBodies[1].get("to"), "[8]");
	assert.equal(outboundBodies[1].get("content"), "Direct review is ready.");
	const topicPosted = await adapter.postInThread(OTHER_CHANNEL_ID, "Roadmap", "Topic update.");
	assert.equal(topicPosted, "102");
	assert.equal(outboundBodies[2].get("type"), "channel");
	assert.equal(outboundBodies[2].get("to"), OTHER_CHANNEL_ID);
	assert.equal(outboundBodies[2].get("topic"), "Roadmap");
	const groupDirectPosted = await adapter.postMessage("dm:8,12", "Group direct review is ready.");
	assert.equal(groupDirectPosted, "103");
	assert.equal(outboundBodies[3].get("type"), "direct");
	assert.equal(outboundBodies[3].get("to"), "[8,12]");
	assert.equal(outboundBodies[3].get("content"), "Group direct review is ready.");

	const working = adapter.createWorkingOutputContext(
		{ platform: "zulip", channelId: CHANNEL_ID },
		store,
		{ toolStreaming: "all", presentation: "split", windowMinutes: 1 },
	);
	await working.setWorking(true);
	await working.respond("_→ Operator is reviewing the customer workspace_", false, { show: true });
	await working.respond("_→ Operator is checking the result_", false, { show: true });
	await working.setWorking(false);
	assert(
		outboundBodies.some((body) => String(body.get("content")).includes("reviewing the customer workspace")),
		"fixed Zulip working output surfaces selected work labels",
	);
	assert(
		updateBodies.some((body) => String(body.get("content")).includes("checking the result")),
		"Zulip working output edits Operator's existing working message",
	);
	await working.deleteMessage();
	assert.equal(deleteCount, 1);

	subscribedStreams = [
		{ stream_id: Number(CHANNEL_ID), name: "customer · Casey", topics_policy: "empty_topic_only" },
		{ stream_id: 7, name: "new project", topics_policy: "disable_empty_topic" },
	];
	for (let index = 0; index < 50 && (!adapter.getChannel("7") || adapter.getChannel(OTHER_CHANNEL_ID)); index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(adapter.getChannel("7")?.name, "new project", "new subscriptions appear without a restart");
	assert.equal(adapter.getChannel(OTHER_CHANNEL_ID), undefined, "removed subscriptions disappear without a restart");
} finally {
	await adapter.stop();
	await new Promise<void>((resolve) => inbound.close(() => resolve()));
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("zulip host-managed ok");
