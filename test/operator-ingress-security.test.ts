import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorAdapter } from "../src/adapters/operator.js";
import { currentHostDeliveryScope } from "../src/adapters/host-delivery-scope.js";

async function request(adapter: OperatorAdapter, init: RequestInit = {}, path = "/operator/read"): Promise<Response> {
	const server = createServer((incoming, outgoing) => adapter.dispatch(incoming, outgoing));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
		return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-operator-auth-"));
const receiptStatuses: string[] = [];
const receiptServer = createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) body += chunk;
	receiptStatuses.push(String(JSON.parse(body).status));
	res.writeHead(200, { "content-type": "application/json" });
	res.end('{"ok":true}');
});
try {
	await new Promise<void>((resolve) => receiptServer.listen(0, "127.0.0.1", resolve));
	const receiptAddress = receiptServer.address();
	if (!receiptAddress || typeof receiptAddress === "string") throw new Error("receipt server did not bind TCP");
	const hostdUrl = `http://127.0.0.1:${receiptAddress.port}`;
	mkdirSync(join(workingDir, "awareness"));
	const disabled = new OperatorAdapter({ workingDir });
	assert.equal((await request(disabled)).status, 503);

	const token = "operator-inbound-token-example-32-bytes";
	const adapter = new OperatorAdapter({ workingDir, inboundToken: token });
	assert.equal((await request(adapter)).status, 401);
	assert.equal((await request(adapter, {
		headers: { "x-crawdad-dev-verified": "true" },
	})).status, 401);
	assert.equal((await request(adapter, {
		headers: { authorization: token },
	})).status, 401);
	const authorized = await request(adapter, {
		headers: { authorization: `Bearer ${token}` },
	});
	assert.equal(authorized.status, 200);
	assert.deepEqual(await authorized.json(), { lines: [], total: 0, offset: 0 });

	const relationshipToken = "relationship-operator-token-example-32-bytes";
	const relationshipScope = {
		relationshipId: "00000000-0000-4000-8000-000000000010",
		generation: 1,
		source: "phone",
		recipientHint: "ending 0123",
		replyTarget: "phone-0123456789abcdef0123",
	};
	const scopeMissingAdapter = new OperatorAdapter({
		workingDir,
		relationshipInboundToken: relationshipToken,
		hostContextId: "front-desk:principal:intake",
		hostdUrl,
	});
	assert.equal((await request(scopeMissingAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: "{}",
	}, "/operator/relationship-message")).status, 503, "relationship ingress fails closed without Hostd scope");
	const relationshipAdapter = new OperatorAdapter({
		workingDir,
		relationshipInboundToken: relationshipToken,
		relationshipScope,
		hostContextId: "front-desk:principal:intake",
		hostdUrl,
	});
	let handled = 0;
	let handledEvent: any;
	let handledDeliveryScope: ReturnType<typeof currentHostDeliveryScope>;
	relationshipAdapter.setHandler({
		isRunning: () => false,
		handleEvent: async (event: any) => {
			handled += 1;
			handledEvent = event;
			handledDeliveryScope = currentHostDeliveryScope();
		},
	} as any);
	assert.equal((await request(relationshipAdapter, {
		headers: { authorization: `Bearer ${relationshipToken}` },
	})).status, 503, "relationship capability cannot read the full Operator API");
	assert.equal((await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({}),
	}, "/operator/relationship-message")).status, 401, "full Operator token is not interchangeable");
	assert.equal((await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			text: "bounded instruction",
			deliveryId: "00000000-0000-4000-8000-000000000001",
			hostContextId: "another:principal:intake",
			relationshipScope,
		}),
	}, "/operator/relationship-message")).status, 400, "cross-context delivery is denied");
	const deliveryId = "00000000-0000-4000-8000-000000000001";
	const hostReceipt = {
		url: `${hostdUrl}/v1/events/${deliveryId}/receipt`,
		token: "a".repeat(43),
		leaseToken: "00000000-0000-4000-8000-000000000002",
	};
	assert.equal((await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			text: "bounded instruction",
			deliveryId,
			hostContextId: "front-desk:principal:intake",
			relationshipScope,
			hostReceipt: { ...hostReceipt, url: "http://example.com/receipt" },
		}),
	}, "/operator/relationship-message")).status, 400, "receipt callbacks are pinned to Hostd");
	assert.equal((await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			text: "bounded instruction",
			deliveryId,
			hostContextId: "front-desk:principal:intake",
			relationshipScope: {
				...relationshipScope,
				replyTarget: "phone-fedcba98765432100123",
			},
			hostReceipt,
		}),
	}, "/operator/relationship-message")).status, 400, "relationship target substitution is denied");
	assert.equal((await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			text: "bounded instruction",
			deliveryId,
			hostContextId: "front-desk:principal:intake",
			relationshipScope,
			hostReceipt,
		}),
	}, "/operator/relationship-message")).status, 202);
	for (let attempt = 0; handled === 0 && attempt < 50; attempt += 1) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.equal(handled, 1);
	assert.equal(handledEvent.sourceEventType, "hostd:mcp-relationship-message");
	assert.equal(handledEvent.replyTarget, relationshipScope.replyTarget);
	assert.equal(handledEvent.replyTargetDescription, "Hostd-verified phone relationship ending 0123");
	assert.deepEqual(handledEvent.hostRelationship, relationshipScope);
	assert.deepEqual(handledDeliveryScope, {
		source: "mcp-operator",
		eventId: deliveryId,
		replyTarget: relationshipScope.replyTarget,
	});
	const relationshipContext = relationshipAdapter.createContext(handledEvent, {} as any, true);
	assert.equal(relationshipContext.message.sourceEventType, "hostd:mcp-relationship-message");
	assert.equal(relationshipContext.message.directlyAddressed, true);
	assert.equal(relationshipContext.message.replyTarget, relationshipScope.replyTarget);
	assert.equal(relationshipContext.message.replyTargetDescription, "Hostd-verified phone relationship ending 0123");
	assert.deepEqual(relationshipContext.message.hostRelationship, relationshipScope);
	assert.deepEqual(receiptStatuses, ["running", "completed"]);

	const inFlightDeliveryId = "00000000-0000-4000-8000-000000000004";
	let releaseInFlight!: () => void;
	let noteInFlightStarted!: () => void;
	const inFlightStarted = new Promise<void>((resolve) => { noteInFlightStarted = resolve; });
	const inFlightRelease = new Promise<void>((resolve) => { releaseInFlight = resolve; });
	let inFlightHandled = 0;
	relationshipAdapter.setHandler({
		isRunning: () => false,
		handleEvent: async () => {
			inFlightHandled += 1;
			noteInFlightStarted();
			await inFlightRelease;
		},
	} as any);
	const inFlightBody = JSON.stringify({
		text: "bounded instruction",
		deliveryId: inFlightDeliveryId,
		hostContextId: "front-desk:principal:intake",
		relationshipScope,
		hostReceipt: {
			...hostReceipt,
			url: `${hostdUrl}/v1/events/${inFlightDeliveryId}/receipt`,
		},
	});
	assert.equal((await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: inFlightBody,
	}, "/operator/relationship-message")).status, 202);
	await inFlightStarted;
	const duplicateInFlight = await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: inFlightBody,
	}, "/operator/relationship-message");
	assert.equal(duplicateInFlight.status, 202);
	assert.equal((await duplicateInFlight.json() as { duplicate?: boolean }).duplicate, true);
	releaseInFlight();
	for (let attempt = 0; receiptStatuses.length < 4 && attempt < 50; attempt += 1) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.equal(inFlightHandled, 1);
	assert.deepEqual(receiptStatuses, ["running", "completed", "running", "completed"]);

	const uncertainDeliveryId = "00000000-0000-4000-8000-000000000003";
	relationshipAdapter.setHandler({
		isRunning: () => false,
		handleEvent: async () => { throw new Error("ambiguous post-running failure"); },
	} as any);
	assert.equal((await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			text: "bounded instruction",
			deliveryId: uncertainDeliveryId,
			hostContextId: "front-desk:principal:intake",
			relationshipScope,
			hostReceipt: {
				...hostReceipt,
				url: `${hostdUrl}/v1/events/${uncertainDeliveryId}/receipt`,
			},
		}),
	}, "/operator/relationship-message")).status, 202);
	for (let attempt = 0; receiptStatuses.length < 6 && attempt < 50; attempt += 1) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.deepEqual(receiptStatuses, [
		"running",
		"completed",
		"running",
		"completed",
		"running",
		"uncertain",
	]);

	const failedResultDeliveryId = "00000000-0000-4000-8000-000000000005";
	relationshipAdapter.setHandler({
		isRunning: () => false,
		handleEvent: async () => ({
			stopReason: "error",
			errorMessage: "model credential unavailable",
		}),
	} as any);
	assert.equal((await request(relationshipAdapter, {
		method: "POST",
		headers: {
			authorization: `Bearer ${relationshipToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			text: "bounded instruction",
			deliveryId: failedResultDeliveryId,
			hostContextId: "front-desk:principal:intake",
			relationshipScope,
			hostReceipt: {
				...hostReceipt,
				url: `${hostdUrl}/v1/events/${failedResultDeliveryId}/receipt`,
			},
		}),
	}, "/operator/relationship-message")).status, 202);
	for (let attempt = 0; receiptStatuses.length < 8 && attempt < 50; attempt += 1) {
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	assert.deepEqual(receiptStatuses.slice(-2), ["running", "uncertain"]);
	assert.equal(
		readFileSync(join(workingDir, "awareness", "relationship-operator-deliveries.jsonl"), "utf8")
			.split("\n")
			.includes(failedResultDeliveryId),
		false,
		"failed relationship turns must remain replayable rather than being recorded complete",
	);
} finally {
	await new Promise<void>((resolve, reject) => receiptServer.close((error) => error ? reject(error) : resolve()));
	rmSync(workingDir, { recursive: true, force: true });
}

console.log("operator ingress security ok");
