import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Check } from "typebox/schema";
import {
	canonicalDeviceEnrollment, canonicalDeviceRequest, deviceRequestScope, sha256Hex,
	type DeviceGrantDescriptor, type DeviceGrantEnrollmentRequest, type DeviceGrantScope,
} from "../src/console/device-grants.js";
import {
	decodeOwnerReviewMedia, ownerReviewApprovalDigest, ownerReviewNotification,
	parseOwnerReviewApproval, parseOwnerReviewArtifact, parseOwnerReviewPut,
	type OwnerReviewApproval, type OwnerReviewPutRequest,
} from "../src/console/owner-review.js";
import { parseOwnerPushEnvelope } from "../src/console/owner-push.js";
import { ConsoleAccessFacade } from "../src/host/node/console-access-facade.js";
import { DeviceGrantStore } from "../src/host/node/device-grant-store.js";
import { OwnerReviewError, OwnerReviewStore, type OwnerReviewFileOperations } from "../src/host/node/owner-review-store.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/owner-review-v1.json", import.meta.url), "utf8"));
const schemaBytes = readFileSync(new URL("../docs/owner-review-v1.schema.json", import.meta.url));
const schema = JSON.parse(schemaBytes.toString());
function matchesSchema(definition: string, value: unknown): boolean {
	return Check({ ...schema, $ref: `#/$defs/${definition}` }, value);
}
const binding = { binding_id: "binding-example", route_agent_id: "current", subject_agent_id: "agent-example" };
const itemID = "work-item-example";
const itemPath = `/api/v2/agents/current/owner-review-items/${itemID}`;
const producerPaths = { put: "/api/v2/owner-review-items", claim: "/api/v2/owner-review-executions", reconcile: "/api/v2/owner-review-reconciliations" };
const ownerToken = "fixture-owner-token-with-safe-length";
const producerToken = "fixture-independent-producer-with-safe-length";

