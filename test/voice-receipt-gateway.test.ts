import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEVICE_GRANT_VERSION,
	canonicalDeviceEnrollment,
	canonicalDeviceRequest,
	sha256Hex,
	type DeviceGrantDescriptor,
	type DeviceGrantEnrollmentRequest,
	type DeviceGrantScope,
} from "../src/console/device-grants.js";
import {
	VOICE_RECORDING_VERSION,
	VOICE_SESSION_VERSION,
	type VoiceIdentity,
} from "../src/console/voice-session-contract.js";
import { VoiceSessionRuntime, type VoiceTranscriptionProvider } from "../src/console/voice-session-runtime.js";
import { VoiceSessionStore } from "../src/console/voice-session-store.js";
import {
	VOICE_RECEIPT_VERSION,
	voiceReceiptAgentCorrelation,
	voiceReceiptCorrelation,
} from "../src/console/voice-receipts.js";
import { Gateway } from "../src/gateway.js";
import { ConsoleAccessFacade } from "../src/host/node/console-access-facade.js";
import { DeviceGrantStore } from "../src/host/node/device-grant-store.js";

const root = mkdtempSync(join(tmpdir(), "troublemaker-voice-receipt-gateway-"));
const previousLocalAgentID = process.env.TROUBLEMAKER_LOCAL_AGENT_ID;
process.env.TROUBLEMAKER_LOCAL_AGENT_ID = "agent-example";
const ownerToken = "fixture-owner-token-with-safe-length";
const routeAgentID = "agent-example";
const voiceReceiptAuthorityKey = Buffer.alloc(32, 0x5a);
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const provider: VoiceTranscriptionProvider = {
	open() { return { append() {}, finish() {}, cancel() {} }; },
};
const canonical = { async prepare() { throw new Error("canonical work is not expected"); } };
let gateway: Gateway | undefined;
let facade: ConsoleAccessFacade | undefined;
let gatewayPort = 0;

