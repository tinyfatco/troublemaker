import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MattermostGateway } from "../src/mattermost-gateway.mjs";
import { MattermostProvisioner } from "../src/mattermost.mjs";
import { HostStore } from "../src/store.mjs";

const ADMIN_TOKEN = "admin-test-token";
const CONTROL_TOKEN = "tinyfat-control-token";
const PRIVATE_TOKEN = "private-operator-token";
const ADMIN_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const BATMAN_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const PRIVATE_BOT_ID = "cccccccccccccccccccccccccc";
const TEAM_ID = "dddddddddddddddddddddddddd";
const CHANNEL_ID = "eeeeeeeeeeeeeeeeeeeeeeeeee";
const CONTROL_BOT_ID = "ffffffffffffffffffffffffff";
const POST_ID = "pppppppppppppppppppppppppp";
const OUTBOUND_POST_ID = "oooooooooooooooooooooooooo";

async function requestBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

test("TINYFAT control posts do not become a second Operator inbound", async () => {
	let lookedUpBinding = false;
	const gateway = new MattermostGateway({
		config: { mattermost: {} },
		store: {
			getMattermostBindingByChannel() {
				lookedUpBinding = true;
				throw new Error("control posts must be ignored before routing");
			},
		},
		provisioner: {
			isControlBotUser(userId) {
				return userId === CONTROL_BOT_ID;
			},
		},
		scheduler: { pump() {} },
	});
	await gateway.ingestPosted({
		data: {
			post: JSON.stringify({
				id: POST_ID,
				channel_id: CHANNEL_ID,
				user_id: CONTROL_BOT_ID,
				message: "New inbound email",
			}),
		},
	});
	assert.equal(lookedUpBinding, false);
});

test("Mattermost membership system posts do not become Operator inbound", async () => {
	let lookedUpBinding = false;
	const gateway = new MattermostGateway({
		config: { mattermost: {} },
		store: {
			getMattermostBindingByChannel() {
				lookedUpBinding = true;
				throw new Error("system posts must be ignored before routing");
			},
		},
		provisioner: { isControlBotUser() { return false; } },
		scheduler: { pump() {} },
	});
	await gateway.ingestPosted({
		data: {
			post: JSON.stringify({
				id: POST_ID,
				channel_id: CHANNEL_ID,
				user_id: ADMIN_ID,
				type: "system_add_to_channel",
				message: "tinyfat added to the channel by casey.",
			}),
		},
	});
	assert.equal(lookedUpBinding, false);
});

