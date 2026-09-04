import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OWNER_PUSH_CAPABILITY,
	ownerPushAPNSPayload,
	parseOwnerPushAcknowledgment,
	parseOwnerPushAuthoritativeEvent,
	parseOwnerPushEnvelope,
	parseOwnerPushRegistration,
	type OwnerPushDeviceRegistration,
	type OwnerPushEnvelope,
	type OwnerPushTransport,
	type OwnerPushTransportRequest,
} from "../src/console/owner-push.js";
import { ConsoleService } from "../src/console/service.js";
import { WebAdapter } from "../src/adapters/web.js";
import { FilesystemWorkspaceStore } from "../src/storage/node/filesystem-workspace.js";
import { Gateway } from "../src/gateway.js";
import { AppleOwnerPushTransport, createAppleOwnerPushTransportFromEnvironment } from "../src/host/node/apple-owner-push-transport.js";
import { ConsoleAccessFacade } from "../src/host/node/console-access-facade.js";
import { DeviceGrantStore } from "../src/host/node/device-grant-store.js";
import { createOwnerPushDeploymentFromEnvironment } from "../src/host/node/owner-push-bootstrap.js";
import { OwnerPushRuntime, OwnerPushRuntimeError } from "../src/host/node/owner-push-runtime.js";
import { OwnerPushStore } from "../src/host/node/owner-push-store.js";

const registration: OwnerPushDeviceRegistration = {
	version: 1,
	installation_id: "installation-example",
	binding_id: "binding-example",
	route_agent_id: "current",
	subject_agent_id: "agent-example",
	device_token: "ab".repeat(32),
	environment: "sandbox",
	supported_contexts: ["conversation", "task", "relationship"],
};

const envelope: OwnerPushEnvelope = {
	version: 1,
	notification_id: "notification-example",
	binding_id: "binding-example",
	route_agent_id: "current",
	subject_agent_id: "agent-example",
	event_id: "event-example",
	context: {
		kind: "conversation",
		context_id: "conversation-example",
		relationship_id: "binding-example",
		anchor_id: "message-example",
	},
};

await testStrictWireAndContentFreePayload();
await testDurableRegistrationReplayDispatchAndReadState();
await testConcurrentExactReplayCoalesces();
await testAppleTransportHeadersAndProtectedConfiguration();
await testOwnerBearerFacadeRegistrationRevocationAndExactContext();
await testContextualMessageAndStopNeverFallBack();
await testGatewayCapabilityAndContextBoundary();
console.log("owner push contract tests passed");

async function testStrictWireAndContentFreePayload(): Promise<void> {
	assert.deepEqual(parseOwnerPushRegistration(registration), registration);
	assert.equal(parseOwnerPushRegistration({ ...registration, display_name: "must not enter wire" }), null);
	assert.equal(parseOwnerPushRegistration({ ...registration, supported_contexts: ["conversation"] }), null);
	assert.equal(parseOwnerPushRegistration({ ...registration, route_agent_id: "other" })?.route_agent_id, "other");
	assert.deepEqual(parseOwnerPushEnvelope(envelope), envelope);
	assert.deepEqual(parseOwnerPushAuthoritativeEvent({
		version: 1,
		kind: "completion",
		envelope,
	}), { version: 1, kind: "completion", envelope });
	assert.equal(parseOwnerPushAuthoritativeEvent({
		version: 1,
		kind: "completion",
		envelope,
		message: "must remain absent",
	}), null);
	assert.deepEqual(parseOwnerPushAcknowledgment({
		version: 1,
		notification_id: envelope.notification_id,
		installation_id: registration.installation_id,
		binding_id: registration.binding_id,
		state: "opened",
	}), {
		version: 1,
		notification_id: envelope.notification_id,
		installation_id: registration.installation_id,
		binding_id: registration.binding_id,
		state: "opened",
	});
	assert.equal(parseOwnerPushAcknowledgment({
		version: 1,
		notification_id: envelope.notification_id,
		installation_id: registration.installation_id,
		binding_id: registration.binding_id,
		state: "unread",
	}), null);
	assert.equal(parseOwnerPushEnvelope({ ...envelope, message: "private body" }), null);
	assert.equal(parseOwnerPushEnvelope({
		...envelope,
		context: { ...envelope.context, relationship_id: "different-binding" },
	}), null);

	const payload = ownerPushAPNSPayload(envelope);
	const fixture = JSON.parse(readFileSync(
		new URL("./fixtures/owner-push-notification-v1.json", import.meta.url),
		"utf8",
	));
	assert.deepEqual(payload, fixture, "portable output stays byte-semantically aligned with Computer");
	assert.deepEqual(payload, {
		aps: {
			alert: { title: "Computer", body: "New private update" },
			category: "COMPUTER_OWNER_UPDATE_V1",
			"thread-id": "binding-example",
		},
		computer_owner_push: envelope,
	});
	const serialized = JSON.stringify(payload);
	assert.doesNotMatch(serialized, /private body|task title|relationship label|tool|credential|topology/i);
	assert.equal(OWNER_PUSH_CAPABILITY, "owner_push_v1");
}