try {
	mkdirSync(join(root, "awareness"), { recursive: true });
	mkdirSync(join(root, "protected"), { recursive: true, mode: 0o700 });
	writeFileSync(join(root, "settings.json"), JSON.stringify({
		name: "Example Agent",
		localAgentId: routeAgentID,
	}));
	const sessionDirectory = join(root, "voice-sessions");
	const grantPath = join(root, "protected", "device-grants.json");
	({ gateway, facade, gatewayPort } = await startStack(sessionDirectory, grantPath));
	let facadePort = facadePortOf(facade);

	const grant = await issueGrant(facadePort, ["voice_sessions", "voice_receipts"], "enrollment-nonce-receipt-0001");
	const identity: VoiceIdentity = {
		session_id: "session-receipt-example",
		capture_id: "capture-receipt-example",
		delivery_id: "delivery-receipt-example",
		subject_agent_id: routeAgentID,
	};
	const openPath = `/api/v2/agents/${routeAgentID}/voice-sessions`;
	const openBody = Buffer.from(JSON.stringify({
		version: VOICE_SESSION_VERSION,
		identity,
		audio: { encoding: "pcm_s16le", sample_rate: 16_000, channel_count: 1 },
		configuration: { response_policy: "concise_watch", speech_mode: "silent" },
	}));
	let response = await fetch(`http://127.0.0.1:${facadePort}${openPath}`, {
		method: "POST",
		headers: signedHeaders(grant, "POST", openPath, openBody, "application/json", "request-nonce-open-receipt-0001"),
		body: openBody,
	});
	assert.equal(response.status, 200, await response.text());

	const eventPath = `${openPath}/${identity.session_id}/events`;
	const eventBody = Buffer.from(JSON.stringify({
		version: VOICE_SESSION_VERSION,
		identity,
		sequence: 1,
		kind: "audio",
		audio: Buffer.alloc(32).toString("base64"),
		duration_milliseconds: 1,
	}));
	const eventNonce = "request-nonce-event-receipt-0001";
	const eventHeaders = signedHeaders(grant, "POST", eventPath, eventBody, "application/json", eventNonce);
	eventHeaders["X-Troublemaker-Verified-Voice-Agent-Correlation"] = `sha256:${"a".repeat(64)}`;
	eventHeaders["X-Troublemaker-Verified-Voice-Request-Correlation"] = `sha256:${"b".repeat(24)}`;
	eventHeaders["X-Troublemaker-Internal-Voice-Receipt-Proof"] = `hmac-sha256:${"c".repeat(64)}`;
	response = await fetch(`http://127.0.0.1:${facadePort}${eventPath}`, {
		method: "POST",
		headers: eventHeaders,
		body: eventBody,
	});
	assert.equal(response.status, 200, await response.text());
	const cancelBody = Buffer.from(JSON.stringify({
		version: VOICE_SESSION_VERSION,
		identity,
		sequence: 2,
		kind: "cancel",
	}));
	response = await fetch(`http://127.0.0.1:${facadePort}${eventPath}`, {
		method: "POST",
		headers: signedHeaders(
			grant,
			"POST",
			eventPath,
			cancelBody,
			"application/json",
			"request-nonce-cancel-receipt-0001",
		),
		body: cancelBody,
	});
	assert.equal(response.status, 200, "non-audio voice events remain compatible with signed facade headers");

	const recordingIdentity: VoiceIdentity = {
		session_id: "session-recording-authority-example",
		capture_id: "capture-recording-authority-example",
		delivery_id: "delivery-recording-authority-example",
		subject_agent_id: routeAgentID,
	};
	const recordingPCM = Buffer.alloc(32, 0x2a);
	const recordingPath = `${openPath}/${recordingIdentity.session_id}/recording`;
	const recordingBody = Buffer.from(JSON.stringify({
		version: VOICE_RECORDING_VERSION,
		identity: recordingIdentity,
		configuration: { response_policy: "concise_watch", speech_mode: "silent" },
		captured_at: new Date().toISOString(),
		recording_sha256: sha256Hex(recordingPCM),
		audio: recordingPCM.toString("base64"),
	}));
	response = await fetch(`http://127.0.0.1:${facadePort}${recordingPath}`, {
		method: "POST",
		headers: signedHeaders(
			grant,
			"POST",
			recordingPath,
			recordingBody,
			"application/json",
			"request-nonce-recording-authority-0001",
		),
		body: recordingBody,
	});
	assert.equal(response.status, 200, await response.text());

	const sessionCorrelation = voiceReceiptCorrelation(identity.session_id);
	const requestCorrelation = voiceReceiptCorrelation(eventNonce);
	const lookupQuery = new URLSearchParams({
		session_correlation: sessionCorrelation,
		request_correlation: requestCorrelation,
		client_sequence: "1",
	});
	const lookupPath = `/api/v2/agents/${routeAgentID}/voice-receipts?${lookupQuery}`;
	const publicAgentCorrelation = voiceReceiptAgentCorrelation(routeAgentID, routeAgentID);
	const forgedInternalHeaders = {
		"Content-Type": "application/json",
		"X-Troublemaker-Verified-Voice-Agent-Correlation": publicAgentCorrelation,
		"X-Troublemaker-Verified-Voice-Request-Correlation": `sha256:${"b".repeat(24)}`,
		"X-Troublemaker-Internal-Voice-Receipt-Proof": `hmac-sha256:${"c".repeat(64)}`,
	};
	response = await fetch(`http://127.0.0.1:${gatewayPort}${eventPath}`, {
		method: "POST",
		headers: forgedInternalHeaders,
		body: eventBody,
	});
	assert.equal(response.status, 403, "a direct loopback caller cannot mint an audio receipt from public hashes");
	response = await fetch(`http://127.0.0.1:${gatewayPort}${recordingPath}`, {
		method: "POST",
		headers: forgedInternalHeaders,
		body: recordingBody,
	});
	assert.equal(response.status, 403, "a direct loopback caller cannot forge whole-recording body authority");
	response = await fetch(`http://127.0.0.1:${gatewayPort}${lookupPath}`, {
		headers: forgedInternalHeaders,
	});
	assert.equal(response.status, 403, "a direct loopback caller cannot read receipts with a forged internal proof");

	response = await signedFetch(facadePort, grant, lookupPath, "request-nonce-lookup-receipt-0001");
	const firstBody = await response.text();
	assert.equal(response.status, 200, firstBody);
	const first = JSON.parse(firstBody) as {
		version: string;
		receipt: Record<string, unknown>;
	};
	assert.equal(first.version, VOICE_RECEIPT_VERSION);
	assert.deepEqual(Object.keys(first.receipt).sort(), [
		"client_sequence",
		"kind",
		"receipt_digest",
		"request_correlation",
		"server_sequence",
		"session_correlation",
		"version",
	].sort());
	assert.equal(first.receipt.session_correlation, sessionCorrelation);
	assert.equal(first.receipt.request_correlation, requestCorrelation, "caller-forged internal correlation is stripped and replaced");
	assert.equal(first.receipt.client_sequence, 1);
	assert.equal(first.receipt.kind, "event_applied");
	assert.doesNotMatch(JSON.stringify(first), /session-receipt-example|request-nonce-event|audio|transcript|text|url|route|prompt|credential/i);

	response = await signedFetch(facadePort, grant, lookupPath, "request-nonce-lookup-receipt-0002");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), first, "lookup is idempotent across fresh signed requests");

	const forgedQuery = new URLSearchParams(lookupQuery);
	forgedQuery.set("request_correlation", `sha256:${"b".repeat(24)}`);
	const forgedPath = `/api/v2/agents/${routeAgentID}/voice-receipts?${forgedQuery}`;
	response = await signedFetch(facadePort, grant, forgedPath, "request-nonce-lookup-receipt-0003");
	assert.equal(response.status, 404, "forged correlation cannot select the durable receipt");

	const invalidPath = `/api/v2/agents/${routeAgentID}/voice-receipts?session_correlation=${encodeURIComponent(sessionCorrelation)}&request_correlation=${encodeURIComponent(requestCorrelation)}&client_sequence=01`;
	response = await signedFetch(facadePort, grant, invalidPath, "request-nonce-lookup-receipt-0004");
	assert.equal(response.status, 400, "lookup identity must be canonical and exact");

	response = await fetch(`http://127.0.0.1:${facadePort}${lookupPath}`, {
		headers: { Authorization: `Bearer ${ownerToken}` },
	});
	assert.equal(response.status, 403, "portable receipt lookup requires an exact device grant");

	const voiceOnly = await issueGrant(facadePort, ["voice_sessions"], "enrollment-nonce-receipt-0002");
	response = await signedFetch(facadePort, voiceOnly, lookupPath, "request-nonce-lookup-receipt-0005");
	assert.equal(response.status, 403, "voice session authority does not imply receipt lookup authority");

	const receiptOnly = await issueGrant(facadePort, ["voice_receipts"], "enrollment-nonce-receipt-0003");
	response = await signedFetch(facadePort, receiptOnly, lookupPath, "request-nonce-lookup-receipt-0006");
	assert.equal(response.status, 200, "a fresh bound receipt grant can recover prior custody");
	assert.deepEqual(await response.json(), first);
	response = await fetch(`http://127.0.0.1:${facadePort}${openPath}`, {
		method: "POST",
		headers: signedHeaders(receiptOnly, "POST", openPath, openBody, "application/json", "request-nonce-open-receipt-denied"),
		body: openBody,
	});
	assert.equal(response.status, 403, "receipt-only authority cannot open or mutate a voice session");

	const otherRoutePath = lookupPath.replace(`/agents/${routeAgentID}/`, "/agents/other-agent/");
	response = await signedFetch(facadePort, grant, otherRoutePath, "request-nonce-lookup-other-agent");
	assert.equal(response.status, 404, "cross-agent routes cannot enumerate receipts");

	await facade.stop();
	facade = undefined;
	await gateway.stop();
	gateway = undefined;
	({ gateway, facade, gatewayPort } = await startStack(sessionDirectory, grantPath));
	facadePort = facadePortOf(facade);
	response = await signedFetch(facadePort, receiptOnly, lookupPath, "request-nonce-lookup-after-restart");
	assert.equal(response.status, 200, "receipt survives process restart without replaying the voice event");
	assert.deepEqual(await response.json(), first);

	console.log("voice receipt gateway tests passed");
} finally {
	await facade?.stop();
	await gateway?.stop();
	rmSync(root, { recursive: true, force: true });
	if (previousLocalAgentID === undefined) delete process.env.TROUBLEMAKER_LOCAL_AGENT_ID;
	else process.env.TROUBLEMAKER_LOCAL_AGENT_ID = previousLocalAgentID;
}