function put(revision = "revision-one", text = fixture.text, media = Buffer.from(fixture.media_base64, "base64")): OwnerReviewPutRequest {
	return { version: 1, ...binding, expected_revision_id: revision === "revision-one" ? null : "revision-one",
		artifact: { ...fixture.artifact, revision_id: revision, text_sha256: sha256Hex(Buffer.from(text)), media_sha256: sha256Hex(media) },
		text, media_type: "video/mp4", media_base64: media.toString("base64") };
}
function approval(request = put(), id = "approval-one"): OwnerReviewApproval {
	return { version: 1, approval_id: id, artifact_approval_digest: ownerReviewApprovalDigest(request.artifact) };
}
function claim(a = approval(), id = "attempt-one") {
	return { version: 1, ...binding, work_item_id: itemID, attempt_id: id, approval: a };
}
function reconciliation(outcome: "completed" | "not_completed" = "completed") {
	return { version: 1, ...binding, work_item_id: itemID, attempt_id: "attempt-one", artifact_approval_digest: approval().artifact_approval_digest, reconciliation_id: "reconciliation-one", outcome };
}
function temporary(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "owner-review-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}
function rejects(code: string) { return (error: unknown) => error instanceof OwnerReviewError && error.code === code; }

test("frozen native wire fields, digest vector, exact Unicode text, and bounded canonical base64", () => {
	assert.deepEqual(parseOwnerReviewArtifact(fixture.artifact), fixture.artifact);
	assert.deepEqual(parseOwnerReviewApproval(fixture.approval), fixture.approval);
	assert.equal(ownerReviewApprovalDigest(fixture.artifact), fixture.approval.artifact_approval_digest);
	assert.equal(sha256Hex(Buffer.from(fixture.canonical)), fixture.approval.artifact_approval_digest);
	assert.equal(parseOwnerReviewArtifact({ ...fixture.artifact, action: "send" }), null);
	assert.equal(parseOwnerReviewArtifact({ ...fixture.artifact, account_id: "account\ninjection" }), null);
	assert.equal(parseOwnerReviewArtifact({ ...fixture.artifact, media_sha256: fixture.artifact.media_sha256.toUpperCase() }), null);
	assert.equal(parseOwnerReviewApproval({ ...fixture.approval, approved: true }), null);
	assert.equal(parseOwnerReviewApproval({ ...fixture.approval, version: 2 }), null);
	for (const key of ["work_item_id", "revision_id", "media_id", "account_id"]) {
		assert.notEqual(ownerReviewApprovalDigest({ ...fixture.artifact, [key]: "changed-example" }), fixture.approval.artifact_approval_digest);
	}
	for (const key of ["media_sha256", "text_sha256"]) {
		assert.notEqual(ownerReviewApprovalDigest({ ...fixture.artifact, [key]: "a".repeat(64) }), fixture.approval.artifact_approval_digest);
	}
	const exact = "  Draft e\u0301 🌱\r\n";
	assert.equal(parseOwnerReviewPut(put("revision-one", exact))?.text, exact);
	assert.notEqual(approval(put("revision-one", exact)).artifact_approval_digest, approval(put("revision-one", exact.normalize("NFC"))).artifact_approval_digest);
	assert.equal(parseOwnerReviewPut(put("revision-one", "\ud800")), null);
	assert.equal(parseOwnerReviewPut(put("revision-one", "x".repeat(128 * 1024 + 1))), null);
	assert.equal(parseOwnerReviewPut({ ...put(), text: "substituted" }), null);
	assert.equal(parseOwnerReviewPut({ ...put(), media_base64: Buffer.from("substituted").toString("base64") }), null);
	const maximum = Buffer.alloc(8 * 1024 * 1024, 42);
	assert.deepEqual(decodeOwnerReviewMedia(maximum.toString("base64")), maximum);
	assert.equal(decodeOwnerReviewMedia(Buffer.alloc(maximum.length + 1).toString("base64")), null);
	for (const malformed of ["", "Zg", "Zh==", " Zg==", "Zg==\n", "____", "===="]) assert.equal(decodeOwnerReviewMedia(malformed), null);
});

test("frozen JSON schema validates producer, native, current view, and decision/execution responses", (t) => {
	assert.equal(sha256Hex(schemaBytes), "607927bf36faeca7365baff8c81d615dbaed51f79b83ddcaa27ea61ef640fc89", "v1 schema is frozen; incompatible changes require v2");
	const store = new OwnerReviewStore(join(temporary(t), "reviews"));
	for (const [definition, value] of [["OwnerReviewArtifactVersion", fixture.artifact], ["OwnerReviewApproval", fixture.approval],
		["put_request", put()], ["execution_request", claim()], ["reconciliation_request", reconciliation()],
		["mutation_result", store.put(put())], ["work_item", store.get(binding, itemID)],
		["decision_result", store.decide(binding, itemID, approval(), "approved")],
		["execution_result", store.claimExecution(claim())], ["execution_result", store.claimExecution(claim())],
		["mutation_result", store.reconcile(reconciliation())]]) {
		assert.equal(matchesSchema(definition as string, value), true, definition as string);
		assert.equal(matchesSchema(definition as string, { ...value, unexpected: true }), false, `${definition} rejects extra fields`);
	}
	assert.equal(matchesSchema("OwnerReviewApproval", { ...fixture.approval, version: 2 }), false);
	assert.equal(matchesSchema("execution_result", { disposition: "claimed", may_execute: false, work_item: store.get(binding, itemID) }), false);
});

test("overlapping store readers and writers cannot observe an unsynced rename", (t) => {
	const directory = join(temporary(t), "reviews");
	const store = new OwnerReviewStore(directory);
	store.put(put());
	store.decide(binding, itemID, approval(), "approved");
	let intercepted = false;
	const writer = new OwnerReviewStore(directory, { rename(from, to) {
		renameSync(from, to);
		if (to.endsWith("reviews.json")) {
			intercepted = true;
			assert.throws(() => store.get(binding, itemID), rejects("owner_review_store_busy"));
			assert.throws(() => store.claimExecution(claim()), rejects("owner_review_store_busy"));
		}
	} });
	assert.equal(writer.claimExecution(claim()).may_execute, true);
	assert.equal(intercepted, true);
	assert.equal(store.claimExecution(claim()).may_execute, false);
});

test("revision CAS, approval/rejection idempotency, edits and restart never revive old authority", (t) => {
	const directory = join(temporary(t), "reviews");
	const store = new OwnerReviewStore(directory);
	assert.equal(store.put(put()).work_item.state, "pending_review");
	assert.equal(store.decide(binding, itemID, approval(), "approved").work_item.state, "approved");
	const peer = new OwnerReviewStore(directory);
	assert.equal(peer.decide(binding, itemID, approval(), "approved").disposition, "duplicate");
	const no = approval(put(), "rejection-one");
	assert.equal(peer.decide(binding, itemID, no, "rejected").work_item.state, "rejected");
	assert.equal(store.decide(binding, itemID, approval(), "approved").work_item.state, "rejected", "retry cannot reverse a newer decision");
	assert.throws(() => store.claimExecution(claim()), rejects("owner_review_approval_required"));
	assert.throws(() => peer.decide(binding, itemID, no, "approved"), rejects("owner_review_approval_conflict"));
	const changed = put("revision-two", "edited text");
	assert.equal(store.put(changed).work_item.state, "pending_review");
	assert.equal(peer.put(put()).work_item.artifact.revision_id, "revision-two", "old producer retry cannot roll back current revision");
	assert.equal(peer.decide(binding, itemID, approval(), "approved").work_item.state, "pending_review");
	assert.throws(() => store.decide(binding, itemID, approval(put(), "approval-stale"), "approved"), rejects("owner_review_stale_revision"));
	assert.throws(() => store.claimExecution(claim()), rejects("owner_review_approval_required"));
	assert.throws(() => peer.put(put("revision-three")), rejects("owner_review_stale_revision"));
	assert.throws(() => peer.put({ ...changed, artifact: { ...changed.artifact, account_id: "account-two" } }), rejects("owner_review_revision_conflict"));
	assert.throws(() => peer.put({ ...put("revision-three", "draft", Buffer.from("new-media")), expected_revision_id: "revision-two" }), rejects("owner_review_media_conflict"));
	const finalApproval = approval(changed, "approval-two");
	assert.equal(peer.decide(binding, itemID, finalApproval, "approved").work_item.state, "approved");
	const restarted = new OwnerReviewStore(directory);
	assert.equal(restarted.claimExecution(claim(finalApproval)).may_execute, true);
	assert.equal(store.claimExecution(claim(finalApproval)).may_execute, false, "two store instances read current custody from disk");
	assert.throws(() => restarted.put({ ...put("revision-three"), expected_revision_id: "revision-two" }), rejects("owner_review_reconciliation_required"));
	assert.throws(() => store.decide(binding, itemID, approval(changed, "rejection-two"), "rejected"), rejects("owner_review_execution_already_claimed"));
	for (const field of ["binding_id", "subject_agent_id", "route_agent_id"]) {
		assert.throws(() => store.get({ ...binding, [field]: "other-example" }, itemID), rejects("owner_review_not_found"));
		assert.throws(() => store.media({ ...binding, [field]: "other-example" }, itemID, "revision-one"), rejects("owner_review_not_found"));
	}
});

test("uncertain execution requires authoritative reconciliation, terminal attempts never repeat", (t) => {
	const directory = join(temporary(t), "reviews");
	let store = new OwnerReviewStore(directory);
	store.put(put());
	assert.throws(() => store.claimExecution(claim()), rejects("owner_review_approval_required"));
	store.decide(binding, itemID, approval(), "approved");
	assert.equal(store.claimExecution(claim()).may_execute, true);
	store = new OwnerReviewStore(directory);
	assert.equal(store.claimExecution(claim()).may_execute, false);
	assert.throws(() => store.claimExecution(claim(approval(), "attempt-two")), rejects("owner_review_execution_already_claimed"));
	assert.throws(() => store.reconcile({ ...reconciliation(), outcome: "unknown" }), rejects("invalid_owner_review_reconciliation"));
	assert.throws(() => store.reconcile({ ...reconciliation(), artifact_approval_digest: "a".repeat(64) }), rejects("owner_review_execution_conflict"));
	assert.equal(store.reconcile(reconciliation("not_completed")).work_item.state, "not_completed");
	assert.equal(store.reconcile(reconciliation("not_completed")).disposition, "duplicate");
	assert.throws(() => store.reconcile(reconciliation()), rejects("owner_review_reconciliation_conflict"));
	assert.equal(store.claimExecution(claim()).may_execute, false);
	assert.throws(() => store.claimExecution(claim(approval(), "attempt-two")), rejects("owner_review_execution_already_claimed"));
	assert.equal(store.put(put("revision-two")).work_item.state, "pending_review");
	assert.equal(store.claimExecution(claim()).may_execute, false);
});

test("push is only an existing content-free context pointer with current binding authorization", (t) => {
	const store = new OwnerReviewStore(join(temporary(t), "reviews"));
	const work = store.put(put()).work_item;
	const envelope = ownerReviewNotification(work, "notification-example", "event-example");
	assert.deepEqual(parseOwnerPushEnvelope(envelope), envelope);
	const serialized = JSON.stringify(envelope);
	for (const privateValue of [work.text, work.artifact.media_sha256, work.artifact.text_sha256, work.artifact.account_id, work.artifact.media_id, work.artifact_approval_digest]) assert.equal(serialized.includes(privateValue), false);
	const context = { context: envelope.context, routeAgentId: binding.route_agent_id, subjectAgentId: binding.subject_agent_id, bindingId: binding.binding_id };
	assert.equal(store.authorizesContext(context), true);
	assert.equal(store.authorizesContext({ ...context, bindingId: "binding-other" }), false);
	store.put(put("revision-two"));
	assert.equal(store.authorizesContext(context), false);
});

type Failure = "write" | "file-sync" | "rename-before" | "rename-after" | "directory-sync";
function faultFiles(failure: Failure, target: "metadata" | "blob" = "metadata") {
	let armed = false;
	let renamedTarget = false;
	const matches = (path: string) => target === "metadata" ? path.includes("reviews.json") : path.includes(".blob");
	const fail = () => { armed = false; throw new Error("synthetic storage failure"); };
	const files: OwnerReviewFileOperations = {
		write(path, bytes) { if (armed && matches(path) && failure === "write") fail(); writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); },
		sync(path) {
			if (armed && ((matches(path) && failure === "file-sync") || (renamedTarget && failure === "directory-sync"))) fail();
			const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
		},
		rename(from, to) {
			if (armed && matches(to) && failure === "rename-before") fail();
			renameSync(from, to);
			if (armed && matches(to)) { renamedTarget = true; if (failure === "rename-after") fail(); }
		},
	};
	return { files, arm: () => { armed = true; renamedTarget = false; } };
}

