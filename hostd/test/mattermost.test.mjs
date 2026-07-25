import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MattermostProvisioner } from "../src/mattermost.mjs";
import { HostStore } from "../src/store.mjs";

const ADMIN_TOKEN = "admin-test-token";
const ADMIN_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const BATMAN_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOT_ID = "cccccccccccccccccccccccccc";
const TEAM_ID = "dddddddddddddddddddddddddd";
const CHANNEL_ID = "eeeeeeeeeeeeeeeeeeeeeeeeee";
const BOT_TOKEN = "private-operator-test-token";

async function body(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

test("provisions one private Operator channel and keeps its bot token outside SQLite", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-mattermost-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const contextId = "operator:0123456789abcdef01234567:intake";
	store.createContext({
		id: contextId,
		targetId: "operator",
		driver: "oci",
		runtimeName: "troublemaker-operator-test",
		port: 32000,
	});
	store.upsertEvent({
		id: "gmail-event",
		source: "gmail",
		providerMessageId: "gmail-message",
		providerThreadId: "gmail-thread",
		principalHash: "0123456789abcdef01234567",
		targetId: "operator",
		contextId,
		payload: { sender: "Customer@Example.com" },
	});

	let bot;
	let channel;
	let tokenCreates = 0;
	let channelPatches = 0;
	const teamMembers = new Set();
	const channelMembers = new Set();
	const server = createServer(async (request, response) => {
		const url = new URL(request.url || "/", "http://127.0.0.1");
		const send = (status, value) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (request.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
			send(401, { message: "unauthorized" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/v4/users/me") {
			send(200, { id: ADMIN_ID, username: "casey" });
			return;
		}
		if (request.method === "GET" && url.pathname.startsWith("/api/v4/users/username/")) {
			send(bot ? 200 : 404, bot ?? { message: "not found" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/v4/bots") {
			const input = await body(request);
			bot = { id: BOT_ID, user_id: BOT_ID, username: input.username, is_bot: true };
			send(201, bot);
			return;
		}
		if (request.method === "GET" && url.pathname === `/api/v4/users/${BOT_ID}`) {
			send(200, bot);
			return;
		}
		if (
			request.method === "GET"
			&& url.pathname.startsWith(`/api/v4/teams/${TEAM_ID}/channels/name/`)
		) {
			send(channel ? 200 : 404, channel ?? { message: "not found" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/v4/channels") {
			const input = await body(request);
			channel = {
				id: CHANNEL_ID,
				name: input.name,
				display_name: input.display_name,
				type: input.type,
				team_id: input.team_id,
			};
			send(201, channel);
			return;
		}
		if (request.method === "PUT" && url.pathname === `/api/v4/channels/${CHANNEL_ID}/patch`) {
			const input = await body(request);
			channel = { ...channel, display_name: input.display_name };
			channelPatches++;
			send(200, channel);
			return;
		}
		const teamMember = url.pathname.match(new RegExp(`^/api/v4/teams/${TEAM_ID}/members/([a-z0-9]{26})$`));
		if (request.method === "GET" && teamMember) {
			send(teamMembers.has(teamMember[1]) ? 200 : 404, teamMembers.has(teamMember[1])
				? { team_id: TEAM_ID, user_id: teamMember[1] }
				: { message: "not found" });
			return;
		}
		if (request.method === "POST" && url.pathname === `/api/v4/teams/${TEAM_ID}/members`) {
			const input = await body(request);
			teamMembers.add(input.user_id);
			send(201, { team_id: TEAM_ID, user_id: input.user_id });
			return;
		}
		const channelMember = url.pathname.match(new RegExp(`^/api/v4/channels/${CHANNEL_ID}/members/([a-z0-9]{26})$`));
		if (request.method === "GET" && channelMember) {
			send(channelMembers.has(channelMember[1]) ? 200 : 404, channelMembers.has(channelMember[1])
				? { channel_id: CHANNEL_ID, user_id: channelMember[1] }
				: { message: "not found" });
			return;
		}
		if (request.method === "POST" && url.pathname === `/api/v4/channels/${CHANNEL_ID}/members`) {
			const input = await body(request);
			channelMembers.add(input.user_id);
			send(201, { channel_id: CHANNEL_ID, user_id: input.user_id });
			return;
		}
		if (request.method === "POST" && url.pathname === `/api/v4/users/${BOT_ID}/tokens`) {
			tokenCreates++;
			send(201, { id: "ffffffffffffffffffffffffff", token: BOT_TOKEN });
			return;
		}
		send(404, { message: `unhandled ${request.method} ${url.pathname}` });
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const secrets = join(directory, "mattermost-secrets");
	const provisioner = new MattermostProvisioner({
		url: `http://127.0.0.1:${address.port}`,
		runtimeUrl: "http://10.0.2.2:18065",
		teamId: TEAM_ID,
		batmanUserId: BATMAN_ID,
		adminToken: ADMIN_TOKEN,
		credentialsDirectory: secrets,
		botDisplayName: "Operator",
	}, store);

	try {
		const first = await provisioner.ensureContext(contextId);
		const second = await provisioner.ensureContext(contextId);
		channel.display_name = "Operator legacy";
		store.setMattermostChannelDisplayName(contextId, "Operator legacy");
		const reconciled = await provisioner.ensureContext(contextId, { reconcile: true });
		assert.equal(first.channelId, CHANNEL_ID);
		assert.equal(first.botUserId, BOT_ID);
		assert.equal(first.botToken, BOT_TOKEN);
		assert.equal(second.botToken, BOT_TOKEN);
		assert.equal(reconciled.channelDisplayName, "customer@example.com");
		assert.equal(first.channelDisplayName, "customer@example.com");
		assert.equal(channel.display_name, "customer@example.com");
		assert.equal(channelPatches, 1);
		assert.equal(tokenCreates, 1, "a persisted bot token is reused");
		assert.deepEqual(teamMembers, new Set([BOT_ID, BATMAN_ID]));
		assert.deepEqual(channelMembers, new Set([BOT_ID, BATMAN_ID]));
		assert.equal(statSync(provisioner.secretPath(contextId)).mode & 0o777, 0o600);
		assert(!JSON.stringify(store.getMattermostBinding(contextId)).includes(BOT_TOKEN));
		assert.equal(store.status().mattermostBindings, 1);
	} finally {
		await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