async function testDurableRegistrationReplayDispatchAndReadState(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "owner-push-store-"));
	const path = join(root, "protected", "owner-push-v1.json");
	let now = new Date("2026-01-01T00:00:00.000Z");
	try {
		const store = new OwnerPushStore(path, { now: () => now });
		assert.deepEqual(store.register(registration), {
			disposition: "accepted",
			installation_id: registration.installation_id,
		});
		assert.equal(statSync(path).mode & 0o077, 0, "device tokens remain in an owner-only store");
		assert.equal(store.register(registration).disposition, "duplicate");
		const rotated = { ...registration, device_token: "cd".repeat(32) };
		assert.equal(store.register(rotated).disposition, "updated", "APNs token rotation keeps one identity");
		assert.equal(store.snapshot().registrations.length, 1);
		assert.doesNotMatch(JSON.stringify(store.snapshot()), /abababab|cdcdcdcd/, "redacted snapshots omit token custody");
		assert.match(readFileSync(path, "utf8"), /cdcdcdcd/, "the protected transport store retains the current token");

		const firstRequests: OwnerPushTransportRequest[] = [];
		const uncertainTransport: OwnerPushTransport = {
			async send(request) {
				firstRequests.push(structuredClone(request));
				throw new Error("synthetic transport loss");
			},
		};
		const verifier = ({ context }: { context: OwnerPushEnvelope["context"] }) =>
			context.kind === "conversation" && context.context_id === "conversation-example";
		const firstRuntime = new OwnerPushRuntime({ store, contextVerifier: verifier, transport: uncertainTransport });
		const first = await firstRuntime.dispatch(envelope);
		assert.deepEqual(first, {
			disposition: "accepted",
			planned: 1,
			accepted: 0,
			retryable: 1,
			permanentlyRejected: 0,
		});
		assert.equal(firstRequests[0]?.collapseId, envelope.notification_id);
		assert.deepEqual(firstRequests[0]?.payload, ownerPushAPNSPayload(envelope));

		now = new Date("2026-01-01T00:01:00.000Z");
		const restartedStore = new OwnerPushStore(path, { now: () => now });
		const replayRequests: OwnerPushTransportRequest[] = [];
		const acceptingTransport: OwnerPushTransport = {
			async send(request) {
				replayRequests.push(structuredClone(request));
				return { accepted: true, status: 200 };
			},
		};
		const restarted = new OwnerPushRuntime({
			store: restartedStore,
			contextVerifier: verifier,
			transport: acceptingTransport,
		});
		const replay = await restarted.dispatch(envelope);
		assert.equal(replay.disposition, "duplicate");
		assert.equal(replay.planned, 1, "a crash-ambiguous dispatch is replayed after restart");
		assert.deepEqual(replayRequests[0], firstRequests[0], "same-ID replay preserves token, collapse id, and envelope");
		const completedReplay = await restarted.dispatch(envelope);
		assert.equal(completedReplay.planned, 0, "accepted APNs custody is not sent again");

		await assert.rejects(
			restarted.dispatch({ ...envelope, event_id: "different-event" }),
			(error: unknown) => error instanceof OwnerPushRuntimeError
				&& error.code === "owner_push_notification_conflict",
		);
		const readAcknowledgment = {
			version: 1 as const,
			notification_id: envelope.notification_id,
			installation_id: registration.installation_id,
			binding_id: registration.binding_id,
			state: "read" as const,
		};
		assert.equal(restarted.acknowledge(
			readAcknowledgment,
			envelope.notification_id,
			envelope.route_agent_id,
			envelope.subject_agent_id,
		).changed, true);
		assert.equal(restarted.acknowledge(
			readAcknowledgment,
			envelope.notification_id,
			envelope.route_agent_id,
			envelope.subject_agent_id,
		).changed, false);
		assert.equal(restarted.acknowledge(
			{ ...readAcknowledgment, state: "opened" },
			envelope.notification_id,
			envelope.route_agent_id,
			envelope.subject_agent_id,
		).changed, true);
		assert.equal(restarted.acknowledge(
			{ ...readAcknowledgment, state: "opened" },
			envelope.notification_id,
			envelope.route_agent_id,
			envelope.subject_agent_id,
		).changed, false);
		const finalRestart = new OwnerPushStore(path, { now: () => now }).snapshot();
		assert.equal(finalRestart.notifications[0]?.state, "opened");
		assert.ok(finalRestart.notifications[0]?.read_at);
		assert.ok(finalRestart.notifications[0]?.opened_at);

		const receiptEnvelope: OwnerPushEnvelope = {
			...envelope,
			notification_id: "notification-receipt-proof",
			event_id: "event-receipt-proof",
		};
		const ambiguousAfterSend = new OwnerPushRuntime({
			store: new OwnerPushStore(path, { now: () => now }),
			contextVerifier: verifier,
			transport: { async send() { throw new Error("synthetic response loss after send"); } },
		});
		assert.equal((await ambiguousAfterSend.dispatch(receiptEnvelope)).retryable, 1);
		const exactDeviceReceipt = ambiguousAfterSend.acknowledge({
			...readAcknowledgment,
			notification_id: receiptEnvelope.notification_id,
		}, receiptEnvelope.notification_id, receiptEnvelope.route_agent_id, receiptEnvelope.subject_agent_id);
		assert.equal(exactDeviceReceipt.state, "read");
		assert.equal(exactDeviceReceipt.changed, true);
		let sendsAfterReceipt = 0;
		const afterReceiptRestart = new OwnerPushRuntime({
			store: new OwnerPushStore(path, { now: () => now }),
			contextVerifier: verifier,
			transport: {
				async send() {
					sendsAfterReceipt += 1;
					return { accepted: true };
				},
			},
		});
		assert.equal((await afterReceiptRestart.dispatch(receiptEnvelope)).planned, 0);
		assert.equal(sendsAfterReceipt, 0, "an exact receiving-device acknowledgment resolves pending APNs custody");

		assert.equal(afterReceiptRestart.revoke("current", "agent-example", "installation-example"), 1);
		assert.equal(afterReceiptRestart.revoke("current", "agent-example", "installation-example"), 0);
		assert.equal(new OwnerPushStore(path).snapshot().registrations.length, 0, "revocation survives restart");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}