for (const failure of ["write", "file-sync", "rename-before", "rename-after", "directory-sync"] as const) {
	for (const operation of ["approve", "edit", "claim", "reconcile"] as const) {
		test(`durable ${operation}: ${failure} returns no success and restart follows committed disk`, (t) => {
			const directory = join(temporary(t), "reviews");
			const fault = faultFiles(failure);
			const store = new OwnerReviewStore(directory, fault.files);
			store.put(put());
			if (operation !== "approve") store.decide(binding, itemID, approval(), "approved");
			if (operation === "reconcile") store.claimExecution(claim());
			fault.arm();
			const action = () => operation === "approve" ? store.decide(binding, itemID, approval(), "approved")
				: operation === "edit" ? store.put(put("revision-two")) : operation === "claim" ? store.claimExecution(claim()) : store.reconcile(reconciliation());
			assert.throws(action, rejects("owner_review_durability_uncertain"));
			assert.throws(() => store.get(binding, itemID), rejects("owner_review_durability_uncertain"), "failed instance cannot expose optimistic authority");
			const restarted = new OwnerReviewStore(directory);
			const committed = failure === "rename-after" || failure === "directory-sync";
			const state = restarted.get(binding, itemID).state;
			assert.equal(state, operation === "approve" ? (committed ? "approved" : "pending_review")
				: operation === "edit" ? (committed ? "pending_review" : "approved")
					: operation === "claim" ? (committed ? "uncertain" : "approved") : (committed ? "completed" : "uncertain"));
			if (operation === "claim") assert.equal(restarted.claimExecution(claim()).may_execute, !committed);
			if (operation === "edit" && committed) assert.throws(() => restarted.claimExecution(claim()), rejects("owner_review_approval_required"));
			assert.ok(readdirSync(directory).every((name) => !name.endsWith(".tmp") && name !== "writer.lock"));
		});
	}
	test(`immutable media: ${failure} cannot leave a reviewable partial revision`, (t) => {
		const directory = join(temporary(t), "reviews");
		const fault = faultFiles(failure, "blob");
		const store = new OwnerReviewStore(directory, fault.files);
		fault.arm();
		assert.throws(() => store.put(put()), rejects("owner_review_durability_uncertain"));
		const restarted = new OwnerReviewStore(directory);
		assert.throws(() => restarted.get(binding, itemID), rejects("owner_review_not_found"));
		assert.equal(restarted.put(put()).work_item.state, "pending_review");
	});
}

