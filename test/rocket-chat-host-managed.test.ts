import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RocketChatWebhookAdapter } from "../src/adapters/rocket-chat-webhook.js";
import { ChannelStore } from "../src/store.js";

const HUMAN_ID = "humanOperator123";
const ROOM_ID = "roomCustomer123";
const OTHER_ROOM_ID = "roomOutsideScope123";
const MESSAGE_ID = "messageInbound123";
const AGENT_MESSAGE_ID = "messageAgent123";
const FILE_ID = "fileInbound123";
const FILE_CONTENT = "customer attachment";
const PROXY_TOKEN = "context-proxy-token";
const INBOUND_TOKEN = "context-inbound-token";
const RECEIPT_TOKEN = "context-receipt-token";
const receipts: string[] = [];
const outboundBodies: Array<Record<string, unknown>> = [];
const updateBodies: Array<Record<string, unknown>> = [];
const deleteBodies: Array<Record<string, unknown>> = [];

async function readJson(request: import("node:http").IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const upstream = createServer(async (request, response) => {
	const url = new URL(request.url || "/", "http://127.0.0.1");
	const send = (status: number, value: unknown) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	};
	if (url.pathname === "/receipt") {
		assert.equal(request.headers.authorization, `Bearer ${RECEIPT_TOKEN}`);
		const body = await readJson(request);
		receipts.push(body.status);
		send(200, { ok: true });
		return;
	}
	assert.equal(request.headers.authorization, `Bearer ${PROXY_TOKEN}`);
	if (request.method === "GET" && url.pathname === "/api/v1/me") {
		send(200, {
			success: true,
			_id: "mannyAgent123",
			username: "operator-customer",
			name: "Operator",
			roles: ["user", "bot"],
		});
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/v1/groups.info") {
		assert.equal(url.searchParams.get("roomId"), ROOM_ID);
		send(200, {
			success: true,
			group: { _id: ROOM_ID, name: "customer-opaque", fname: "Customer website", t: "p" },
		});
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/v1/chat.postMessage") {
		const body = await readJson(request);
		outboundBodies.push(body);
		send(200, {
			success: true,
			message: {
				_id: AGENT_MESSAGE_ID,
				rid: ROOM_ID,
				msg: body.text,
				tmid: body.tmid,
				u: { _id: "tinyfat-agent", username: "agent", name: "Front Desk" },
			},
		});
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/v1/chat.update") {
		updateBodies.push(await readJson(request));
		send(200, { success: true, message: { _id: AGENT_MESSAGE_ID, rid: ROOM_ID } });
		return;
	}
	if (request.method === "POST" && url.pathname === "/api/v1/chat.delete") {
		deleteBodies.push(await readJson(request));
		send(200, { success: true });
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/v1/chat.getThreadMessages") {
		send(200, {
			success: true,
			messages: [
				{
					_id: MESSAGE_ID,
					rid: ROOM_ID,
					msg: "Please ship the private review.",
					u: { _id: HUMAN_ID, username: "operator", name: "Operator" },
				},
			],
		});
		return;
	}
	if (
		request.method === "GET"
		&& url.pathname === `/api/v1/files/${MESSAGE_ID}/${FILE_ID}/brief.txt`
	) {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end(FILE_CONTENT);
		return;
	}
	send(404, { success: false, error: "not_found" });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddress = upstream.address() as AddressInfo;

const workingDir = mkdtempSync(join(tmpdir(), "rocket-chat-host-managed-"));
const store = new ChannelStore({ workingDir, botToken: PROXY_TOKEN });
const handled: any[] = [];
const adapter = new RocketChatWebhookAdapter({
	url: `http://127.0.0.1:${upstreamAddress.port}`,
	botToken: PROXY_TOKEN,
	inboundToken: INBOUND_TOKEN,
	agentName: "Front Desk",
	workingDir,
	store,
	allowedRoomIds: [ROOM_ID],
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
	assert.equal(adapter.getUser("mannyAgent123")?.displayName, "Operator");
	assert.equal(adapter.getChannel(ROOM_ID)?.name, "Customer website");
	assert.equal(adapter.getChannel(OTHER_ROOM_ID), undefined);
	await assert.rejects(
		adapter.postMessage(OTHER_ROOM_ID, "cross-context attempt"),
		/outside this agent's allowed scope/,
	);

	const response = await fetch(`http://127.0.0.1:${inboundAddress.port}/rocketchat/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deliveryId: "delivery-one",
			message: {
				_id: MESSAGE_ID,
				rid: ROOM_ID,
				msg: "Please ship the private review.",
				ts: new Date().toISOString(),
				u: { _id: HUMAN_ID, username: "operator", name: "Operator" },
				file: { _id: FILE_ID, name: "brief.txt", type: "text/plain" },
				files: [{ _id: FILE_ID, name: "brief.txt", type: "text/plain" }],
			},
			hostReceipt: {
				url: `http://127.0.0.1:${upstreamAddress.port}/receipt`,
				token: RECEIPT_TOKEN,
				leaseToken: "lease-one",
			},
		}),
	});
	assert.equal(response.status, 202);
	for (let index = 0; index < 100 && !receipts.includes("completed"); index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual(receipts, ["running", "completed"]);
	assert.equal(handled.length, 1);
	assert.equal(handled[0].channel, ROOM_ID);
	assert.equal(handled[0].threadTs, MESSAGE_ID);
	assert.equal(handled[0].directlyAddressed, true);
	assert.equal(handled[0].replyTarget, `rocket-chat:${ROOM_ID}:${MESSAGE_ID}`);
	assert.deepEqual(handled[0].attachments.map((attachment: any) => attachment.original), ["brief.txt"]);
	const attachmentPath = join(workingDir, handled[0].attachments[0].local);
	for (let index = 0; index < 100 && !existsSync(attachmentPath); index++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(readFileSync(attachmentPath, "utf8"), FILE_CONTENT);

	const posted = await adapter.postInThread(ROOM_ID, MESSAGE_ID, "The private review is ready.");
	assert.equal(posted, AGENT_MESSAGE_ID);
	assert.equal(outboundBodies.length, 1);
	assert.equal(outboundBodies[0].roomId, ROOM_ID);
	assert.equal(outboundBodies[0].tmid, MESSAGE_ID);
	assert.match(String(outboundBodies[0].tinyfatEventId), /^rocket-chat:[0-9a-f-]{36}$/);

	const transcript = await adapter.readThread(ROOM_ID, MESSAGE_ID);
	assert.equal(transcript[0].sender, "Operator");
	assert.equal(transcript[0].text, "Please ship the private review.");

	const working = adapter.createWorkingOutputContext(
		{ platform: "rocket-chat", channelId: ROOM_ID },
		store,
		{ toolStreaming: "all", presentation: "split", windowMinutes: 1 },
	);
	await working.setWorking(true);
	await working.respond("_→ Operator is assembling the preview_", false, { show: true });
	await working.respond("_→ Operator is checking the deployment_", false, { show: true });
	await working.setWorking(false);
	assert(
		outboundBodies.some((body) => String(body.text).includes("Operator is assembling the preview")),
		"fixed Rocket.Chat working output surfaces sanitized work labels",
	);
	assert(
		updateBodies.some((body) => String(body.text).includes("Operator is checking the deployment")),
		"Rocket.Chat working output edits the existing Operator message like Mattermost",
	);
	await working.deleteMessage();
	assert.equal(deleteBodies.length, 1, "Rocket.Chat working messages can be cleaned up like Mattermost");
} finally {
	await adapter.stop();
	await new Promise<void>((resolve) => inbound.close(() => resolve()));
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("rocket chat host-managed ok");