async function testConcurrentExactReplayCoalesces(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "owner-push-concurrent-"));
	const path = join(root, "protected", "owner-push-v1.json");
	let releaseSend: (() => void) | undefined;
	const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
	let sends = 0;
	try {
		const store = new OwnerPushStore(path);
		store.register(registration);
		const runtime = new OwnerPushRuntime({
			store,
			contextVerifier: () => true,
			transport: {
				async send() {
					sends += 1;
					await sendReleased;
					return { accepted: true };
				},
			},
		});
		const authoritativeEvent = { version: 1 as const, kind: "completion" as const, envelope };
		const first = runtime.dispatchAuthoritative(authoritativeEvent);
		const replay = runtime.dispatchAuthoritative(authoritativeEvent);
		for (let index = 0; index < 100 && sends < 1; index += 1) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		assert.equal(sends, 1, "an in-flight exact replay must coalesce before APNs transport");
		await assert.rejects(
			runtime.dispatchAuthoritative({ ...authoritativeEvent, kind: "action" }),
			(error: unknown) => error instanceof OwnerPushRuntimeError
				&& error.code === "owner_push_notification_conflict",
		);
		console.log(`concurrent owner push calls_before_release=${sends}`);
		releaseSend?.();
		const [firstResult, replayResult] = await Promise.all([first, replay]);
		assert.equal(firstResult.disposition, "accepted");
		assert.equal(replayResult.disposition, "duplicate");
		assert.equal(sends, 1);
	} finally {
		releaseSend?.();
		rmSync(root, { recursive: true, force: true });
	}
}