test("protected files, corrupt/missing metadata and media, symlinks, and concurrent writer lock fail closed", (t) => {
	const directory = join(temporary(t), "reviews");
	const store = new OwnerReviewStore(directory);
	store.put(put());
	for (const name of readdirSync(directory)) assert.equal(statSync(join(directory, name)).mode & 0o077, 0);
	assert.equal(statSync(directory).mode & 0o077, 0);
	writeFileSync(join(directory, "writer.lock"), "synthetic abandoned writer", { mode: 0o600 });
	assert.throws(() => store.decide(binding, itemID, approval(), "approved"), rejects("owner_review_store_busy"));
	rmSync(join(directory, "writer.lock"));
	store.decide(binding, itemID, approval(), "approved");
	const blob = join(directory, `${fixture.artifact.media_sha256}.blob`);
	writeFileSync(blob, "corrupt");
	assert.throws(() => store.get(binding, itemID), rejects("owner_review_media_unavailable"));
	assert.throws(() => store.decide(binding, itemID, approval(), "approved"), rejects("owner_review_media_unavailable"));
	assert.throws(() => store.claimExecution(claim()), rejects("owner_review_media_unavailable"));
	rmSync(blob);
	symlinkSync(join(directory, "reviews.json"), blob);
	assert.throws(() => store.media(binding, itemID, "revision-one"), rejects("owner_review_media_unavailable"));
	rmSync(blob);
	writeFileSync(blob, Buffer.from(fixture.media_base64, "base64"), { mode: 0o600 });
	const path = join(directory, "reviews.json");
	const original = readFileSync(path);
	writeFileSync(path, "{broken");
	assert.throws(() => new OwnerReviewStore(directory), rejects("owner_review_store_unreadable"));
	const invalid = JSON.parse(original.toString()); invalid.items[0].revisions[0].text = "substituted";
	writeFileSync(path, JSON.stringify(invalid));
	assert.throws(() => store.claimExecution(claim()), rejects("owner_review_store_unreadable"));
	rmSync(path);
	assert.throws(() => new OwnerReviewStore(directory), rejects("owner_review_store_unreadable"));
});