test("TINYFAT posts duplicate-safe inbound and outbound email ledger messages", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-control-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const contextId = "operator:0123456789abcdef01234567:intake";
	store.createContext({
		id: contextId,
		targetId: "operator",
		driver: "oci",
		runtimeName: "troublemaker-operator-test",
		port: 32000,
	});
	store.upsertMattermostBinding({
		contextId,
		teamId: TEAM_ID,
		channelId: CHANNEL_ID,
		botUserId: PRIVATE_BOT_ID,
		botUsername: "operator-0123456789abcdef0123",
	});

	let controlBot;
	let tokenCreates = 0;
	let postCreates = 0;
	const createdPosts = [];
	const teamMembers = new Set();
	const channelMembers = new Set();
	const server = createServer(async (request, response) => {
		const url = new URL(request.url || "/", "http://127.0.0.1");
		const token = request.headers.authorization?.replace(/^Bearer /, "");
		const send = (status, value) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (request.method === "GET" && url.pathname === "/api/v4/users/me" && token === ADMIN_TOKEN) {
			send(200, { id: ADMIN_ID, username: "casey" });
			return;
		}
		if (
			request.method === "GET"
			&& url.pathname === "/api/v4/users/username/tinyfat"
			&& token === ADMIN_TOKEN
		) {
			send(controlBot ? 200 : 404, controlBot ?? { message: "not found" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/v4/bots" && token === ADMIN_TOKEN) {
			const input = await requestBody(request);
			assert.equal(input.username, "tinyfat");
			assert.equal(input.display_name, "TINYFAT");
			controlBot = {
				id: CONTROL_BOT_ID,
				user_id: CONTROL_BOT_ID,
				username: "tinyfat",
				is_bot: true,
			};
			send(201, controlBot);
			return;
		}
		if (
			request.method === "GET"
			&& url.pathname === `/api/v4/users/${CONTROL_BOT_ID}`
			&& token === ADMIN_TOKEN
		) {
			send(200, controlBot);
			return;
		}
		const teamMember = url.pathname.match(
			new RegExp(`^/api/v4/teams/${TEAM_ID}/members/([a-z0-9]{26})$`),
		);
		if (request.method === "GET" && teamMember && token === ADMIN_TOKEN) {
			send(teamMembers.has(teamMember[1]) ? 200 : 404, { user_id: teamMember[1] });
			return;
		}
		if (
			request.method === "POST"
			&& url.pathname === `/api/v4/teams/${TEAM_ID}/members`
			&& token === ADMIN_TOKEN
		) {
			const input = await requestBody(request);
			teamMembers.add(input.user_id);
			send(201, input);
			return;
		}
		if (
			request.method === "POST"
			&& url.pathname === `/api/v4/users/${CONTROL_BOT_ID}/tokens`
			&& token === ADMIN_TOKEN
		) {
			tokenCreates++;
			send(201, { id: "tttttttttttttttttttttttttt", token: CONTROL_TOKEN });
			return;
		}
		const channelMember = url.pathname.match(
			new RegExp(`^/api/v4/channels/${CHANNEL_ID}/members/([a-z0-9]{26})$`),
		);
		if (request.method === "GET" && channelMember && token === ADMIN_TOKEN) {
			send(channelMembers.has(channelMember[1]) ? 200 : 404, { user_id: channelMember[1] });
			return;
		}
		if (
			request.method === "POST"
			&& url.pathname === `/api/v4/channels/${CHANNEL_ID}/members`
			&& token === ADMIN_TOKEN
		) {
			const input = await requestBody(request);
			channelMembers.add(input.user_id);
			send(201, input);
			return;
		}
		if (
			request.method === "GET"
			&& url.pathname === `/api/v4/channels/${CHANNEL_ID}/posts`
			&& token === CONTROL_TOKEN
		) {
			const posts = Object.fromEntries(createdPosts.map((post) => [post.id, post]));
			send(200, { order: createdPosts.map((post) => post.id), posts });
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/v4/posts" && token === CONTROL_TOKEN) {
			const input = await requestBody(request);
			assert.equal(input.channel_id, CHANNEL_ID);
			const id = createdPosts.length === 0 ? POST_ID : OUTBOUND_POST_ID;
			const createdPost = { ...input, id, user_id: CONTROL_BOT_ID };
			createdPosts.push(createdPost);
			postCreates++;
			send(201, createdPost);
			return;
		}
		send(404, { message: `unhandled ${request.method} ${url.pathname}` });
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const secrets = join(directory, "mattermost-secrets");
	mkdirSync(secrets, { recursive: true, mode: 0o700 });
	const provisioner = new MattermostProvisioner({
		url: `http://127.0.0.1:${address.port}`,
		runtimeUrl: "http://10.0.2.2:18065",
		teamId: TEAM_ID,
		batmanUserId: BATMAN_ID,
		adminToken: ADMIN_TOKEN,
		credentialsDirectory: secrets,
		botDisplayName: "Operator",
		notifierUsername: "tinyfat",
		notifierDisplayName: "TINYFAT",
	}, store);
	writeFileSync(
		provisioner.secretPath(contextId),
		`${JSON.stringify({ botUserId: PRIVATE_BOT_ID, token: PRIVATE_TOKEN })}\n`,
		{ mode: 0o600 },
	);
	const notification = {
		id: "gmail:message-one",
		contextId,
		sequence: 1,
		source: "gmail",
		providerMessageId: "message-one",
		payloadJson: JSON.stringify({
			sender: "person@example.com",
			metadata: { to: "agent@example.com", subject: "Please update my website" },
			route: { projectSlug: "intake" },
			thread: [{ id: "message-one", body: "Please use the blue logo.\nPing @helpers only here." }],
		}),
	};
	const outboundNotification = {
		id: "gmail_outbound:sent-one",
		contextId,
		sequence: 2,
		source: "gmail_outbound",
		providerMessageId: "sent-one",
		payloadJson: JSON.stringify({
			sender: "agent@example.com",
			recipient: "person@example.com",
			metadata: { subject: "Re: Please update my website" },
			route: { projectSlug: "intake" },
			message: { body: "The blue logo is ready.\nThanks @person." },
		}),
	};

	try {
		assert.equal(await provisioner.postEmailLedgerNotification(notification), POST_ID);
		assert.equal(await provisioner.postEmailLedgerNotification(notification), POST_ID);
		assert.equal(
			await provisioner.postEmailLedgerNotification(outboundNotification),
			OUTBOUND_POST_ID,
		);
		assert.equal(
			await provisioner.postEmailLedgerNotification(outboundNotification),
			OUTBOUND_POST_ID,
		);
		assert.equal(tokenCreates, 1, "the persisted TINYFAT token is reused");
		assert.equal(postCreates, 2, "each ledger event creates exactly one top-level post");
		assert.deepEqual(teamMembers, new Set([CONTROL_BOT_ID]));
		assert.deepEqual(channelMembers, new Set([CONTROL_BOT_ID]));

		const [inboundPost, outboundPost] = createdPosts;
		assert.match(inboundPost.message, /### Email received/);
		assert.match(inboundPost.message, /person＠example\.com/);
		assert.match(inboundPost.message, /Scope:\*\* `intake`/);
		assert.match(inboundPost.message, /> Please use the blue logo\./);
		assert.match(inboundPost.message, /> Ping ＠helpers only here\./);
		assert.equal(inboundPost.root_id, undefined, "inbound ledger posts stay top-level");
		assert.equal(inboundPost.props.tinyfat_ledger_id, notification.id);
		assert.equal(inboundPost.props.tinyfat_customer_channel_id, contextId);
		assert.equal(inboundPost.props.tinyfat_sequence, 1);
		assert.equal(inboundPost.props.tinyfat_inbound_id, notification.id);
		assert.equal(inboundPost.props.tinyfat_direction, "inbound");

		assert.match(outboundPost.message, /### Email sent/);
		assert.match(outboundPost.message, /agent＠example\.com/);
		assert.match(outboundPost.message, /person＠example\.com/);
		assert.match(outboundPost.message, /> The blue logo is ready\./);
		assert.match(outboundPost.message, /> Thanks ＠person\./);
		assert.equal(outboundPost.root_id, undefined, "outbound ledger posts stay top-level");
		assert.equal(outboundPost.props.tinyfat_ledger_id, outboundNotification.id);
		assert.equal(outboundPost.props.tinyfat_sequence, 2);
		assert.equal(outboundPost.props.tinyfat_direction, "outbound");
		assert.equal(outboundPost.props.tinyfat_inbound_id, undefined);
		assert.equal(statSync(provisioner.controlBotSecretPath()).mode & 0o777, 0o600);
		assert(provisioner.isControlBotUser(CONTROL_BOT_ID));
		assert(!JSON.stringify(store.status()).includes(CONTROL_TOKEN));
	} finally {
		await new Promise((resolvePromise, reject) => {
			server.close((error) => error ? reject(error) : resolvePromise());
		});
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