async function startStack(sessionDirectory: string, grantPath: string) {
	const runtime = new VoiceSessionRuntime({
		transcription: provider,
		canonical,
		store: new VoiceSessionStore(sessionDirectory, 64 * 1024 * 1024, 8),
		inputWindow: 2,
	});
	const nextGateway = new Gateway({
		workspaceDir: root,
		voiceSessions: runtime,
		voiceReceiptAuthorityKey,
	});
	const gatewayPort = await availablePort();
	await nextGateway.start(gatewayPort, "127.0.0.1");
	const nextFacade = new ConsoleAccessFacade({
		ownerToken,
		upstreamBaseURL: new URL(`http://127.0.0.1:${gatewayPort}`),
		allowedAgentRoutes: [routeAgentID],
		grantStore: new DeviceGrantStore(grantPath),
		voiceReceiptAuthorityKey,
	});
	const facadePort = await nextFacade.start(0);
	Object.defineProperty(nextFacade, "fixturePort", { value: facadePort });
	return { gateway: nextGateway, facade: nextFacade, gatewayPort };
}

function facadePortOf(value: ConsoleAccessFacade): number {
	return (value as ConsoleAccessFacade & { fixturePort: number }).fixturePort;
}

async function issueGrant(
	port: number,
	scopes: DeviceGrantScope[],
	nonce: string,
): Promise<DeviceGrantDescriptor> {
	const enrollment = makeEnrollment(scopes, nonce);
	const response = await fetch(`http://127.0.0.1:${port}/api/v2/agents/${routeAgentID}/device-grants`, {
		method: "POST",
		headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
		body: JSON.stringify(enrollment),
	});
	const body = await response.text();
	assert.equal(response.status, 201, body);
	return JSON.parse(body) as DeviceGrantDescriptor;
}