async function harness(t: TestContext, files: Partial<OwnerReviewFileOperations> = {}) {
	const root = temporary(t);
	const directory = join(root, "reviews");
	const review = new OwnerReviewStore(directory, files);
	let grantClock = Date.now();
	const grants = new DeviceGrantStore(join(root, "device-grants.json"), { now: () => new Date(grantClock) });
	let subject = binding.subject_agent_id;
	let statusCode = 200;
	let statusHook: (() => void) | undefined;
	const forwarded: string[] = [];
	const upstream = createServer((req, res) => {
		if (req.method !== "GET" || !req.url?.endsWith("/status")) forwarded.push(`${req.method} ${req.url}`);
		statusHook?.(); statusHook = undefined;
		res.writeHead(statusCode, { "content-type": "application/json" }); res.end(JSON.stringify({ agent_id: subject }));
	});
	const upstreamPort = await listen(upstream);
	const facade = new ConsoleAccessFacade({ ownerToken, ownerPushProducerToken: producerToken, ownerReview: review,
		upstreamBaseURL: new URL(`http://127.0.0.1:${upstreamPort}`), allowedAgentRoutes: ["current", "other-route"], grantStore: grants });
	const port = await facade.start(0);
	t.after(async () => { await facade.stop(); await close(upstream); });
	const base = `http://127.0.0.1:${port}`;
	const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
	let counter = 0;
	async function enroll(scopes: DeviceGrantScope[] = ["owner_review"], bindingID = binding.binding_id) {
		const jwk = keys.publicKey.export({ format: "jwk" });
		const unsigned = { version: 1 as const, binding_id: bindingID, subject_agent_id: binding.subject_agent_id, surface: "iphone" as const,
			public_key: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64"),
			nonce: `enrollment-example-${++counter}`, scopes };
		const request: DeviceGrantEnrollmentRequest = { ...unsigned, signature: sign("sha256", Buffer.from(canonicalDeviceEnrollment("current", unsigned)), keys.privateKey).toString("base64") };
		const response = await fetch(base + "/api/v2/agents/current/device-grants", { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify(request) });
		assert.equal(response.status, 201, await response.clone().text());
		return await response.json() as DeviceGrantDescriptor;
	}
	function signed(grant: DeviceGrantDescriptor, method: string, path: string, body: string = "", timestamp = String(Math.floor(Date.now() / 1000))) {
		const nonce = `request-example-${++counter}`;
		const contentType = method === "POST" ? "application/json" : "";
		const input = { method, pathAndQuery: path, timestamp, nonce, contentType, bodyDigest: sha256Hex(Buffer.from(body)), subjectAgentId: grant.subject_agent_id };
		return { authorization: `DeviceGrant ${grant.grant_id}`, "x-troublemaker-device-timestamp": timestamp,
			"x-troublemaker-device-nonce": nonce, "x-troublemaker-device-body-sha256": input.bodyDigest,
			"x-troublemaker-device-subject": grant.subject_agent_id,
			"x-troublemaker-device-signature": sign("sha256", Buffer.from(canonicalDeviceRequest(input)), keys.privateKey).toString("base64"),
			...(contentType ? { "content-type": contentType } : {}) };
	}
	async function device(grant: DeviceGrantDescriptor, path = itemPath, value?: unknown) {
		const method = value === undefined ? "GET" : "POST";
		const body = value === undefined ? "" : JSON.stringify(value);
		return fetch(base + path, { method, headers: signed(grant, method, path, body), ...(method === "POST" ? { body } : {}) });
	}
	async function producer(path: string, value: unknown, token = producerToken) {
		return fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) });
	}
	return { root, directory, review, grants, base, enroll, signed, device, producer, forwarded,
		advanceGrantClock: () => { grantClock += 366 * 86400 * 1000; },
		setSubject: (value: string) => { subject = value; }, failStatus: () => { statusCode = 503; },
		onStatus: (hook: () => void) => { statusHook = hook; } };
}

