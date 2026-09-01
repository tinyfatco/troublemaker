import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("Zulip ingress uses bounded long polling instead of hot short polling", async () => {
	let pollRequest;
	const gateway = new ZulipGateway({
		config: { zulip: {} },
		store: {},
		scheduler: {},
		provisioner: {
			async request(path, options) {
				assert.equal(path, "events");
				pollRequest = options;
				gateway.stopped = true;
				return { events: [] };
			},
		},
	});
	gateway.queueId = "queue-example";
	gateway.lastEventId = 7;
	gateway.stopped = false;

	await gateway.pollLoop();
	assert.deepEqual(pollRequest.query, {
		queue_id: "queue-example",
		last_event_id: 7,
		dont_block: false,
	});
	assert(pollRequest.signal instanceof AbortSignal);
	assert.equal(pollRequest.timeoutMs, 120_000);
});

test("Zulip long polling is cancelled promptly during shutdown", async () => {
	let resolveStarted;
	const started = new Promise((resolve) => {
		resolveStarted = resolve;
	});
	const gateway = new ZulipGateway({
		config: { zulip: {} },
		store: {},
		scheduler: {},
		provisioner: {
			request(path, options) {
				assert.equal(path, "events");
				resolveStarted();
				return new Promise((resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
				});
			},
		},
	});
	gateway.queueId = "queue-example";
	gateway.lastEventId = 7;
	gateway.stopped = false;
	gateway.pollPromise = gateway.pollLoop();

	await started;
	await Promise.race([
		gateway.stop(),
		new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown did not cancel long poll")), 500)),
	]);
	assert.equal(gateway.pollAbortController, null);
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
