import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
	isExpiredZulipEventQueueError,
	ZulipGateway,
} from "../src/zulip-gateway.mjs";
import { ZulipProvisioner } from "../src/zulip.mjs";

test("expired Zulip event queues are detected and re-registered", async () => {
	const requests = [];
	const gateway = new ZulipGateway({
		config: { zulip: {} },
		store: {},
		scheduler: {},
		provisioner: {
			async request(path) {
				requests.push(path);
				assert.equal(path, "register");
				return {
					queue_id: "fresh-queue-example",
					last_event_id: 42,
				};
			},
		},
	});
	gateway.queueId = "expired-queue-example";
	gateway.lastEventId = 11;

	assert.equal(
		isExpiredZulipEventQueueError(
			new Error("Zulip GET events returned HTTP 400: Bad event queue ID: expired-queue-example"),
		),
		true,
	);
	assert.equal(
		await gateway.recoverExpiredQueue(
			new Error("Zulip GET events returned HTTP 400: Bad event queue ID: expired-queue-example"),
		),
		true,
	);
	assert.deepEqual(requests, ["register"]);
	assert.equal(gateway.queueId, "fresh-queue-example");
	assert.equal(gateway.lastEventId, 42);
	assert.equal(
		await gateway.recoverExpiredQueue(new Error("Zulip GET events returned HTTP 503")),
		false,
	);
	assert.deepEqual(requests, ["register"]);
});

test("configured customer names label pre-provisioned Zulip channels", () => {
	const principalHash = "1234567890abcdef12345678";
	const provisioner = new ZulipProvisioner(
		{},
		{
			getLatestContextEventPayload() {
				return undefined;
			},
		},
		{
			knownEmailsByPrincipalHash: new Map([
				[principalHash, "dance-studio@example.com"],
			]),
			knownLabelsByPrincipalHash: new Map([
				[principalHash, "Example Dance Academy"],
			]),
		},
	);

	assert.equal(
		provisioner.channelName(`operator:${principalHash}:website`),
		"customer · Example Dance Academy",
	);
});

test("authenticated Zulip administrator may have a realm-hidden API email", async () => {
	const provisioner = new ZulipProvisioner(
		{
			administratorEmail: "owner-login@example.com",
			agentEmail: "operator-bot@example.com",
			projectorEmail: "projector-bot@example.com",
			memberEmails: ["resident-bot@example.com"],
			observerEmails: [],
		},
		{},
	);
	provisioner.request = async (path) => {
		if (path === "users/me") {
			return {
				user_id: 16,
				email: "user16@example.com",
				is_admin: true,
				is_owner: true,
				is_bot: false,
			};
		}
		assert.equal(path, "users");
		return {
			members: [
				{ user_id: 17, email: "operator-bot@example.com", is_bot: true },
				{ user_id: 18, email: "projector-bot@example.com", is_bot: true },
				{ user_id: 19, email: "resident-bot@example.com", is_bot: true },
			],
		};
	};

	const identities = await provisioner.identities();
	assert.equal(identities.administrator.user_id, 16);
	assert.equal(identities.administrator.email, "user16@example.com");
	assert.equal(identities.agent.user_id, 17);
	assert.equal(identities.projector.user_id, 18);
	assert.deepEqual(identities.members.map((member) => member.user_id), [19]);
});

