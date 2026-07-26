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

test("first context creates a fresh private channel instead of adopting a same-labeled channel", async () => {
	const principalHash = "1234567890abcdef12345678";
	const contextId = `front-desk:${principalHash}:website`;
	let binding;
	let createCalls = 0;
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