test("real authenticated HTTP route: private fetch/media, scope and binding, signed approval, edits and execution custody", async (t) => {
	const h = await harness(t);
	const grant = await h.enroll();
	const wrongBinding = await h.enroll(["owner_review"], "binding-other");
	const noScope = await h.enroll(["status"]);
	assert.equal((await h.producer(producerPaths.put, put(), ownerToken)).status, 401);
	assert.equal((await h.producer(producerPaths.put, put())).status, 200);
	assert.equal((await fetch(h.base + itemPath)).status, 401);
	assert.equal((await fetch(h.base + itemPath, { headers: { authorization: `Bearer ${ownerToken}` } })).status, 403);
	assert.equal((await h.device(noScope)).status, 403);
	assert.equal((await h.device(wrongBinding)).status, 404);
	assert.equal((await h.device(wrongBinding, itemPath + "/approvals", approval())).status, 404);
	const view = await h.device(grant);
	assert.equal(view.status, 200); assert.equal(view.headers.get("cache-control"), "no-store");
	assert.deepEqual((await view.json()).artifact, fixture.artifact);
	const mediaPath = itemPath + "/revisions/revision-one/media";
	const media = await h.device(grant, mediaPath);
	assert.equal(media.status, 200); assert.equal(media.headers.get("cache-control"), "no-store");
	assert.equal(media.headers.get("x-content-type-options"), "nosniff");
	assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.from(fixture.media_base64, "base64"));
	assert.equal((await h.device(wrongBinding, mediaPath)).status, 404);
	for (const path of [itemPath + "/approvals/extra", itemPath + "/execute", itemPath.replace(itemID, "%2e%2e%2fprivate"), itemPath.replace("current", "unlisted")]) assert.equal((await h.device(grant, path)).status, 404);
	assert.equal((await h.device(grant, itemPath + "?account_id=account-other")).status, 400);
	assert.equal((await h.device(grant, itemPath.replace("current", "other-route"))).status, 403);
	const stale = h.signed(grant, "GET", itemPath, "", "1");
	assert.equal((await fetch(h.base + itemPath, { headers: stale })).status, 401);
	const oversizedBody = JSON.stringify(approval()) + " ".repeat(4096);
	assert.equal((await fetch(h.base + itemPath + "/approvals", { method: "POST", headers: h.signed(grant, "POST", itemPath + "/approvals", oversizedBody), body: oversizedBody })).status, 413);
	const signedBody = JSON.stringify(approval());
	const headers = h.signed(grant, "POST", itemPath + "/approvals", signedBody);
	assert.equal((await fetch(h.base + itemPath + "/approvals", { method: "POST", headers, body: JSON.stringify(approval(put(), "tampered")) })).status, 401);
	assert.equal((await fetch(h.base + itemPath + "/rejections", { method: "POST", headers, body: signedBody })).status, 401);
	const response = await fetch(h.base + itemPath + "/approvals", { method: "POST", headers, body: signedBody });
	assert.equal(response.status, 200); assert.equal((await response.json()).work_item.state, "approved");
	assert.equal((await fetch(h.base + itemPath + "/approvals", { method: "POST", headers, body: signedBody })).status, 409);
	assert.equal((await (await h.device(grant, itemPath + "/approvals", approval())).json()).disposition, "duplicate");
	assert.equal((await h.device(grant, itemPath + "/approvals", { ...approval(), account_id: "account-other" })).status, 400);
	assert.equal((await h.producer(producerPaths.put, put("revision-two", "edited draft"))).status, 200);
	assert.equal((await h.device(grant, itemPath + "/approvals", approval(put(), "stale-approval"))).status, 409);
	assert.equal((await h.producer(producerPaths.claim, claim())).status, 409);
	const next = approval(put("revision-two", "edited draft"), "approval-two");
	assert.equal((await h.device(grant, itemPath + "/rejections", next)).status, 200);
	assert.equal((await h.producer(producerPaths.claim, claim(next))).status, 409);
	const yes = { ...next, approval_id: "approval-three" };
	assert.equal((await h.device(grant, itemPath + "/approvals", yes)).status, 200);
	assert.equal((await h.producer(producerPaths.claim, claim(yes), ownerToken)).status, 401);
	assert.equal((await (await h.producer(producerPaths.claim, claim(yes))).json()).may_execute, true);
	assert.equal((await (await h.producer(producerPaths.claim, claim(yes))).json()).may_execute, false);
	assert.equal((await h.producer(producerPaths.put, { ...put("revision-three"), expected_revision_id: "revision-two" })).status, 409);
	const outcome = { ...reconciliation(), artifact_approval_digest: yes.artifact_approval_digest };
	assert.equal((await h.producer(producerPaths.reconcile, outcome, ownerToken)).status, 401);
	assert.equal((await h.producer(producerPaths.reconcile, outcome)).status, 200);
	assert.equal((await (await h.producer(producerPaths.reconcile, outcome)).json()).disposition, "duplicate");
	assert.deepEqual(h.forwarded, [], "review never forwards a runtime message or a public action");
	h.setSubject("agent-other");
	assert.equal((await h.device(grant)).status, 409);
	assert.equal((await h.producer(producerPaths.put, put())).status, 409);
	h.setSubject(binding.subject_agent_id);
	h.onStatus(() => h.grants.revoke("current", grant.grant_id));
	assert.equal((await h.device(grant)).status, 401, "revocation while awaiting status wins");
	assert.equal((await h.device(grant)).status, 401);
	h.failStatus();
	assert.equal((await h.device(wrongBinding)).status, 502);
});