test("existing customer channels reconcile every configured participant", async () => {
	const contextId = "front-desk:1234567890abcdef12345678:website";
	const binding = { contextId, channelId: 7, channelName: "customer · Example" };
	const store = {
		getLatestContextEventPayload() { return undefined; },
		getPrincipal() { return { displayLabel: "Example" }; },
		getZulipBinding() { return binding; },
		upsertZulipBinding(input) { return input; },
	};
	const provisioner = new ZulipProvisioner({}, store);
	provisioner.identities = async () => ({
		administrator: { user_id: 1 },
		agent: { user_id: 2 },
		projector: { user_id: 3 },
		members: [{ user_id: 4 }],
		observers: [{ user_id: 5 }, { user_id: 4 }],
	});
	provisioner.listChannels = async () => [{
		stream_id: 7,
		name: "customer · Example",
		description: "Private customer exchange feed",
		topics_policy: "empty_topic_only",
	}];
	const requests = [];
	provisioner.request = async (path, input) => {
		requests.push({ path, input });
		return { result: "success" };
	};

	await provisioner.ensureContext(contextId);
	assert.deepEqual(requests.map((request) => request.path), ["users/me/subscriptions"]);
	assert.deepEqual(JSON.parse(requests[0].input.form.get("subscriptions")), [{ name: "customer · Example" }]);
	assert.deepEqual(JSON.parse(requests[0].input.form.get("principals")), [1, 2, 3, 4, 5]);
	assert.equal(requests[0].input.form.get("authorization_errors_fatal"), "true");
});

test("first context creates a fresh private channel instead of adopting a same-labeled channel", async () => {
	const principalHash = "1234567890abcdef12345678";
	const contextId = `front-desk:${principalHash}:website`;
	let binding;
	let createCalls = 0;
	let subscriberCalls = 0;
	const streams = [{
		stream_id: 5,
		name: "customer · Robin",
		description: "An unrelated pre-existing private channel",
		topics_policy: "empty_topic_only",
	}];
	const store = {
		getLatestContextEventPayload() {
			return undefined;
		},
		getPrincipal() {
			return { displayLabel: "Robin" };
		},
		getZulipBinding() {
			return binding;
		},
		upsertZulipBinding(input) {
			binding = input;
			return input;
		},
	};
	const provisioner = new ZulipProvisioner(
		{},
		store,
		{
			knownEmailsByPrincipalHash: new Map([[principalHash, "robin@example.com"]]),
		},
	);
	provisioner.identities = async () => ({
		administrator: { user_id: 1 },
		agent: { user_id: 2 },
		projector: { user_id: 3 },
		members: [],
		observers: [],
	});
	provisioner.listChannels = async () => streams;
	provisioner.request = async (path, input) => {
		if (path === "users/me/subscriptions") {
			subscriberCalls++;
			assert.equal(input.method, "POST");
			assert.deepEqual(JSON.parse(input.form.get("principals")), [1, 2, 3]);
			return { result: "success" };
		}
		assert.equal(path, "channels/create");
		createCalls++;
		const name = input.form.get("name");
		const description = input.form.get("description");
		assert.notEqual(name, "customer · Robin");
		assert.match(name, /^customer · Robin · [a-f0-9]{8}$/);
		assert.match(description, /Hostd binding: [a-f0-9]{16}/);
		streams.push({
			stream_id: 6,
			name,
			description,
			topics_policy: "empty_topic_only",
		});
		return { result: "success" };
	};

	const first = await provisioner.ensureContext(contextId);
	const repeat = await provisioner.ensureContext(contextId);
	assert.equal(first.channelId, 6);
	assert.equal(repeat.channelId, 6);
	assert.equal(createCalls, 1);
	assert.equal(subscriberCalls, 2);
	assert.notEqual(first.channelId, 5);
});

test("soft-deleted channel name conflicts retry with a context marker", async () => {
	const principalHash = "abcdef1234567890abcdef12";
	const contextId = `front-desk:${principalHash}:intake`;
	let binding;
	const attemptedNames = [];
	const streams = [];
	const store = {
		getLatestContextEventPayload() {
			return undefined;
		},
		getPrincipal() {
			return { displayLabel: "Retired Room" };
		},
		getZulipBinding() {
			return binding;
		},
		upsertZulipBinding(input) {
			binding = input;
			return input;
		},
	};
	const provisioner = new ZulipProvisioner({}, store);
	provisioner.identities = async () => ({
		administrator: { user_id: 1 },
		agent: { user_id: 2 },
		projector: { user_id: 3 },
		members: [],
		observers: [],
	});
	provisioner.listChannels = async () => streams;
	provisioner.request = async (path, input) => {
		if (path === "users/me/subscriptions") return { result: "success" };
		assert.equal(path, "channels/create");
		const name = input.form.get("name");
		attemptedNames.push(name);
		if (attemptedNames.length === 1) {
			throw new Error(
				`Zulip POST channels/create returned HTTP 400: Channel '${name}' already exists`,
			);
		}
		streams.push({
			stream_id: 21,
			name,
			description: input.form.get("description"),
			topics_policy: "empty_topic_only",
		});
		return { result: "success" };
	};

	const result = await provisioner.ensureContext(contextId);
	assert.equal(result.channelId, 21);
	assert.deepEqual(attemptedNames, [
		"customer · Retired Room",
		`customer · Retired Room · ${createHash("sha256")
			.update(contextId, "utf8")
			.digest("hex")
			.slice(0, 8)}`,
	]);
});