async function testAppleTransportHeadersAndProtectedConfiguration(): Promise<void> {
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" });
	let authority = "";
	let headers: Record<string, unknown> = {};
	let sentBody = Buffer.alloc(0);
	let closed = false;
	const connect = ((value: string) => {
		authority = value;
		const session = new EventEmitter() as EventEmitter & {
			request: (value: Record<string, unknown>) => EventEmitter & { end: (body: Buffer) => void };
			close: () => void;
		};
		session.close = () => { closed = true; };
		session.request = (value) => {
			headers = value;
			const stream = new EventEmitter() as EventEmitter & { end: (body: Buffer) => void };
			stream.end = (body) => {
				sentBody = body;
				queueMicrotask(() => {
					stream.emit("response", { ":status": 200 });
					stream.emit("end");
				});
			};
			return stream;
		};
		return session;
	}) as never;
	const transport = new AppleOwnerPushTransport({
		teamId: "TEAMID1234",
		keyId: "KEYID12345",
		topic: "com.example.computer",
		privateKey: pem,
		now: () => new Date("2026-01-01T00:00:00.000Z"),
		connect,
	});
	const result = await transport.send({
		deviceToken: registration.device_token,
		environment: "sandbox",
		collapseId: envelope.notification_id,
		payload: ownerPushAPNSPayload(envelope),
	});
	assert.equal(result.accepted, true);
	assert.equal(authority, "https://api.sandbox.push.apple.com");
	assert.equal(headers[":path"], `/3/device/${registration.device_token}`);
	assert.equal(headers["apns-topic"], "com.example.computer");
	assert.equal(headers["apns-push-type"], "alert");
	assert.equal(headers["apns-collapse-id"], envelope.notification_id);
	assert.match(String(headers.authorization), /^bearer [^.]+\.[^.]+\.[^.]+$/);
	assert.deepEqual(JSON.parse(sentBody.toString("utf8")), ownerPushAPNSPayload(envelope));
	assert.equal(closed, true);

	const root = mkdtempSync(join(tmpdir(), "owner-push-apns-key-"));
	const keyPath = join(root, "AuthKey_example.p8");
	try {
		writeFileSync(keyPath, pem, { mode: 0o600 });
		const completeTransportEnvironment = {
			TROUBLEMAKER_APNS_PRIVATE_KEY_FILE: keyPath,
			TROUBLEMAKER_APNS_TEAM_ID: "TEAMID1234",
			TROUBLEMAKER_APNS_KEY_ID: "KEYID12345",
			TROUBLEMAKER_APNS_TOPIC: "com.example.computer",
		};
		assert.ok(createAppleOwnerPushTransportFromEnvironment(completeTransportEnvironment));
		const deployment = createOwnerPushDeploymentFromEnvironment({
			workingDir: root,
			contextVerifier: () => true,
			env: {
				...completeTransportEnvironment,
				TROUBLEMAKER_OWNER_PUSH_PRODUCER_TOKEN: "fixture-producer-token-with-safe-length",
			},
		});
		assert.ok(deployment?.runtime.available);
		assert.equal(deployment?.producerToken, "fixture-producer-token-with-safe-length");
		assert.equal(createOwnerPushDeploymentFromEnvironment({
			workingDir: root,
			contextVerifier: () => true,
			env: {},
		}), undefined);
		assert.throws(() => createOwnerPushDeploymentFromEnvironment({
			workingDir: root,
			contextVerifier: () => true,
			env: completeTransportEnvironment,
		}), /incomplete/);
		assert.equal(createAppleOwnerPushTransportFromEnvironment({}), undefined);
		assert.throws(() => createAppleOwnerPushTransportFromEnvironment({
			TROUBLEMAKER_APNS_PRIVATE_KEY_FILE: keyPath,
		}), /incomplete/);
		chmodSync(keyPath, 0o644);
		assert.throws(() => createAppleOwnerPushTransportFromEnvironment({
			TROUBLEMAKER_APNS_PRIVATE_KEY_FILE: keyPath,
			TROUBLEMAKER_APNS_TEAM_ID: "TEAMID1234",
			TROUBLEMAKER_APNS_KEY_ID: "KEYID12345",
			TROUBLEMAKER_APNS_TOPIC: "com.example.computer",
		}), /owner-only/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

async function testOwnerBearerFacadeRegistrationRevocationAndExactContext(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "owner-push-facade-"));
	const ownerToken = "fixture-owner-token-with-safe-length";
	const producerToken = "fixture-producer-token-with-safe-length";
	let upstream: Server | undefined;
	let facade: ConsoleAccessFacade | undefined;
	let observedRequests = 0;
	let verifiedContextHeader = "";
	try {
		mkdirSync(join(root, "protected"), { recursive: true, mode: 0o700 });
		upstream = createServer((req, res) => {
			observedRequests += 1;
			verifiedContextHeader = String(req.headers["x-troublemaker-verified-owner-context"] || "");
			res.setHeader("content-type", "application/json");
			if (req.url?.endsWith("/status")) {
				res.end(JSON.stringify({ agent_id: "agent-example", workspace_ready: true }));
				return;
			}
			res.end(JSON.stringify({ ok: true }));
		});
		const upstreamPort = await listen(upstream);
		const store = new OwnerPushStore(join(root, "protected", "owner-push.json"));
		let pushSends = 0;
		const transport: OwnerPushTransport = {
			async send() {
				pushSends += 1;
				return { accepted: true };
			},
		};
		const ownerPush = new OwnerPushRuntime({
			store,
			transport,
			contextVerifier: ({ context }) => context.context_id === "conversation-example",
		});
		const facadeBaseOptions = {
			ownerToken,
			upstreamBaseURL: new URL(`http://127.0.0.1:${upstreamPort}`),
			allowedAgentRoutes: ["current"],
			grantStore: new DeviceGrantStore(join(root, "protected", "grants.json")),
			ownerPush,
		};
		assert.throws(() => new ConsoleAccessFacade(facadeBaseOptions), /producer authority/);
		assert.throws(() => new ConsoleAccessFacade({
			...facadeBaseOptions,
			ownerPushProducerToken: ownerToken,
		}), /independent/);
		facade = new ConsoleAccessFacade({
			ownerToken,
			upstreamBaseURL: new URL(`http://127.0.0.1:${upstreamPort}`),
			allowedAgentRoutes: ["current"],
			grantStore: new DeviceGrantStore(join(root, "protected", "grants.json")),
			ownerPush,
			ownerPushProducerToken: producerToken,
		});
		const port = await facade.start(0);
		const base = `http://127.0.0.1:${port}`;
		const route = `${base}/api/v2/agents/current/owner-notification-devices`;

		assert.equal((await fetch(route, { method: "POST", body: JSON.stringify(registration) })).status, 401);
		const accepted = await fetch(route, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(registration),
		});
		const acceptedText = await accepted.text();
		assert.equal(accepted.status, 201, acceptedText);
		assert.doesNotMatch(acceptedText, new RegExp(registration.device_token));
		const duplicate = await fetch(route, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(registration),
		});
		assert.equal(duplicate.status, 200);
		assert.equal((await duplicate.json() as { disposition: string }).disposition, "duplicate");
		const wrongSubject = await fetch(route, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...registration, subject_agent_id: "other-agent" }),
		});
		assert.equal(wrongSubject.status, 403);

		const producerRoute = `${base}/api/v2/owner-notification-events`;
		const authoritativeEvent = { version: 1, kind: "completion", envelope };
		const ownerCannotProduce = await fetch(producerRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(authoritativeEvent),
		});
		assert.equal(ownerCannotProduce.status, 401, "owner/device authority is not dispatch authority");
		assert.equal(pushSends, 0);
		const wrongProducerSubject = await fetch(producerRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${producerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				...authoritativeEvent,
				envelope: { ...envelope, subject_agent_id: "agent-other" },
			}),
		});
		assert.equal(wrongProducerSubject.status, 409);
		assert.equal(pushSends, 0, "producer authority cannot bypass current route/subject identity");
		const produced = await fetch(producerRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${producerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(authoritativeEvent),
		});
		assert.equal(produced.status, 200, await produced.text());
		assert.equal(pushSends, 1, "the authenticated authoritative completion reaches transport");
		const replayed = await fetch(producerRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${producerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(authoritativeEvent),
		});
		assert.equal(replayed.status, 200, await replayed.text());
		assert.equal(pushSends, 1, "an APNs-accepted authoritative replay is not resent");
		const changedKind = await fetch(producerRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${producerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...authoritativeEvent, kind: "action" }),
		});
		assert.equal(changedKind.status, 409, "same-ID completion/action body changes conflict durably");
		assert.equal(pushSends, 1);
		const changedEvent = await fetch(producerRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${producerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				...authoritativeEvent,
				envelope: { ...envelope, event_id: "event-conflict" },
			}),
		});
		assert.equal(changedEvent.status, 409);

		const acknowledgmentRoute = `${base}/api/v2/agents/current/owner-notifications/${envelope.notification_id}/acknowledgments`;
		const acknowledgment = {
			version: 1,
			notification_id: envelope.notification_id,
			installation_id: registration.installation_id,
			binding_id: registration.binding_id,
			state: "read",
		};
		const unknownDevice = await fetch(acknowledgmentRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...acknowledgment, installation_id: "installation-other" }),
		});
		assert.equal(unknownDevice.status, 403);
		const read = await fetch(acknowledgmentRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(acknowledgment),
		});
		assert.deepEqual(await read.json(), {
			notification_id: envelope.notification_id,
			state: "read",
			changed: true,
		});
		const readReplay = await fetch(acknowledgmentRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(acknowledgment),
		});
		assert.deepEqual(await readReplay.json(), {
			notification_id: envelope.notification_id,
			state: "read",
			changed: false,
		});
		const opened = await fetch(acknowledgmentRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...acknowledgment, state: "opened" }),
		});
		assert.deepEqual(await opened.json(), {
			notification_id: envelope.notification_id,
			state: "opened",
			changed: true,
		});
		const lateRead = await fetch(acknowledgmentRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify(acknowledgment),
		});
		assert.deepEqual(await lateRead.json(), {
			notification_id: envelope.notification_id,
			state: "opened",
			changed: false,
		}, "a delayed read acknowledgment cannot regress opened state");

		const contextQuery = new URLSearchParams({
			surface: "conversation",
			context_kind: "conversation",
			context_id: "conversation-example",
			relationship_id: "binding-example",
			anchor_id: "message-example",
		});
		const contextual = await fetch(`${base}/api/v2/agents/current/events?${contextQuery}`, {
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		assert.equal(contextual.status, 200, await contextual.text());
		assert.deepEqual(
			JSON.parse(Buffer.from(verifiedContextHeader, "base64url").toString("utf8")),
			envelope.context,
		);
		const beforeStale = observedRequests;
		contextQuery.set("context_id", "stale-conversation");
		const stale = await fetch(`${base}/api/v2/agents/current/events?${contextQuery}`, {
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		assert.equal(stale.status, 409);
		assert.equal(observedRequests, beforeStale + 1, "only the identity status check reaches upstream");
		const duplicateField = await fetch(
			`${base}/api/v2/agents/current/events?context_kind=conversation&context_kind=task&context_id=x&relationship_id=binding-example`,
			{ headers: { Authorization: `Bearer ${ownerToken}` } },
		);
		assert.equal(duplicateField.status, 400);

		const messageBody = JSON.stringify({
			message: "Exact contextual message",
			deliveryId: "delivery-example-one",
			ownerContext: envelope.context,
		});
		const contextualMessage = await fetch(`${base}/api/v2/agents/current/messages`, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: messageBody,
		});
		assert.equal(contextualMessage.status, 200, await contextualMessage.text());
		assert.deepEqual(
			JSON.parse(Buffer.from(verifiedContextHeader, "base64url").toString("utf8")),
			envelope.context,
		);

		const revoke = await fetch(`${route}/${registration.installation_id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		assert.equal(revoke.status, 200);
		assert.equal((await revoke.json() as { revoked: boolean }).revoked, true);
		const revokedAcknowledgment = await fetch(acknowledgmentRoute, {
			method: "POST",
			headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ...acknowledgment, state: "opened" }),
		});
		assert.equal(revokedAcknowledgment.status, 403, "revocation removes device reconciliation authority");
		contextQuery.set("context_id", "conversation-example");
		const revokedContext = await fetch(`${base}/api/v2/agents/current/events?${contextQuery}`, {
			headers: { Authorization: `Bearer ${ownerToken}` },
		});
		assert.equal(revokedContext.status, 403, "revocation immediately removes context authority");
	} finally {
		await facade?.stop();
		await close(upstream);
		rmSync(root, { recursive: true, force: true });
	}
}

async function testContextualMessageAndStopNeverFallBack(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "owner-push-web-context-"));
	let gateway: Gateway | undefined;
	try {
		mkdirSync(join(root, "awareness"), { recursive: true });
		writeFileSync(join(root, "settings.json"), JSON.stringify({
			name: "Example Agent",
			localAgentId: "agent-example",
		}));
		const admissions: Array<{ channel: string; relationshipId: string; pairedChannelId: string }> = [];
		const stopped: string[] = [];
		const adapter = new WebAdapter({ workingDir: root });
		adapter.setHandler({
			isRunning: () => false,
			handleRelationshipBoundEvent: (event: { channel: string }, _adapter: unknown, request: { relationshipId: string; pairedChannelId: string }) => {
				admissions.push({ channel: event.channel, ...request });
				return {
					disposition: "new_turn",
					accepted: Promise.resolve(),
					completed: Promise.resolve(),
				};
			},
			handleStop: async (channel: string) => { stopped.push(channel); },
			resolvePendingInput: () => false,
			handleSlashCommand: async () => false,
			handleSteer: async () => {},
			handleVoiceEvent: () => {},
			closeVoiceSession: () => {},
			handleEvent: async () => {},
		} as never);
		gateway = new Gateway({ workspaceDir: root, consoleEnvironment: {} });
		gateway.register("/web/chat", (req, res) => adapter.dispatch(req, res));
		gateway.markReady("/web/chat");
		gateway.register("/web/stop", (req, res) => adapter.dispatchStop(req, res));
		gateway.markReady("/web/stop");
		const port = await availablePort();
		await gateway.start(port, "127.0.0.1");
		const base = `http://127.0.0.1:${port}/api/v2/agents/current`;
		const verifiedHeader = Buffer.from(JSON.stringify(envelope.context), "utf8").toString("base64url");
		const message = {
			message: "Exact contextual message",
			deliveryId: "delivery-owner-context-one",
			ownerContext: envelope.context,
		};
		const unverified = await fetch(`${base}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(message),
		});
		assert.equal(unverified.status, 403);
		assert.equal(admissions.length, 0);
		const verified = await fetch(`${base}/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Troublemaker-Verified-Owner-Context": verifiedHeader,
			},
			body: JSON.stringify(message),
		});
		assert.equal(verified.status, 200);
		assert.match(await verified.text(), /"disposition":"completed"/);
		assert.deepEqual(admissions, [{
			channel: "conversation-example",
			relationshipId: "binding-example",
			pairedChannelId: "conversation-example",
		}]);

		const mismatched = await fetch(`${base}/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Troublemaker-Verified-Owner-Context": Buffer.from(JSON.stringify({
					...envelope.context,
					context_id: "other-conversation",
				})).toString("base64url"),
			},
			body: JSON.stringify({ ...message, deliveryId: "delivery-owner-context-two" }),
		});
		assert.equal(mismatched.status, 403);
		assert.equal(admissions.length, 1);

		const stopBody = { ownerContext: envelope.context };
		const unverifiedStop = await fetch(`${base}/messages/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(stopBody),
		});
		assert.equal(unverifiedStop.status, 403);
		const verifiedStop = await fetch(`${base}/messages/stop`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Troublemaker-Verified-Owner-Context": verifiedHeader,
			},
			body: JSON.stringify(stopBody),
		});
		assert.equal(verifiedStop.status, 200);
		assert.deepEqual(stopped, ["conversation-example"]);
	} finally {
		await gateway?.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

async function testGatewayCapabilityAndContextBoundary(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "owner-push-gateway-"));
	let gateway: Gateway | undefined;
	try {
		mkdirSync(join(root, "awareness"), { recursive: true });
		writeFileSync(join(root, "settings.json"), JSON.stringify({
			name: "Example Agent",
			localAgentId: "agent-example",
		}));
		const contextLines = [
			{
				type: "message", id: "context-user", timestamp: "2026-01-01T00:00:00Z",
				message: { role: "user", content: [{ type: "text", text: "[2026-01-01] [conversation-example] [Casey]: Exact context input" }] },
			},
			{
				type: "message", id: "context-assistant", timestamp: "2026-01-01T00:00:01Z",
				message: { role: "assistant", content: [{ type: "text", text: "Exact context answer" }] },
			},
			{
				type: "message", id: "other-user", timestamp: "2026-01-01T00:00:02Z",
				message: { role: "user", content: [{ type: "text", text: "[2026-01-01] [other-conversation] [Casey]: Other input" }] },
			},
			{
				type: "message", id: "other-assistant", timestamp: "2026-01-01T00:00:03Z",
				message: { role: "assistant", content: [{ type: "text", text: "Other answer" }] },
			},
		].map((line) => JSON.stringify(line)).join("\n");
		writeFileSync(join(root, "awareness", "context.jsonl"), `${contextLines}\n`);
		const unavailable = new ConsoleService(new FilesystemWorkspaceStore(root), {}, false, false, false);
		assert.equal(unavailable.getStatus().capabilities.owner_push_v1, false);
		const available = new ConsoleService(new FilesystemWorkspaceStore(root), {}, false, false, true);
		assert.equal(available.getStatus().capabilities.owner_push_v1, true);

		gateway = new Gateway({ workspaceDir: root, ownerPushAvailable: true });
		const port = await availablePort();
		await gateway.start(port, "127.0.0.1");
		const query = "context_kind=conversation&context_id=conversation-example&relationship_id=binding-example";
		const unverified = await fetch(`http://127.0.0.1:${port}/api/v2/agents/current/events?surface=conversation&${query}`);
		assert.equal(unverified.status, 403);
		const verifiedHeader = Buffer.from(JSON.stringify({
			kind: "conversation",
			context_id: "conversation-example",
			relationship_id: "binding-example",
		}), "utf8").toString("base64url");
		const verified = await fetch(`http://127.0.0.1:${port}/api/v2/agents/current/events?surface=conversation&${query}`, {
			headers: { "X-Troublemaker-Verified-Owner-Context": verifiedHeader },
		});
		const verifiedText = await verified.text();
		assert.equal(verified.status, 200, verifiedText);
		assert.match(verifiedText, /Exact context input/);
		assert.match(verifiedText, /Exact context answer/);
		assert.doesNotMatch(verifiedText, /Other input|Other answer/, "context backlog never falls back to agent-global history");
		const mismatch = await fetch(`http://127.0.0.1:${port}/api/v2/agents/current/events?surface=conversation&${query}`, {
			headers: {
				"X-Troublemaker-Verified-Owner-Context": Buffer.from(JSON.stringify({
					kind: "task",
					context_id: "conversation-example",
					relationship_id: "binding-example",
				})).toString("base64url"),
			},
		});
		assert.equal(mismatch.status, 403);
	} finally {
		await gateway?.stop();
		rmSync(root, { recursive: true, force: true });
	}
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return address.port;
}

async function availablePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await close(server);
	return port;
}

async function close(server: Server | undefined): Promise<void> {
	if (!server?.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