test("real HTTP persistence failures: nonce write fails before approval; lost claim response cannot re-execute", async (t) => {
	const fault = faultFiles("rename-after");
	const h = await harness(t, fault.files);
	const grant = await h.enroll();
	assert.equal((await h.producer(producerPaths.put, put())).status, 200);
	const grantPath = join(h.root, "device-grants.json");
	renameSync(grantPath, grantPath + ".saved"); mkdirSync(grantPath, { mode: 0o700 });
	assert.equal((await h.device(grant, itemPath + "/approvals", approval())).status, 500);
	assert.equal(h.review.get(binding, itemID).state, "pending_review");
	rmSync(grantPath, { recursive: true }); renameSync(grantPath + ".saved", grantPath);
	assert.equal((await h.device(grant, itemPath + "/approvals", approval())).status, 200);
	fault.arm();
	assert.equal((await h.producer(producerPaths.claim, claim())).status, 503);
	const reopened = new OwnerReviewStore(h.directory);
	assert.equal(reopened.get(binding, itemID).state, "uncertain");
	assert.equal(reopened.claimExecution(claim()).may_execute, false);
	assert.deepEqual(h.forwarded, []);
});

test("real HTTP failed approval sync returns 503, and expiry during authorization cannot approve", async (t) => {
	const fault = faultFiles("file-sync");
	const h = await harness(t, fault.files);
	const grant = await h.enroll();
	assert.equal((await h.producer(producerPaths.put, put())).status, 200);
	h.onStatus(h.advanceGrantClock);
	assert.equal((await h.device(grant, itemPath + "/approvals", approval())).status, 401);
	assert.equal(h.review.get(binding, itemID).state, "pending_review");
	const fresh = await h.enroll();
	// The new grant's clock is advanced; use a matching signed request timestamp.
	const body = JSON.stringify(approval());
	const timestamp = String(Math.floor(Date.parse(fresh.created_at) / 1000));
	fault.arm();
	const response = await fetch(h.base + itemPath + "/approvals", { method: "POST", body, headers: h.signed(fresh, "POST", itemPath + "/approvals", body, timestamp) });
	assert.equal(response.status, 503);
	const reopened = new OwnerReviewStore(h.directory);
	assert.equal(reopened.get(binding, itemID).state, "pending_review");
	assert.throws(() => reopened.claimExecution(claim()), rejects("owner_review_approval_required"));
	assert.deepEqual(h.forwarded, []);
});

test("scope allowlist exposes only review fetch, media, and explicit decisions", () => {
	for (const [method, path] of [["GET", itemPath], ["GET", itemPath + "/revisions/revision-one/media"], ["POST", itemPath + "/approvals"], ["POST", itemPath + "/rejections"]]) assert.equal(deviceRequestScope(method, path), "owner_review");
	for (const [method, path] of [["POST", itemPath], ["GET", itemPath + "/approvals"], ["POST", itemPath + "/execute"], ["POST", producerPaths.claim], ["DELETE", itemPath]]) assert.equal(deviceRequestScope(method, path), null);
});

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
