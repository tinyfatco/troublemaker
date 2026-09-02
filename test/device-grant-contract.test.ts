import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEVICE_GRANT_VERSION,
	canonicalDeviceEnrollment,
	canonicalDeviceRequest,
	deviceRequestScope,
	sha256Hex,
	type DeviceGrantDescriptor,
	type DeviceGrantEnrollmentRequest,
	type DeviceGrantScope,
} from "../src/console/device-grants.js";
import { ConsoleAccessFacade } from "../src/host/node/console-access-facade.js";
import { BoundedConsoleAccessVoiceTimingFile } from "../src/host/node/console-access-voice-timing-file.js";
import { DeviceGrantStore } from "../src/host/node/device-grant-store.js";

const root = mkdtempSync(join(tmpdir(), "troublemaker-device-grants-"));
const ownerToken = "fixture-owner-token-with-safe-length";
const upstreamAuthorization = "Bearer fixture-upstream-only";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

let upstream: Server | undefined;
let facade: ConsoleAccessFacade | undefined;
try {
	mkdirSync(join(root, "protected"), { recursive: true, mode: 0o700 });
	let observedAuthorization = "";
	let observedDeviceSignature = "";
	let observedDeviceSurface = "";
	let observedDeviceRelationship = "";
	let observedVoiceAgentCorrelation = "";
	let observedVoiceRequestCorrelation = "";
	let observedVoiceReceiptProof = "";
	let observedMethod = "";
	let observedPath = "";
	let observedRequests = 0;
	let observedBody = Buffer.alloc(0);
	upstream = createServer((req, res) => {
		observedRequests += 1;
		observedMethod = req.method || "";
		observedPath = req.url || "";
		observedAuthorization = String(req.headers.authorization || "");
		observedDeviceSignature = String(req.headers["x-troublemaker-device-signature"] || "");
		observedDeviceSurface = String(req.headers["x-troublemaker-verified-device-surface"] || "");
		observedDeviceRelationship = String(req.headers["x-troublemaker-verified-device-relationship"] || "");
		observedVoiceAgentCorrelation = String(req.headers["x-troublemaker-verified-voice-agent-correlation"] || "");
		observedVoiceRequestCorrelation = String(req.headers["x-troublemaker-verified-voice-request-correlation"] || "");
		observedVoiceReceiptProof = String(req.headers["x-troublemaker-internal-voice-receipt-proof"] || "");
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			observedBody = Buffer.concat(chunks);
			res.setHeader("content-type", "application/json");
			if (req.url?.endsWith("/status")) {
				res.end(JSON.stringify({ agent_id: "agent-example", workspace_ready: true }));
				return;
			}
			if (req.url?.includes("/deliveries")) {
				res.end(JSON.stringify({ receipts: [] }));
				return;
			}
			res.end(JSON.stringify({ ok: true }));
		});
	});
	const upstreamPort = await listen(upstream);
	const storePath = join(root, "protected", "device-grants.json");
	const store = new DeviceGrantStore(storePath);
	const requestDiagnostics: unknown[] = [];
	const voiceTimingDiagnostics: unknown[] = [];
	let timingNow = 0;
	facade = new ConsoleAccessFacade({
		ownerToken,
		upstreamAuthorization,
		upstreamBaseURL: new URL(`http://127.0.0.1:${upstreamPort}`),
		allowedAgentRoutes: ["current", "agent-example"],
		grantStore: store,
		voiceReceiptAuthorityKey: Buffer.alloc(32, 0x5a),
		maximumBodyBytes: 512,
		runtimeIdentity: "runtime-fixture-one",
		sourceIdentity: "source-fixture-one",
		onRequestDiagnostic: (diagnostic) => requestDiagnostics.push(diagnostic),
		timingNow: () => timingNow++,
		onVoiceTimingDiagnostic: (diagnostic) => voiceTimingDiagnostics.push(diagnostic),
	});
	const port = await facade.start(0);
	const base = `http://127.0.0.1:${port}`;

	const unauthorized = await fetch(`${base}/api/v2/agents/current/status`);
	assert.equal(unauthorized.status, 401);
	const oversized = await fetch(`${base}/api/v2/agents/current/messages`, {
		method: "POST",
		body: Buffer.alloc(513),
	});
	assert.equal(oversized.status, 413, "oversized input is rejected deterministically");

	const voiceRoute = "/api/v2/agents/current/voice-sessions/session-example-one";
	assert.equal(deviceRequestScope("POST", `${voiceRoute}/recording`), "voice_sessions");
	assert.equal(deviceRequestScope("POST", `${voiceRoute}/reconcile`), "voice_sessions");
	assert.equal(deviceRequestScope("GET", `${voiceRoute}/events`), "voice_sessions");
	assert.equal(deviceRequestScope("POST", `${voiceRoute}/events`), "voice_sessions");
	assert.equal(deviceRequestScope("POST", `${voiceRoute}/speech-controls`), "voice_sessions");
	for (const [method, path] of [
		["GET", `${voiceRoute}/recording`],
		["PUT", `${voiceRoute}/recording`],
		["GET", `${voiceRoute}/reconcile`],
		["POST", `${voiceRoute}/recordings`],
		["POST", `${voiceRoute}/recording/extra`],
		["GET", "/api/v2/agents/current/voice-sessions"],
	] as const) assert.equal(deviceRequestScope(method, path), null, `${method} ${path} must fail closed`);

	const enrollment = makeEnrollment(["status", "events", "deliveries", "transcriptions", "voice_sessions", "messages", "stop"]);
	const issue = await fetch(`${base}/api/v2/agents/current/device-grants`, {
		method: "POST",
		headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
		body: JSON.stringify(enrollment),
	});
	const issueBody = await issue.text();
	assert.equal(issue.status, 201, issueBody);
	const grant = JSON.parse(issueBody) as DeviceGrantDescriptor;
	assert.equal(grant.subject_agent_id, "agent-example");
	assert.equal(grant.route_agent_id, "current");
	assert.equal(grant.binding_id, "binding-example");
	assert.equal(grant.surface, "iphone");
	assert.ok(!JSON.stringify(grant).includes(enrollment.public_key), "descriptor omits the public key");
	assert.equal(statSync(storePath).mode & 0o077, 0, "grant store is owner-only");

	const statusPath = "/api/v2/agents/current/status";
	const statusHeaders = signedHeaders(grant, "GET", statusPath, Buffer.alloc(0), "", "request-nonce-status-0001");
	const status = await fetch(`${base}${statusPath}`, { headers: statusHeaders });
	assert.equal(status.status, 200, await status.text());
	assert.equal(observedAuthorization, upstreamAuthorization, "device authority is replaced before loopback forwarding");
	assert.equal(observedDeviceSignature, "", "device signature is stripped before loopback forwarding");

	const replay = await fetch(`${base}${statusPath}`, { headers: statusHeaders });
	assert.equal(replay.status, 409, "the same signed nonce cannot be replayed");
	assert.deepEqual(await replay.json(), { error: "request_replay" });
	assert.deepEqual(requestDiagnostics, [{
		outcome: "rejected",
		http_status: 409,
		response_category: "request_replay",
		request_correlation: `sha256:${sha256Hex(Buffer.from("request-nonce-status-0001")).slice(0, 24)}`,
		runtime_identity: "runtime-fixture-one",
		source_identity: "source-fixture-one",
	}], "replay diagnostics retain only bounded correlations and active identities");
	assert.doesNotMatch(JSON.stringify(requestDiagnostics), new RegExp(grant.grant_id));
	assert.doesNotMatch(JSON.stringify(requestDiagnostics), /request-nonce-status-0001/);

	const livePath = "/api/v2/agents/current/live?surface=conversation";
	const live = await fetch(`${base}${livePath}`, {
		headers: signedHeaders(grant, "GET", livePath, Buffer.alloc(0), "", "request-nonce-live-0001"),
	});
	assert.equal(live.status, 200, "the events scope preserves the existing live observation route");

	const audio = Buffer.from([0, 0, 1, 0]);
	const transcriptionPath = "/api/v2/agents/current/transcriptions";
	const transcriptionHeaders = signedHeaders(
		grant,
		"POST",
		transcriptionPath,
		audio,
		"audio/l16; rate=16000; channels=1",
		"request-nonce-audio-0001",
	);
	transcriptionHeaders["X-Transcription-ID"] = "transcription-example-one";
	const transcription = await fetch(`${base}${transcriptionPath}`, {
		method: "POST",
		headers: transcriptionHeaders,
		body: audio,
	});
	assert.equal(transcription.status, 200);
	assert.deepEqual(observedBody, audio);

	const voicePath = "/api/v2/agents/current/voice-sessions";
	const voiceBody = Buffer.from(JSON.stringify({
		version: "computer.voice-session.v1",
		identity: {
			session_id: "session-example-one",
			capture_id: "capture-example-one",
			delivery_id: "delivery-example-one",
			subject_agent_id: "agent-example",
		},
		audio: { encoding: "pcm_s16le", sample_rate: 16000, channel_count: 1 },
		configuration: { response_policy: "standard", speech_mode: "silent" },
	}));
	const voiceHeaders = signedHeaders(
		grant,
		"POST",
		voicePath,
		voiceBody,
		"application/json",
		"request-nonce-voice-0001",
	);
	voiceHeaders["X-Troublemaker-Verified-Device-Surface"] = "watch";
	voiceHeaders["X-Troublemaker-Verified-Device-Relationship"] = "relationship-spoof";
	const voice = await fetch(`${base}${voicePath}`, {
		method: "POST",
		headers: voiceHeaders,
		body: voiceBody,
	});
	assert.equal(voice.status, 200, "the explicit voice_sessions scope reaches only the bound loopback route");
	assert.deepEqual(observedBody, voiceBody);
	assert.equal(observedDeviceSignature, "", "voice-session device signatures are stripped before forwarding");
	assert.equal(observedDeviceSurface, "iphone", "only the signed verified surface is injected upstream");
	assert.equal(
		observedDeviceRelationship,
		"binding-example",
		"caller spoofing is stripped and only the grant-verified relationship is injected upstream",
	);

	const recordingPath = `${voiceRoute}/recording`;
	const recordingBody = Buffer.from(JSON.stringify({
		version: "computer.voice-recording.v1",
		identity: {
			session_id: "session-example-one",
			capture_id: "capture-example-one",
			delivery_id: "delivery-example-one",
			subject_agent_id: "agent-example",
		},
		configuration: { response_policy: "standard", speech_mode: "silent" },
		captured_at: "2026-01-01T00:00:00.000Z",
		recording_sha256: "a".repeat(64),
		audio: "AAAA",
	}));
	assert.ok(recordingBody.byteLength <= 512, "recording facade fixture remains within its explicit test bound");
	const recordingHeaders = signedHeaders(
		grant,
		"POST",
		recordingPath,
		recordingBody,
		"application/json",
		"request-nonce-recording-0001",
	);
	recordingHeaders["X-Troublemaker-Internal-Voice-Receipt-Proof"] = "untrusted-caller-value";
	const recording = await fetch(`${base}${recordingPath}`, {
		method: "POST",
		headers: recordingHeaders,
		body: recordingBody,
	});
	assert.equal(recording.status, 200, await recording.text());
	assert.equal(observedMethod, "POST");
	assert.equal(observedPath, recordingPath);
	assert.deepEqual(observedBody, recordingBody, "recording body is forwarded byte-for-byte");
	assert.equal(observedDeviceSignature, "", "recording signatures never cross the loopback boundary");
	assert.match(observedVoiceAgentCorrelation, /^sha256:[a-f0-9]{64}$/);
	assert.match(observedVoiceRequestCorrelation, /^sha256:[a-f0-9]{24}$/);
	assert.match(observedVoiceReceiptProof, /^hmac-sha256:[a-f0-9]{64}$/);
	assert.notEqual(observedVoiceReceiptProof, "untrusted-caller-value", "caller authority is replaced, not forwarded");
	const recordingTiming = voiceTimingDiagnostics as Array<{
		stage: string; ordinal: number; elapsed_milliseconds: number;
		request_correlation: string; session_correlation: string; http_status?: number;
	}>;
	assert.deepEqual(recordingTiming.map((record) => record.stage), [
		"request_body_received",
		"authorization_verified",
		"upstream_request_started",
		"upstream_response_received",
		"response_completed",
	]);
	assert.deepEqual(recordingTiming.map((record) => record.ordinal), [1, 2, 3, 4, 5]);
	assert.ok(recordingTiming.every((record, index) =>
		index === 0 || record.elapsed_milliseconds >= recordingTiming[index - 1]!.elapsed_milliseconds));
	assert.ok(recordingTiming.every((record) => record.request_correlation ===
		`sha256:${sha256Hex(Buffer.from("request-nonce-recording-0001")).slice(0, 24)}`));
	assert.ok(recordingTiming.every((record) => record.session_correlation ===
		`sha256:${sha256Hex(Buffer.from("session-example-one")).slice(0, 24)}`));
	assert.equal(recordingTiming.at(-1)?.http_status, 200);
	assert.doesNotMatch(JSON.stringify(recordingTiming), /request-nonce-recording|session-example-one|AAAA|recording_sha256/);
	const timingFilePath = join(root, "protected", "voice-facade-timing.jsonl");
	const timingFile = new BoundedConsoleAccessVoiceTimingFile(timingFilePath, 4_096);
	for (const diagnostic of voiceTimingDiagnostics) timingFile.observe(diagnostic as never);
	assert.equal(statSync(timingFilePath).mode & 0o077, 0, "facade timing file remains owner-only");
	const persistedTiming = readFileSync(timingFilePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(persistedTiming, voiceTimingDiagnostics, "deployment sink retains exact content-free facade stages");
	assert.throws(() => timingFile.observe({
		...(voiceTimingDiagnostics[0] as Record<string, unknown>),
		transcript: "must-not-persist",
	} as never), /Invalid facade voice timing diagnostic/);
	for (let index = 0; index < 100; index++) {
		for (const diagnostic of voiceTimingDiagnostics) timingFile.observe(diagnostic as never);
	}
	assert.ok(statSync(timingFilePath).size <= 4_096, "one facade timing file stays within its configured bound");
	assert.doesNotMatch(readFileSync(timingFilePath, "utf8"), /request-nonce-recording|session-example-one|must-not-persist/);
	timingFile.close();

	const reconcilePath = `${voiceRoute}/reconcile`;
	const reconcileBody = Buffer.from(JSON.stringify({ request: "synthetic-reconciliation" }));
	const reconcile = await fetch(`${base}${reconcilePath}`, {
		method: "POST",
		headers: signedHeaders(
			grant,
			"POST",
			reconcilePath,
			reconcileBody,
			"application/json",
			"request-nonce-reconcile-0001",
		),
		body: reconcileBody,
	});
	assert.equal(reconcile.status, 200, await reconcile.text());
	assert.equal(observedPath, reconcilePath);
	assert.deepEqual(observedBody, reconcileBody, "reconcile body is forwarded byte-for-byte");
	assert.equal(observedVoiceReceiptProof, "", "read/reconcile authority is distinct from audio custody receipts");

	const forwardedBeforeInvalidRoutes = observedRequests;
	for (const [method, path] of [
		["GET", recordingPath],
		["PUT", recordingPath],
		["GET", reconcilePath],
		["POST", `${voiceRoute}/recordings`],
		["POST", `${recordingPath}/extra`],
	] as const) {
		const invalid = await fetch(`${base}${path}`, { method });
		assert.equal(invalid.status, 404, `${method} ${path} fails before authentication or forwarding`);
	}
	assert.equal(observedRequests, forwardedBeforeInvalidRoutes, "invalid voice routes never reach loopback");

	const voiceReplay = await fetch(`${base}${voicePath}`, {
		method: "POST",
		headers: voiceHeaders,
		body: voiceBody,
	});
	assert.equal(voiceReplay.status, 409, "an exact voice transport replay remains rejected");
	assert.deepEqual(await voiceReplay.json(), { error: "request_replay" });
	assert.deepEqual(requestDiagnostics.at(-1), {
		outcome: "rejected",
		http_status: 409,
		response_category: "request_replay",
		request_correlation: `sha256:${sha256Hex(Buffer.from("request-nonce-voice-0001")).slice(0, 24)}`,
		session_correlation: `sha256:${sha256Hex(Buffer.from("session-example-one")).slice(0, 24)}`,
		runtime_identity: "runtime-fixture-one",
		source_identity: "source-fixture-one",
	}, "voice replay diagnostics correlate the request and session without retaining either identifier");

	const altered = Buffer.from([9, 0, 9, 0]);
	const alteredResponse = await fetch(`${base}${transcriptionPath}`, {
		method: "POST",
		headers: signedHeaders(
			grant,
			"POST",
			transcriptionPath,
			audio,
			"audio/l16; rate=16000; channels=1",
			"request-nonce-audio-0002",
		),
		body: altered,
	});
	assert.equal(alteredResponse.status, 401, "altered request bodies fail before forwarding");

	const wrongSubjectHeaders = signedHeaders(grant, "GET", statusPath, Buffer.alloc(0), "", "request-nonce-status-0002");
	wrongSubjectHeaders["X-Troublemaker-Device-Subject"] = "other-agent";
	const wrongSubject = await fetch(`${base}${statusPath}`, { headers: wrongSubjectHeaders });
	assert.equal(wrongSubject.status, 403, "the grant remains fail-closed to its exact subject");

	const statusOnlyEnrollment = makeEnrollment(["status"], "enrollment-nonce-status-only");
	const statusOnlyIssue = await fetch(`${base}/api/v2/agents/current/device-grants`, {
		method: "POST",
		headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
		body: JSON.stringify(statusOnlyEnrollment),
	});
	assert.equal(statusOnlyIssue.status, 201);
	const statusOnlyGrant = await statusOnlyIssue.json() as DeviceGrantDescriptor;
	const messagePath = "/api/v2/agents/current/messages";
	const message = Buffer.from(JSON.stringify({ message: "Hello", deliveryId: "delivery-example-one" }));
	const denied = await fetch(`${base}${messagePath}`, {
		method: "POST",
		headers: signedHeaders(
			statusOnlyGrant,
			"POST",
			messagePath,
			message,
			"application/json",
			"request-nonce-message-0001",
		),
		body: message,
	});
	assert.equal(denied.status, 403, "a grant cannot exceed its explicit scopes");
	const deniedVoice = await fetch(`${base}${voicePath}`, {
		method: "POST",
		headers: signedHeaders(
			statusOnlyGrant,
			"POST",
			voicePath,
			voiceBody,
			"application/json",
			"request-nonce-voice-denied-0001",
		),
		body: voiceBody,
	});
	assert.equal(deniedVoice.status, 403, "status-only grants cannot open voice sessions");
	const forwardedBeforeWrongScope = observedRequests;
	const deniedRecording = await fetch(`${base}${recordingPath}`, {
		method: "POST",
		headers: signedHeaders(
			statusOnlyGrant,
			"POST",
			recordingPath,
			recordingBody,
			"application/json",
			"request-nonce-recording-denied-0001",
		),
		body: recordingBody,
	});
	assert.equal(deniedRecording.status, 403, "status-only grants cannot upload voice recordings");
	const deniedReconcile = await fetch(`${base}${reconcilePath}`, {
		method: "POST",
		headers: signedHeaders(
			statusOnlyGrant,
			"POST",
			reconcilePath,
			reconcileBody,
			"application/json",
			"request-nonce-reconcile-denied-0001",
		),
		body: reconcileBody,
	});
	assert.equal(deniedReconcile.status, 403, "status-only grants cannot reconcile voice sessions");
	assert.equal(observedRequests, forwardedBeforeWrongScope, "wrong-scope voice requests never reach loopback");

	const revoke = await fetch(`${base}/api/v2/agents/current/device-grants/${grant.grant_id}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${ownerToken}` },
	});
	assert.equal(revoke.status, 200);
	const revoked = await fetch(`${base}${statusPath}`, {
		headers: signedHeaders(grant, "GET", statusPath, Buffer.alloc(0), "", "request-nonce-status-0003"),
	});
	assert.equal(revoked.status, 401);

	const ownerStatus = await fetch(`${base}${statusPath}`, {
		headers: { Authorization: `Bearer ${ownerToken}` },
	});
	assert.equal(ownerStatus.status, 200, "existing owner clients remain compatible");
	assert.equal(observedAuthorization, upstreamAuthorization);

	console.log("device grant contract tests passed");
} finally {
	await facade?.stop();
	await close(upstream);
	rmSync(root, { recursive: true, force: true });
}

