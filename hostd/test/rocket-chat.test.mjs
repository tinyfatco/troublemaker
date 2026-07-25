import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RocketChatProvisioner } from "../src/rocket-chat.mjs";
import { HostStore } from "../src/store.mjs";

const ADMIN_TOKEN = "admin-test-token";
const ADMIN_USER_ID = "adminUser123";
const CONTACT_ID = "contactCustomer123";
const ROOM_ID = "roomCustomer123";
const MESSAGE_ID = "messageEmail123";
const AGENT_ID = "agentOperator123";
const CONTROL_ID = "controlTinyfat123";
const VISITOR_ID = "visitorCustomer123";
const OMNICHANNEL_ROOM_ID = "omniRoomCustomer123";
const INQUIRY_ID = "inquiryCustomer123";

async function requestBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

test("projects one sequenced customer awareness stream into a private Rocket.Chat room", async () => {
	const directory = mkdtempSync(join(tmpdir(), "troublemaker-hostd-rocketchat-"));
	const store = new HostStore(join(directory, "state.sqlite"));
	const contextId = "front-desk:0123456789abcdef01234567:intake";
	store.createContext({
		id: contextId,
		targetId: "front-desk",
		driver: "oci",
		runtimeName: "troublemaker-front-desk-test",
		port: 32000,
	});
	store.upsertEventWithControlNotification({
		id: "gmail-event-one",
		source: "gmail",
		providerMessageId: "gmail-message-one",
		providerThreadId: "gmail-thread",
		principalHash: "0123456789abcdef01234567",
		targetId: "front-desk",
		contextId,
		payload: {
			sender: "Customer@Example.com",
			metadata: { to: "agent@example.com", subject: "Website update" },
			route: { projectSlug: "intake" },
			thread: [{ id: "gmail-message-one", body: "Please use the blue logo.\nPing @helpers only here." }],
		},
	});
	store.upsertEventWithControlNotification({
		id: "gmail-event-two",
		source: "gmail",
		providerMessageId: "gmail-message-two",
		providerThreadId: "gmail-thread",
		principalHash: "0123456789abcdef01234567",
		targetId: "front-desk",
		contextId,
		payload: {
			sender: "customer@example.com",
			metadata: { to: "agent@example.com", subject: "One more thing" },
			route: { projectSlug: "intake" },
			thread: [{ id: "gmail-message-two", body: "The footer address changed." }],
		},
	});

	let room;
	let contact;
	let contactCreates = 0;
	let contactSearches = 0;
	let roomCreates = 0;
	let messageCreates = 0;
	let omnichannelConversationCreates = 0;
	const messages = [];
	const omnichannelMessages = [];
	let visitor;
	let omnichannelRoom;
	const users = new Map();
	const passwords = new Map();
	const tokens = new Map();
	const roomMembers = new Set();
	const server = createServer(async (request, response) => {
		const url = new URL(request.url || "/", "http://127.0.0.1");
		const send = (status, value) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
			if (request.method === "POST" && url.pathname === "/api/v1/login") {
				const input = await requestBody(request);
				const user = users.get(input.user);
				if (!user || passwords.get(input.user) !== input.password) {
					send(401, { status: "error", message: "Unauthorized" });
					return;
				}
				const authToken = `token-${input.user}`;
				tokens.set(user._id, authToken);
				send(200, {
					status: "success",
					data: { userId: user._id, authToken },
				});
				return;
			}
			const requestUserId = request.headers["x-user-id"];
			const requestToken = request.headers["x-auth-token"];
			const isAdmin = requestToken === ADMIN_TOKEN && requestUserId === ADMIN_USER_ID;
			const isUser = tokens.get(requestUserId) === requestToken;
			if (!isAdmin && !isUser) {
				send(401, { success: false, error: "unauthorized" });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/v1/me") {
				const user = [...users.values()].find((candidate) => candidate._id === requestUserId);
				send(200, { ...user, success: true });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/v1/users.info") {
				assert(isAdmin);
				const user = users.get(url.searchParams.get("username"));
				if (!user) {
					send(400, {
						success: false,
						errorType: "error-user-not-found",
						error: "User not found",
					});
					return;
				}
				send(200, { success: true, user });
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/users.create") {
				assert(isAdmin);
				const input = await requestBody(request);
				const user = {
					_id: input.username === "tinyfat" ? CONTROL_ID : AGENT_ID,
					username: input.username,
					name: input.name,
					roles: input.roles,
					active: input.active,
				};
				users.set(user.username, user);
				passwords.set(user.username, input.password);
				send(200, { success: true, user });
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/users.update") {
				assert(isAdmin);
				const input = await requestBody(request);
				const user = [...users.values()].find((candidate) => candidate._id === input.userId);
				Object.assign(user, input.data);
				if (input.data.password) {
					passwords.set(user.username, input.data.password);
					delete user.password;
				}
				send(200, { success: true, user });
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/roles.addUserToRole") {
				assert(isAdmin);
				const input = await requestBody(request);
				const user = users.get(input.username);
				user.roles = [...new Set([...user.roles, input.roleId])];
				send(200, { success: true, role: { _id: input.roleId } });
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/tinyfat/omnichannel/conversation") {
				assert(isAdmin);
				const input = await requestBody(request);
				assert.deepEqual(input.source, {
					type: "email",
					id: "tinyfat-gmail",
					label: "Email",
					destination: "agent@example.com",
				});
				assert.equal(input.agentId, AGENT_ID);
				assert.equal(input.verified, true);
				visitor = {
					_id: VISITOR_ID,
					token: input.visitor.token,
					username: input.visitor.username,
					name: input.visitor.name,
					visitorEmails: [{ address: input.visitor.email }],
				};
				omnichannelRoom = {
					_id: OMNICHANNEL_ROOM_ID,
					t: "l",
					open: true,
					verified: true,
					contactId: CONTACT_ID,
					source: {
						type: input.source.type,
						id: input.source.id,
						label: input.source.label,
						destination: input.source.destination,
					},
					v: visitor,
				};
				omnichannelConversationCreates++;
				send(200, {
					success: true,
					visitor,
					room: omnichannelRoom,
					newRoom: true,
				});
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/v1/livechat/room") {
				assert.equal(url.searchParams.get("token"), visitor.token);
				if (url.searchParams.get("rid")) {
					if (!omnichannelRoom || url.searchParams.get("rid") !== omnichannelRoom._id) {
						send(400, { success: false, error: "invalid-room" });
						return;
					}
					send(200, { success: true, room: omnichannelRoom, newRoom: false });
					return;
				}
				send(400, { success: false, error: "stock-room-creation-is-not-supported" });
				return;
			}
			if (request.method === "GET" && url.pathname.startsWith("/api/v1/livechat/message/")) {
				const id = decodeURIComponent(url.pathname.split("/").at(-1));
				const message = omnichannelMessages.find((candidate) => candidate._id === id);
				if (!message) {
					send(400, { success: false, errorType: "error-invalid-message", error: "invalid-message" });
					return;
				}
				send(200, { success: true, message });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/v1/livechat/inquiries.getOne") {
				assert.equal(requestUserId, AGENT_ID);
				assert.equal(url.searchParams.get("roomId"), OMNICHANNEL_ROOM_ID);
				send(200, {
					success: true,
					inquiry: { _id: INQUIRY_ID, rid: OMNICHANNEL_ROOM_ID, status: "queued" },
				});
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/livechat/inquiries.take") {
				assert.equal(requestUserId, AGENT_ID);
				const input = await requestBody(request);
				assert.deepEqual(input, { inquiryId: INQUIRY_ID, userId: AGENT_ID });
				omnichannelRoom.servedBy = { _id: AGENT_ID, username: "operator-test" };
				send(200, {
					success: true,
					inquiry: { _id: INQUIRY_ID, rid: OMNICHANNEL_ROOM_ID, status: "taken" },
				});
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/livechat/agent.status") {
				assert.equal(requestUserId, AGENT_ID);
				assert.deepEqual(await requestBody(request), { status: "available" });
				send(200, { success: true, status: "available" });
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/livechat/message") {
				const input = await requestBody(request);
				assert.equal(input.token, visitor.token);
				assert.equal(input.rid, OMNICHANNEL_ROOM_ID);
				const message = {
					_id: input._id,
					rid: input.rid,
					msg: input.msg,
					token: input.token,
					u: { _id: VISITOR_ID, username: visitor.username, name: visitor.name },
				};
				omnichannelMessages.push(message);
				send(200, { success: true, message });
				return;
			}
		if (request.method === "GET" && url.pathname === "/api/v1/omnichannel/contacts.search") {
			assert.equal(url.searchParams.get("searchText"), "customer@example.com");
			assert.equal(url.searchParams.get("unknown"), "false");
			contactSearches++;
			send(200, {
				success: true,
				contacts: contact ? [contact] : [],
				count: contact ? 1 : 0,
				offset: 0,
				total: contact ? 1 : 0,
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/v1/omnichannel/contacts") {
			const input = await requestBody(request);
			assert.deepEqual(input, {
				name: "customer@example.com",
				emails: ["customer@example.com"],
				phones: [],
			});
			contact = {
				_id: CONTACT_ID,
				name: input.name,
				emails: input.emails.map((address) => ({ address })),
			};
			contactCreates++;
			send(200, { success: true, contactId: CONTACT_ID });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/v1/groups.info") {
			if (!room) {
				send(400, {
					success: false,
					errorType: "error-room-not-found",
					error: "Room not found",
				});
				return;
			}
			assert.equal(url.searchParams.get("roomName"), room.name);
			send(200, { success: true, group: room });
			return;
		}
			if (request.method === "POST" && url.pathname === "/api/v1/groups.create") {
				assert(isAdmin);
				const input = await requestBody(request);
				assert(input.members.includes("operator-bot"));
				assert(input.members.includes("tinyfat"));
				assert(input.members.some((username) => username.startsWith("operator-")));
				assert.match(input.name, /^customer-[a-f0-9]{20}$/);
			assert(!input.name.includes("customer@example.com"));
			assert.equal(input.customFields.tinyfat.customerChannelId, contextId);
			assert.equal(input.customFields.tinyfat.omnichannelContactId, CONTACT_ID);
			assert.equal(input.extraData.topic, "Customer relationship: customer@example.com");
				room = { _id: ROOM_ID, name: input.name, t: "p" };
				for (const username of input.members) {
					const member = users.get(username);
					if (member) roomMembers.add(member._id);
				}
				roomCreates++;
			send(200, { success: true, group: room });
			return;
			}
			if (request.method === "GET" && url.pathname === "/api/v1/groups.members") {
				send(200, {
					success: true,
					members: [...users.values()].filter((user) => roomMembers.has(user._id)),
					count: roomMembers.size,
					offset: 0,
					total: roomMembers.size,
				});
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/groups.invite") {
				assert(isAdmin);
				const input = await requestBody(request);
				roomMembers.add(input.userId);
				send(200, { success: true, group: room });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/v1/groups.history") {
				assert.equal(url.searchParams.get("roomId"), ROOM_ID);
			send(200, { success: true, messages });
			return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/chat.postMessage") {
				assert.equal(requestUserId, CONTROL_ID, "host notifications use the TinyFat control bot");
				const input = await requestBody(request);
				const message = {
					...input,
					_id: MESSAGE_ID,
					rid: ROOM_ID,
					u: { _id: CONTROL_ID, username: "tinyfat", name: "TINYFAT" },
				};
			messages.push(message);
			messageCreates++;
			send(200, { success: true, message });
			return;
		}
		send(404, { success: false, error: `unhandled ${request.method} ${url.pathname}` });
	});
	await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	assert(address && typeof address === "object");
	const provisioner = new RocketChatProvisioner({
		url: `http://127.0.0.1:${address.port}`,
			adminUserId: ADMIN_USER_ID,
			adminToken: ADMIN_TOKEN,
			credentialsDirectory: join(directory, "rocket-chat-secrets"),
			memberUsernames: ["operator-bot"],
			agentUsernamePrefix: "operator",
			agentDisplayName: "Operator",
			notifierUsername: "tinyfat",
			notifierDisplayName: "TINYFAT",
	}, store);

	try {
		const first = await provisioner.ensureContext(contextId);
		const replay = await provisioner.ensureContext(contextId);
		assert.equal(first.roomId, ROOM_ID);
		assert.equal(first.contactId, CONTACT_ID);
		assert.equal(replay.roomId, ROOM_ID);
			assert.equal(first.platform, "rocket-chat");
			assert.equal(first.botUserId, AGENT_ID);
			assert.equal(first.botUsername.startsWith("operator-"), true);
			assert.notEqual(first.credentials.authToken, ADMIN_TOKEN);
			assert(users.get(first.botUsername).roles.includes("livechat-agent"));
		assert.equal(contactCreates, 1);
		assert.equal(contactSearches, 2);
		assert.equal(roomCreates, 1);
		assert.equal(store.status().rocketChatBindings, 1);
		assert.equal(store.getRocketChatBinding(contextId).contactId, CONTACT_ID);

		const notification = store.getControlNotification("gmail:gmail-message-one");
		const secondNotification = store.getControlNotification("gmail:gmail-message-two");
		assert.equal(notification.sequence, 1);
		assert.equal(secondNotification.sequence, 2);
		assert.equal(await provisioner.postEmailLedgerNotification(notification), MESSAGE_ID);
		assert.equal(await provisioner.postEmailLedgerNotification(notification), MESSAGE_ID);
			assert.equal(messageCreates, 1);
			assert.equal(messages[0].u._id, CONTROL_ID);
			assert.equal(omnichannelConversationCreates, 1);
			assert.equal(omnichannelMessages.length, 1);
			assert.equal(omnichannelMessages[0].msg, "Please use the blue logo.\nPing @helpers only here.");
			assert.equal(omnichannelRoom.source.type, "email");
			assert.equal(omnichannelRoom.verified, true);
			assert.equal(
				store.getRocketChatOmnichannelConversation("gmail", "gmail-thread").roomId,
				OMNICHANNEL_ROOM_ID,
			);

		const [message] = messages;
		assert.equal(message.alias, undefined);
		assert.match(message.text, /### TINYFAT · Email received/);
		assert.match(message.text, /customer＠example\.com/i);
		assert.match(message.text, /> Please use the blue logo\./);
		assert.match(message.text, /> Ping ＠helpers only here\./);
		assert.deepEqual(message.customFields.tinyfat, {
			schema: 1,
			kind: "message.inbound.recorded",
			eventId: "gmail:gmail-message-one",
			customerChannelId: contextId,
			sequence: 1,
			source: "email",
			actorKind: "contact",
			actorId: "0123456789abcdef01234567",
			visibility: "channel",
		});
	} finally {
		await new Promise((resolvePromise, reject) => {
			server.close((error) => error ? reject(error) : resolvePromise());
		});
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
