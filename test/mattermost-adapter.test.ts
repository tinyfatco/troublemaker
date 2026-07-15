import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { MattermostSocketAdapter } from "../src/adapters/mattermost-socket.js";
import { ChannelPulse } from "../src/engagement/channel-pulse.js";
import { ChannelStore } from "../src/store.js";

const BOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const HUMAN_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHANNEL_ID = "cccccccccccccccccccccccccc";
const TEAM_ID = "dddddddddddddddddddddddddd";
const TOKEN = "mattermost-test-token";
let sequence = 0;
const posts: Record<string, any> = {};

function nextPostId(): string {
	sequence += 1;
	return `p${String(sequence).padStart(25, "0")}`;
}

async function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, any>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = createServer(async (req, res) => {
	if (req.headers.authorization !== `Bearer ${TOKEN}`) {
		res.writeHead(401).end();
		return;
	}
	const url = new URL(req.url || "/", "http://127.0.0.1");
	const json = (status: number, value: unknown) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(value));
	};
	if (req.method === "GET" && url.pathname === "/api/v4/users/me") return json(200, { id: BOT_ID, username: "batman", is_bot: true });
	if (req.method === "GET" && url.pathname === "/api/v4/users") return json(200, [
		{ id: BOT_ID, username: "batman", is_bot: true },
		{ id: HUMAN_ID, username: "alex", first_name: "Alex", last_name: "Garcia", is_bot: false },
	]);
	if (req.method === "GET" && url.pathname === "/api/v4/users/me/teams") return json(200, [{ id: TEAM_ID, name: "tinyfat" }]);
	if (req.method === "GET" && url.pathname === `/api/v4/users/me/teams/${TEAM_ID}/channels`) return json(200, [
		{ id: CHANNEL_ID, name: "agents", display_name: "Agents", type: "O", team_id: TEAM_ID },
	]);
	if (req.method === "POST" && url.pathname === "/api/v4/posts") {
		const body = await readJson(req);
		const id = nextPostId();
		const post = {
			id,
			create_at: Date.now(),
			user_id: BOT_ID,
			channel_id: body.channel_id,
			root_id: body.root_id || "",
			message: body.message || "",
			file_ids: body.file_ids || [],
		};
		posts[id] = post;
		return json(201, post);
	}
	const postMatch = url.pathname.match(/^\/api\/v4\/posts\/([a-z0-9]{26})$/);
	if (postMatch && req.method === "PUT") {
		const body = await readJson(req);
		posts[postMatch[1]] = { ...posts[postMatch[1]], message: body.message, update_at: Date.now() };
		return json(200, posts[postMatch[1]]);
	}
	if (postMatch && req.method === "DELETE") {
		delete posts[postMatch[1]];
		res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "OK" }));
		return;
	}
	const threadMatch = url.pathname.match(/^\/api\/v4\/posts\/([a-z0-9]{26})\/thread$/);
	if (threadMatch && req.method === "GET") {
		const rootId = threadMatch[1];
		const threadPosts = Object.values(posts).filter((post: any) => post.id === rootId || post.root_id === rootId);
		return json(200, {
			order: threadPosts.sort((a: any, b: any) => a.create_at - b.create_at).map((post: any) => post.id),
			posts: Object.fromEntries(threadPosts.map((post: any) => [post.id, post])),
		});
	}
	json(404, { message: `unhandled ${req.method} ${url.pathname}` });
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
	wss.handleUpgrade(request, socket, head, (ws) => {
		wss.emit("connection", ws, request);
	});
});
wss.on("connection", (ws) => {
	ws.on("message", (raw) => {
		const message = JSON.parse(raw.toString());
		if (message.action === "authentication_challenge" && message.data?.token === TOKEN) {
			ws.send(JSON.stringify({ seq_reply: message.seq, status: "OK" }));
		}
	});
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
const workingDir = mkdtempSync(join(tmpdir(), "mattermost-adapter-test-"));
const store = new ChannelStore({ workingDir, botToken: TOKEN });
const pulse = new ChannelPulse("pending");
const handled: any[] = [];
const ambient: any[] = [];
const adapter = new MattermostSocketAdapter({
	url: `http://127.0.0.1:${address.port}`,
	botToken: TOKEN,
	workingDir,
	store,
	pulse,
	allowedDmUsers: [HUMAN_ID],
	onAmbientMessage: (_channel, event) => ambient.push(event),
});
adapter.setHandler({
	handleEvent: async (event: any) => {
		handled.push(event);
		return { yielded: false };
	},
} as any);

function broadcastPost(message: string): string {
	const id = nextPostId();
	const post = {
		id,
		create_at: Date.now(),
		user_id: HUMAN_ID,
		channel_id: CHANNEL_ID,
		root_id: "",
		message,
	};
	posts[id] = post;
	for (const client of wss.clients) {
		client.send(JSON.stringify({ event: "posted", data: { post: JSON.stringify(post) }, broadcast: { channel_id: CHANNEL_ID, user_id: HUMAN_ID } }));
	}
	return id;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for adapter event");
}

try {
	await adapter.start();
	assert.equal(adapter.getUser(HUMAN_ID)?.userName, "alex", "metadata loads Mattermost users");
	assert.equal(adapter.getChannel(CHANNEL_ID)?.name, "Agents", "metadata loads Mattermost channels");

	const ambientRoot = broadcastPost("ambient room message");
	await waitFor(() => ambient.length === 1);
	assert.equal(ambient[0]?.directlyAddressed, false, "ordinary channel posts are ambient");
	assert.equal(ambient[0]?.replyTarget, `mattermost:${CHANNEL_ID}:${ambientRoot}`, "ambient posts carry an exact Mattermost reply target");

	const mentionRoot = broadcastPost("@batman please verify the migration");
	await waitFor(() => handled.length === 1);
	assert.equal(handled[0]?.directlyAddressed, true, "@username posts directly invoke the agent");
	assert.equal(handled[0]?.threadTs, mentionRoot, "channel mentions establish a Mattermost root thread");

	const root = await adapter.postMessage(CHANNEL_ID, "outbound root");
	await adapter.updateMessage(CHANNEL_ID, root, "outbound root updated");
	const reply = await adapter.postInThread(CHANNEL_ID, root, "outbound reply");
	const transcript = await adapter.readThread(CHANNEL_ID, root, 10);
	assert.equal(transcript.length, 2, "Mattermost API thread reads include roots and replies");
	assert.equal(transcript[0]?.text, "outbound root updated", "Mattermost message updates use the REST API");
	assert.equal(transcript[1]?.ts, reply, "Mattermost thread replies preserve native post IDs");
} finally {
	await adapter.stop();
	for (const client of wss.clients) client.terminate();
	await new Promise<void>((resolve) => wss.close(() => resolve()));
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("mattermost adapter ok");
process.exit(0);