function makeEnrollment(scopes: DeviceGrantScope[], nonce: string): DeviceGrantEnrollmentRequest {
	const jwk = publicKey.export({ format: "jwk" });
	assert.equal(jwk.crv, "P-256");
	assert.ok(jwk.x && jwk.y);
	const raw = Buffer.concat([
		Buffer.from([0x04]),
		Buffer.from(jwk.x, "base64url"),
		Buffer.from(jwk.y, "base64url"),
	]);
	const unsigned = {
		version: DEVICE_GRANT_VERSION,
		binding_id: "binding-receipt-example",
		surface: "watch" as const,
		subject_agent_id: routeAgentID,
		public_key: raw.toString("base64"),
		nonce,
		scopes,
	};
	return {
		...unsigned,
		signature: sign(
			"sha256",
			Buffer.from(canonicalDeviceEnrollment(routeAgentID, unsigned), "utf8"),
			privateKey,
		).toString("base64"),
	};
}

function signedHeaders(
	grant: DeviceGrantDescriptor,
	method: string,
	pathAndQuery: string,
	body: Buffer,
	contentType: string,
	nonce: string,
): Record<string, string> {
	const timestamp = String(Math.floor(Date.now() / 1_000));
	const bodyDigest = sha256Hex(body);
	const canonical = {
		method,
		pathAndQuery,
		timestamp,
		nonce,
		contentType,
		bodyDigest,
		subjectAgentId: grant.subject_agent_id,
	};
	return {
		Authorization: `DeviceGrant ${grant.grant_id}`,
		"X-Troublemaker-Device-Timestamp": timestamp,
		"X-Troublemaker-Device-Nonce": nonce,
		"X-Troublemaker-Device-Body-SHA256": bodyDigest,
		"X-Troublemaker-Device-Signature": sign(
			"sha256",
			Buffer.from(canonicalDeviceRequest(canonical), "utf8"),
			privateKey,
		).toString("base64"),
		"X-Troublemaker-Device-Subject": grant.subject_agent_id,
		...(contentType ? { "Content-Type": contentType } : {}),
	};
}

async function signedFetch(
	port: number,
	grant: DeviceGrantDescriptor,
	pathAndQuery: string,
	nonce: string,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
		headers: signedHeaders(grant, "GET", pathAndQuery, Buffer.alloc(0), "", nonce),
	});
}

async function availablePort(): Promise<number> {
	const server: Server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
