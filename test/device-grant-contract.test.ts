import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
import { ConsoleAccessFacade } from "../src/host/node/console-access-facade.js";
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
	let observedBody = Buffer.alloc(0);
	upstream = createServer((req, res) => {
		observedAuthorization = String(req.headers.authorization || "");
		observedDeviceSignature = String(req.headers["x-troublemaker-device-signature"] || "");
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
	facade = new ConsoleAccessFacade({
		ownerToken,
		upstreamAuthorization,
		upstreamBaseURL: new URL(`http://127.0.0.1:${upstreamPort}`),
		allowedAgentRoutes: ["current", "agent-example"],
		grantStore: store,
		maximumBodyBytes: 256,
	});
	const port = await facade.start(0);
	const base = `http://127.0.0.1:${port}`;

	const unauthorized = await fetch(`${base}/api/v2/agents/current/status`);
	assert.equal(unauthorized.status, 401);
	const oversized = await fetch(`${base}/api/v2/agents/current/messages`, {
		method: "POST",
		body: Buffer.alloc(257),
	});
	assert.equal(oversized.status, 413, "oversized input is rejected deterministically");

	const enrollment = makeEnrollment(["status", "events", "deliveries", "transcriptions", "messages", "stop"]);
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
