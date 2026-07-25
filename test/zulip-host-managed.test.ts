import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZulipWebhookAdapter } from "../src/adapters/zulip-webhook.js";
import { ChannelStore } from "../src/store.js";

const CHANNEL_ID = "4";
const OTHER_CHANNEL_ID = "5";
const PROXY_TOKEN = "context-proxy-token";
const INBOUND_TOKEN = "context-inbound-token";
const RECEIPT_TOKEN = "context-receipt-token";
const receipts: string[] = [];
const outboundBodies: URLSearchParams[] = [];
const updateBodies: URLSearchParams[] = [];
let deleteCount = 0;
let nextMessageId = 100;

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
		send(200, {
			result: "success",
			msg: "",
			streams: [{
				stream_id: Number(CHANNEL_ID),
				name: "customer · Casey",
				topics_policy: "empty_topic_only",
			}],
		});
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
const adapter = new ZulipWebhookAdapter({
	url: `http://127.0.0.1:${upstreamAddress.port}`,
	botToken: PROXY_TOKEN,
	inboundToken: INBOUND_TOKEN,
	agentName: "Operator",
	workingDir,
	store,
	allowedChannelIds: [CHANNEL_ID],
	directChannelMessages: false,
	onAmbientMessage: (_channelId, event) => ambient.push(event),
});
adapter.setHandler({
	isRunning: () => false,
	handleEvent: async (event: any) => {
		handled.push(event);
		return { yielded: false };
	},
	handleSlashCommand: async () => false,
	handleSteer: () => {},
	handleStop: async () => {},
	resolvePendingInput: () => false,
} as any);

const inbound = createServer((request, response) => adapter.dispatch(request, response));
await new Promise<void>((resolve) => inbound.listen(0, "127.0.0.1", resolve));
const inboundAddress = inbound.address() as AddressInfo;

try {
	await adapter.start();
	assert.equal(adapter.getUser("9")?.displayName, "Operator");
	assert.equal(adapter.getChannel(CHANNEL_ID)?.name, "customer · Casey");
	assert.equal(adapter.getChannel(OTHER_CHANNEL_ID), undefined);
	await assert.rejects(
		adapter.postMessage(OTHER_CHANNEL_ID, "cross-context attempt"),
		/outside this agent's allowed scope/,
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
				timestamp: Math.floor(Date.now() / 1000),
				content: "<p>Please review the customer note.</p>",
				raw_content: "Please review the customer note.",
				is_mentioned: true,
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

	const posted = await adapter.postMessage(CHANNEL_ID, "Customer review is ready.");
	assert.equal(posted, "100");
	assert.equal(outboundBodies[0].get("to"), CHANNEL_ID);
	assert.equal(outboundBodies[0].get("topic"), "");
	assert.equal(outboundBodies[0].get("content"), "Customer review is ready.");

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
} finally {
	await adapter.stop();
	await new Promise<void>((resolve) => inbound.close(() => resolve()));
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("zulip host-managed ok");