function makeEnrollment(
	scopes: DeviceGrantScope[],
	nonce = "enrollment-nonce-example-0001",
	surface: "iphone" | "watch" | "mac" = "iphone",
): DeviceGrantEnrollmentRequest {
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
		binding_id: "binding-example",
		surface,
		subject_agent_id: "agent-example",
		public_key: raw.toString("base64"),
		nonce,
		scopes,
	};
	return {
		...unsigned,
		signature: sign(
			"sha256",
			Buffer.from(canonicalDeviceEnrollment("current", unsigned), "utf8"),
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
	const input = {
		method,
		pathAndQuery,
		timestamp,
		nonce,
		contentType,
		bodyDigest,
		subjectAgentId: grant.subject_agent_id,
	};
	const signature = sign(
		"sha256",
		Buffer.from(canonicalDeviceRequest(input), "utf8"),
		privateKey,
	).toString("base64");
	return {
		Authorization: `DeviceGrant ${grant.grant_id}`,
		"X-Troublemaker-Device-Timestamp": timestamp,
		"X-Troublemaker-Device-Nonce": nonce,
		"X-Troublemaker-Device-Body-SHA256": bodyDigest,
		"X-Troublemaker-Device-Signature": signature,
		"X-Troublemaker-Device-Subject": grant.subject_agent_id,
		...(contentType ? { "Content-Type": contentType } : {}),
	};
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return address.port;
}

async function close(server: Server | undefined): Promise<void> {
	if (!server?.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
