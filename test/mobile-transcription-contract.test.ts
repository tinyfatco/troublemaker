import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleTranscriptionRequest, ConsoleTranscriptionService } from "../src/console/transcription.js";
import { ConsoleTranscriptionError } from "../src/console/transcription.js";
import { Gateway } from "../src/gateway.js";
import { DeepgramConsoleTranscriptionService } from "../src/host/node/deepgram-transcription.js";
import { createDeepgramConsoleTranscriptionService } from "../src/host/node/deepgram-transcription.js";
import { readProtectedPlistString } from "../src/host/node/protected-plist-string.js";

const workspace = mkdtempSync(join(tmpdir(), "troublemaker-transcription-contract-"));
try {
	mkdirSync(join(workspace, "awareness"), { recursive: true });
	writeFileSync(join(workspace, "settings.json"), JSON.stringify({
		name: "Example Agent",
		localAgentId: "agent-example",
	}));

	let captured: ConsoleTranscriptionRequest | undefined;
	let transcriptionCalls = 0;
	const service: ConsoleTranscriptionService = {
		async transcribe(request) {
			transcriptionCalls += 1;
			captured = request;
			return { text: "Exact fixture transcript." };
		},
	};
	const gateway = new Gateway({ workspaceDir: workspace, transcription: service });
	const port = await availablePort();
	await gateway.start(port, "127.0.0.1");
	try {
		const statusResponse = await fetch(`http://127.0.0.1:${port}/api/v2/agents/agent-example/status`);
		const status = await statusResponse.json() as { capabilities: Record<string, boolean> };
		assert.equal(status.capabilities.transcription, true);

		const audio = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
		const response = await fetch(`http://127.0.0.1:${port}/api/v2/agents/agent-example/transcriptions`, {
			method: "POST",
			headers: {
				"Content-Type": "audio/L16; rate=16000; channels=1",
				"X-Transcription-ID": "transcription-fixture-one",
			},
			body: audio,
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			transcription_id: "transcription-fixture-one",
			text: "Exact fixture transcript.",
		});
		assert.equal(captured?.id, "transcription-fixture-one");
		assert.equal(captured?.encoding, "linear16");
		assert.equal(captured?.sampleRate, 16_000);
		assert.equal(captured?.channels, 1);
		assert.deepEqual(Buffer.from(captured?.audio ?? []), audio);

		const replay = await fetch(`http://127.0.0.1:${port}/api/v2/agents/agent-example/transcriptions`, {
			method: "POST",
			headers: {
				"Content-Type": "audio/L16; rate=16000; channels=1",
				"X-Transcription-ID": "transcription-fixture-one",
			},
			body: audio,
		});
		assert.equal(replay.status, 200);
		assert.deepEqual(await replay.json(), {
			transcription_id: "transcription-fixture-one",
			text: "Exact fixture transcript.",
		});
		assert.equal(transcriptionCalls, 1, "same identity and audio replay the exact durable result");

		const conflict = await fetch(`http://127.0.0.1:${port}/api/v2/agents/agent-example/transcriptions`, {
			method: "POST",
			headers: {
				"Content-Type": "audio/L16; rate=16000; channels=1",
				"X-Transcription-ID": "transcription-fixture-one",
			},
			body: Buffer.from([9, 0, 9, 0]),
		});
		assert.equal(conflict.status, 409, "one identity cannot be reused for different audio");
		assert.equal(transcriptionCalls, 1);

		const wrongAgent = await fetch(`http://127.0.0.1:${port}/api/v2/agents/other-agent/transcriptions`, {
			method: "POST",
			body: audio,
		});
		assert.equal(wrongAgent.status, 404, "transcription remains exact-agent bound");

		const invalidID = await fetch(`http://127.0.0.1:${port}/api/v2/agents/agent-example/transcriptions`, {
			method: "POST",
			headers: { "Content-Type": "audio/L16; rate=16000; channels=1", "X-Transcription-ID": "bad id" },
			body: audio,
		});
		assert.equal(invalidID.status, 400);

		const wrongFormat = await fetch(`http://127.0.0.1:${port}/api/v2/agents/agent-example/transcriptions`, {
			method: "POST",
			headers: { "Content-Type": "audio/mpeg", "X-Transcription-ID": "transcription-fixture-two" },
			body: audio,
		});
		assert.equal(wrongFormat.status, 415);

		const oversized = await fetch(`http://127.0.0.1:${port}/api/v2/agents/agent-example/transcriptions`, {
			method: "POST",
			headers: {
				"Content-Type": "audio/L16; rate=16000; channels=1",
				"X-Transcription-ID": "transcription-fixture-three",
			},
			body: Buffer.alloc(1_920_002),
		});
		assert.equal(oversized.status, 413);
	} finally {
		await gateway.stop();
	}

	const restarted = new Gateway({ workspaceDir: workspace, transcription: service });
	const restartedPort = await availablePort();
	await restarted.start(restartedPort, "127.0.0.1");
	try {
		const audio = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
		const response = await fetch(`http://127.0.0.1:${restartedPort}/api/v2/agents/agent-example/transcriptions`, {
			method: "POST",
			headers: {
				"Content-Type": "audio/L16; rate=16000; channels=1",
				"X-Transcription-ID": "transcription-fixture-one",
			},
			body: audio,
		});
		assert.equal(response.status, 200);
		assert.equal(transcriptionCalls, 1, "durable transcription replay survives a gateway restart");
	} finally {
		await restarted.stop();
	}

	const unavailable = new Gateway({ workspaceDir: workspace });
	const unavailablePort = await availablePort();
	await unavailable.start(unavailablePort, "127.0.0.1");
	try {
		const statusResponse = await fetch(`http://127.0.0.1:${unavailablePort}/api/v2/agents/agent-example/status`);
		const status = await statusResponse.json() as { capabilities: Record<string, boolean> };
		assert.equal(status.capabilities.transcription, false);
		const response = await fetch(`http://127.0.0.1:${unavailablePort}/api/v2/agents/agent-example/transcriptions`, {
			method: "POST",
		});
		assert.equal(response.status, 503);
		assert.doesNotMatch(await response.text(), /key|token|provider/i);
	} finally {
		await unavailable.stop();
	}

	let providerAuthorization = "";
	let providerURL = "";
	const provider = new DeepgramConsoleTranscriptionService(
		"fixture-provider-secret",
		(async (input, init) => {
			providerURL = String(input);
			providerAuthorization = new Headers(init?.headers).get("authorization") || "";
			return new Response(JSON.stringify({
				results: { channels: [{ alternatives: [{ transcript: "  Provider transcript.  " }] }] },
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch,
	);
	const providerResult = await provider.transcribe({
		id: "transcription-provider-one",
		audio: Buffer.from([0, 0]),
		encoding: "linear16",
		sampleRate: 16_000,
		channels: 1,
	});
	assert.equal(providerResult.text, "Provider transcript.");
	assert.equal(providerAuthorization, "Token fixture-provider-secret");
	assert.match(providerURL, /model=nova-3/);
	assert.match(providerURL, /encoding=linear16/);
	assert.match(providerURL, /sample_rate=16000/);

	const failingProvider = new DeepgramConsoleTranscriptionService(
		"fixture-provider-secret",
		(async () => new Response("PRIVATE_PROVIDER_FAILURE", { status: 500 })) as typeof fetch,
	);
	await assert.rejects(
		failingProvider.transcribe({
			id: "transcription-provider-two",
			audio: Buffer.from([0, 0]),
			encoding: "linear16",
			sampleRate: 16_000,
			channels: 1,
		}),
		(error: unknown) => {
			assert.ok(error instanceof ConsoleTranscriptionError);
			assert.equal(error.status, 502);
			assert.doesNotMatch(error.message, /PRIVATE|fixture-provider-secret/);
			return true;
		},
	);

	const protectedPreferences = join(workspace, "protected-preferences.plist");
	writeFileSync(protectedPreferences, "fixture plist bytes", { mode: 0o600 });
	let requestedPlistPath = "";
	let requestedPlistKey = "";
	const configuredFromExistingStorage = createDeepgramConsoleTranscriptionService(
		{
			MOM_DEEPGRAM_API_KEY_PLIST_FILE: protectedPreferences,
			MOM_DEEPGRAM_API_KEY_PLIST_KEY: "apiKey_Deepgram",
		},
		fetch,
		(filePath, key) => {
			requestedPlistPath = filePath || "";
			requestedPlistKey = key || "";
			return "fixture-provider-secret";
		},
	);
	assert.ok(configuredFromExistingStorage);
	assert.equal(requestedPlistPath, protectedPreferences);
	assert.equal(requestedPlistKey, "apiKey_Deepgram");
	assert.equal(
		readProtectedPlistString(protectedPreferences, "apiKey_Deepgram", () => "  in-place-secret  \n"),
		"in-place-secret",
	);
	assert.throws(
		() => readProtectedPlistString("relative.plist", "apiKey_Deepgram", () => "secret"),
		/must be absolute/,
	);
	chmodSync(protectedPreferences, 0o640);
	assert.throws(
		() => readProtectedPlistString(protectedPreferences, "apiKey_Deepgram", () => "secret"),
		/group or others/,
	);
	chmodSync(protectedPreferences, 0o600);
	const linkedPreferences = join(workspace, "linked-preferences.plist");
	symlinkSync(protectedPreferences, linkedPreferences);
	assert.throws(
		() => readProtectedPlistString(linkedPreferences, "apiKey_Deepgram", () => "secret"),
		/symbolic link/,
	);

	console.log("mobile transcription contract tests passed");
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