test("projects redacted direct SMS ledger events into the bound customer channel", async () => {
	const provisioner = new ZulipProvisioner({}, {});
	provisioner.ensureContext = async () => ({ channelId: 9 });
	let posted;
	provisioner.request = async (path, input) => {
		assert.equal(path, "messages");
		posted = Object.fromEntries(input.form);
		return { id: 42 };
	};
	const result = await provisioner.postEmailLedgerNotification({
		contextId: "front-desk:0123456789abcdef01234567:intake",
		source: "phone",
		providerMessageId: "provider-message-example",
		payloadJson: JSON.stringify({
			sender: "Phone ending 0123",
			recipient: "Business SMS",
			message: { body: "Can you help with an estimate?" },
		}),
	});
	assert.equal(result, "42");
	assert.equal(posted.type, "channel");
	assert.equal(posted.to, "9");
	assert.equal(posted.topic, "");
	assert.match(posted.content, /^\*\*SMS received\*\*/);
	assert.match(posted.content, /Phone ending 0123/);
	assert.match(posted.content, /> Can you help with an estimate\?/);
});

test("projects website chat into the private channel without inventing an Operator reply", async () => {
	const provisioner = new ZulipProvisioner({}, {});
	provisioner.ensureContext = async () => ({ channelId: 12 });
	let posted;
	provisioner.request = async (path, input) => {
		assert.equal(path, "messages");
		posted = Object.fromEntries(input.form);
		return { id: 84 };
	};
	const result = await provisioner.postEmailLedgerNotification({
		contextId: "front-desk:0123456789abcdef01234567:website-chat",
		source: "web_chat",
		providerMessageId: "123e4567-e89b-42d3-a456-426614174001",
		payloadJson: JSON.stringify({
			sender: "Website visitor 4000",
			message: { body: "I need a small store." },
		}),
	});
	assert.equal(result, "84");
	assert.equal(posted.to, "12");
	assert.match(posted.content, /^\*\*Website chat received\*\*/);
	assert.match(posted.content, /> I need a small store\./);
	assert.doesNotMatch(posted.content, /Operator replied|Thanks for reaching out/i);
});

test("an explicit Operator Zulip post is mirrored only when its context is a website chat", async () => {
	const mirrored = [];
	const contextId = "front-desk:0123456789abcdef01234567:website-chat";
	const gateway = new ZulipGateway({
		config: { zulip: {} },
		store: {},
		scheduler: {},
		webChatGateway: {
			queueOperatorMessage(...args) { mirrored.push(args); },
		},
		provisioner: {
			async runtimeBinding() {
				return { contextId, channelId: 17, channelName: "customer · Website visitor" };
			},
			async request(path, input) {
				assert.equal(path, "messages");
				assert.equal(input.auth, "agent");
				return { result: "success", id: 501 };
			},
		},
	});
	const server = createServer((request, response) => {
		void gateway.proxy(request, response, contextId, request.url, "scoped-token");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	try {
		const response = await fetch(`http://127.0.0.1:${address.port}/messages`, {
			method: "POST",
			headers: {
				authorization: "Bearer scoped-token",
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				type: "channel",
				to: "17",
				topic: "",
				content: "I can help with that.",
			}),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { result: "success", id: 501 });
		assert.deepEqual(mirrored, [[contextId, 501, "I can help with that."]]);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
