import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZulipWebhookAdapter } from "../src/adapters/zulip-webhook.js";
import { ChannelStore } from "../src/store.js";

// Reproduces a pedicab customer channel: the Operator receives every channel
// message (directChannelMessages=true) alongside Pedro and the Text rider bot.
const CHANNEL_ID = "4";
const PROXY_TOKEN = "proxy-token";
const INBOUND_TOKEN = "inbound-token";

const upstream = createServer(async (request, response) => {
	const url = new URL(request.url || "/", "http://127.0.0.1");
	const send = (status: number, value: unknown) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(value));
	};
	for await (const _chunk of request) { /* drain */ }
	if (url.pathname === "/receipt") return send(200, { ok: true });
	if (url.pathname === "/api/v1/users/me") {
		return send(200, { result: "success", msg: "", user_id: 9, email: "operator-bot@example.com", full_name: "Operator", is_bot: true });
	}
	if (url.pathname === "/api/v1/streams") {
		return send(200, { result: "success", msg: "", streams: [{ stream_id: Number(CHANNEL_ID), name: "customer · Alex", topics_policy: "empty_topic_only" }] });
	}
	send(404, { result: "error", msg: "not found" });
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as AddressInfo).port;

const workingDir = mkdtempSync(join(tmpdir(), "zulip-addressing-"));
const store = new ChannelStore({ workingDir, botToken: PROXY_TOKEN });
const handled: any[] = [];
const ambient: any[] = [];
const adapter = new ZulipWebhookAdapter({
	url: `http://127.0.0.1:${upstreamPort}`,
	botToken: PROXY_TOKEN,
	inboundToken: INBOUND_TOKEN,
	agentName: "Operator",
	workingDir,
	store,
	directChannelMessages: true,
	channelRefreshMs: 0,
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
const inboundPort = (inbound.address() as AddressInfo).port;

let nextId = 500;
async function post(raw: string, sender = { id: 8, name: "Alex Garcia", bot: false }): Promise<string> {
	const id = nextId++;
	const response = await fetch(`http://127.0.0.1:${inboundPort}/zulip/inbound`, {
		method: "POST",
		headers: { authorization: `Bearer ${INBOUND_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({
			deliveryId: `d-${id}`,
			message: {
				id, type: "stream", stream_id: Number(CHANNEL_ID), display_recipient: "customer · Alex", subject: "",
				sender_id: sender.id, sender_email: `u${sender.id}@example.com`, sender_full_name: sender.name,
				sender_is_bot: sender.bot, timestamp: Math.floor(Date.now() / 1000), content: `<p>${raw}</p>`, raw_content: raw,
				// Hostd ingests with an administrator queue, so this flag is not the Operator's.
				is_mentioned: false,
			},
			hostReceipt: { url: `http://127.0.0.1:${upstreamPort}/receipt`, token: "r", leaseToken: `l-${id}` },
		}),
	});
	assert.equal(response.status, 202);
	await new Promise((resolve) => setTimeout(resolve, 60));
	return String(id);
}

try {
	await adapter.start();

	// 1. "@Text rider ..." is for the relay bot: recorded, never a turn, no ambient evaluation.
	const textRider = await post("@**Text rider** Hello, thanks for texting Pedicab Me. Ready to ride?");
	assert.equal(handled.length, 0, "the Operator does not take a turn for @Text rider");
	assert.equal(ambient.length, 0, "@Text rider does not trigger ambient evaluation");
	const logged = readFileSync(join(workingDir, "log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	const row = logged.find((entry) => entry.ts === textRider);
	assert.equal(row.directlyAddressed, false);
	assert.match(row.text, /^\[Addressed to @Text rider, not to you \(Operator\)\./);
	assert.match(row.text, /@Text rider Hello, thanks for texting/);

	// 2. "@Operator ..." is for the Operator, and only its own mention is removed.
	await post("@**Operator|9** what do you see? cc @**Pedro**");
	assert.equal(handled.length, 1);
	assert.equal(handled[0].directlyAddressed, true);
	assert.equal(handled[0].text, "what do you see? cc @Pedro");

	// 3. "@Pedro ..." is for Pedro, not the Operator.
	await post("@**Pedro** can you find a driver for 7pm?");
	assert.equal(handled.length, 1);
	assert.equal(ambient.length, 0);

	// 4. Unmentioned human messages still follow the channel policy.
	await post("Rider is running 5 min late");
	assert.equal(handled.length, 2);
	assert.equal(handled[1].text, "Rider is running 5 min late");

	// 5. A bot's unmentioned reply (e.g. "Texted ...") is not addressed to the Operator.
	await post("Texted (512) 555-0100 from (512) 325-0330.", { id: 29, name: "Text rider", bot: true });
	assert.equal(handled.length, 2, "bot replies without an @-mention do not wake the Operator directly");

	// 6. @all reaches everyone.
	await post("@**all** tour moved to 8pm");
	assert.equal(handled.length, 3);

	console.log("zulip addressing routing tests passed");
} finally {
	await adapter.stop();
	inbound.close();
	upstream.close();
	rmSync(workingDir, { recursive: true, force: true });
}
