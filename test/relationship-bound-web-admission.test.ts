import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAdapter } from "../src/adapters/web.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import type { RelationshipAdmissionResult } from "../src/relationship-bound-admission.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

interface MockResponse {
	statusCode?: number;
	body: string;
	ended: boolean;
	writeHead(statusCode: number): void;
	write(chunk: string): void;
	end(chunk?: string): void;
	flushHeaders(): void;
}

function beginRequest(adapter: WebAdapter, payload: Record<string, unknown>, relationship?: string) {
	let finish!: (response: MockResponse) => void;
	const finished = new Promise<MockResponse>((resolve) => { finish = resolve; });
	const response: MockResponse = {
		body: "", ended: false,
		writeHead(statusCode) { this.statusCode = statusCode; },
		write(chunk) { this.body += chunk; },
		end(chunk) { if (chunk) this.body += chunk; this.ended = true; finish(this); },
		flushHeaders() {},
	};
	const request = new EventEmitter() as EventEmitter & { headers: Record<string, string> };
	request.headers = {
		"content-type": "application/json",
		...(relationship ? { "x-troublemaker-verified-device-relationship": relationship } : {}),
	};
	adapter.dispatch(request as never, response as never);
	request.emit("data", Buffer.from(JSON.stringify(payload)));
	request.emit("end");
	return { response, finished };
}

function handler(route: (event: MomEvent) => RelationshipAdmissionResult): MomHandler {
	return {
		isRunning: () => false,
		handleEvent: async () => assert.fail("bound admission must not use ordinary event fallback"),
		handleSlashCommand: async () => false,
		handleRelationshipBoundEvent: (event) => route(event),
		handleSteer: () => assert.fail("bound admission must not use steer-or-queue fallback"),
		handleStop: async () => {},
		resolvePendingInput: () => false,
	};
}

const relationshipId = "relationship-example-0001";
const payload = {
	message: "Exact relationship input",
	channelId: "origin-channel-example",
	deliveryId: "delivery-example-0001",
	relationshipRoute: {
		relationshipID: relationshipId,
		activeChannelID: "paired-channel-example",
		policy: "strict_active_or_idle_turn",
	},
};

{
	const accepted = deferred();
	const completed = deferred();
	let routed = 0;
	const adapter = new WebAdapter({ workingDir: mkdtempSync(join(tmpdir(), "bound-web-steer-")) });
	adapter.setHandler(handler((event) => {
		routed++;
		assert.equal(event.relationshipId, relationshipId);
		return {
			disposition: "steered",
			run: { runId: "run-example-0001", relationshipId, channelId: "paired-channel-example" },
			accepted: accepted.promise,
			completed: completed.promise,
		};
	}));
	const request = beginRequest(adapter, payload, relationshipId);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(routed, 1);
	assert.doesNotMatch(request.response.body, /"disposition":"accepted"/, "pending reservation is not optimistic success");
	accepted.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(request.response.body, /"disposition":"accepted"/);
	assert.doesNotMatch(request.response.body, /"disposition":"completed"/);
	completed.resolve();
	const response = await request.finished;
	assert.match(response.body, /"disposition":"completed"/);
}

{
	const accepted = deferred();
	const completed = deferred();
	let routed = 0;
	const workingDir = mkdtempSync(join(tmpdir(), "bound-web-duplicate-"));
	const adapter = new WebAdapter({ workingDir });
	adapter.setHandler(handler(() => {
		routed++;
		return {
			disposition: "steered",
			run: { runId: "run-example-0002", relationshipId, channelId: "paired-channel-example" },
			accepted: accepted.promise,
			completed: completed.promise,
		};
	}));
	const first = beginRequest(adapter, payload, relationshipId);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const duplicate = await beginRequest(adapter, payload, relationshipId).finished;
	assert.equal(routed, 1, "pending identity routes exactly once");
	assert.match(duplicate.body, /"state":"pending"/);
	assert.doesNotMatch(duplicate.body, /"state":"accepted"/);
	accepted.resolve();
	completed.resolve();
	await first.finished;
}

{
	let routed = 0;
	const adapter = new WebAdapter({ workingDir: mkdtempSync(join(tmpdir(), "bound-web-mismatch-")) });
	adapter.setHandler(handler(() => {
		routed++;
		return { disposition: "rejected", reason: "relationship_mismatch" };
	}));
	const mismatch = await beginRequest(adapter, payload, "relationship-example-0002").finished;
	assert.equal(routed, 0, "verified relationship mismatch fails before runtime routing");
	assert.match(mismatch.body, /"state":"rejected"/);
	assert.match(mismatch.body, /"reason":"relationship_mismatch"/);
	const replay = await beginRequest(adapter, payload, "relationship-example-0002").finished;
	assert.match(replay.body, /"state":"rejected"/, "terminal rejection survives exact replay");
	assert.equal(routed, 0);
}

{
	const completed = deferred();
	const adapter = new WebAdapter({ workingDir: mkdtempSync(join(tmpdir(), "bound-web-idle-")) });
	adapter.setHandler(handler(() => ({
		disposition: "new_turn",
		accepted: Promise.resolve(),
		completed: completed.promise,
	})));
	const request = beginRequest(adapter, { ...payload, deliveryId: "delivery-example-idle" }, relationshipId);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.match(request.response.body, /"state":"accepted"/, "true-idle admission is authoritative acceptance");
	completed.resolve();
	await request.finished;
}

console.log("relationship-bound web admission tests passed");
