import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MattermostSocketAdapter } from "../src/adapters/mattermost-socket.js";
import { ChannelStore } from "../src/store.js";

const BOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const HUMAN_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHANNEL_ID = "cccccccccccccccccccccccccc";
const TEAM_ID = "dddddddddddddddddddddddddd";
const PROXY_TOKEN = "context-proxy-token";
const INBOUND_TOKEN = "context-inbound-token";
const RECEIPT_TOKEN = "context-receipt-token";
const receipts: string[] = [];

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
	if (url.pathname === "/api/v4/users/me") return send(200, { id: BOT_ID, username: "operator-private", is_bot: true });
	if (url.pathname === `/api/v4/users/${HUMAN_ID}`) {
		return send(200, { id: HUMAN_ID, username: "casey", first_name: "Casey", is_bot: false });
	}
	if (url.pathname === "/api/v4/users/me/teams") return send(200, [{ id: TEAM_ID, name: "tinyfat" }]);
	if (url.pathname === `/api/v4/users/me/teams/${TEAM_ID}/channels`) {
		return send(200, [{ id: CHANNEL_ID, name: "private", display_name: "Private Operator", type: "P", team_id: TEAM_ID }]);
	}
	send(404, { error: "not_found" });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddress = upstream.address() as AddressInfo;

const workingDir = mkdtempSync(join(tmpdir(), "mattermost-host-managed-"));
const store = new ChannelStore({ workingDir, botToken: PROXY_TOKEN });
const handled: any[] = [];
const adapter = new MattermostSocketAdapter({
	url: `http://127.0.0.1:${upstreamAddress.port}`,
	botToken: PROXY_TOKEN,
	inboundToken: INBOUND_TOKEN,
	webhookOnly: true,
	workingDir,
	store,
	allowedChannelIds: [CHANNEL_ID],
	directChannelMessages: true,
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
	const response = await fetch(`http://127.0.0.1:${inboundAddress.port}/mattermost/inbound`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${INBOUND_TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deliveryId: "delivery-one",
			post: {
				id: "eeeeeeeeeeeeeeeeeeeeeeeeee",
				create_at: Date.now(),
				user_id: HUMAN_ID,
				channel_id: CHANNEL_ID,
				message: "please ship the private site",
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
	assert.equal(handled[0].channel, CHANNEL_ID);
	assert.equal(handled[0].directlyAddressed, true);
} finally {
	await adapter.stop();
	await new Promise<void>((resolve) => inbound.close(() => resolve()));
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("mattermost host-managed ok");
