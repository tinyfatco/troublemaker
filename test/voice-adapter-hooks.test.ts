import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { RealtimeVoiceCanonicalAdapter, RealtimeVoiceSession } from "../src/adapters/realtime-voice.js";
import type { MomEvent, MomHandler } from "../src/adapters/types.js";
import { VoiceAdapter } from "../src/adapters/voice.js";
import { WebVoiceBridgeAdapter } from "../src/adapters/web-voice.js";

const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const committed: MomEvent = {
	type: "dm",
	channel: "voice-example",
	ts: "1000",
	user: "voice-user-example",
	text: "committed words",
	sessionId: SESSION_ID,
};

function fakeSocket() {
	const sent: unknown[] = [];
	const socket = {
		readyState: WebSocket.OPEN,
		send(value: unknown) { sent.push(value); },
		close() {},
		on() {},
	};
	return { socket: socket as unknown as WebSocket, sent };
}

const workingDir = mkdtempSync(join(tmpdir(), "tm-voice-hooks-"));
try {
	const telephony = new VoiceAdapter({
		workingDir,
		elevenlabsApiKey: "test-api-key",
		elevenlabsVoiceId: "test-voice-id",
	});
	const telephonySocket = fakeSocket();
	(telephony as any).calls.set(SESSION_ID, {
		streamSid: "stream-example",
		from: "+15550100000",
		callSid: SESSION_ID,
		ws: telephonySocket.socket,
		sttSession: null,
		ttsPlaying: true,
		voiceOpen: true,
		audioGeneration: 4,
		assistantSpeechId: null,
		startedAt: Date.now(),
	});
	telephony.interruptOutputAudio(committed);
	const telephonyClear = JSON.parse(String(telephonySocket.sent.at(-1)));
	assert.deepEqual(telephonyClear, { event: "clear", streamSid: "stream-example" });
	assert.equal((telephony as any).calls.get(SESSION_ID).audioGeneration, 5, "telephony invalidates streaming TTS immediately");

	const web = new WebVoiceBridgeAdapter(workingDir);
	const webSocket = fakeSocket();
	web.setActiveSession(webSocket.socket, {
		apiKey: "test-api-key",
		voiceId: "test-voice-id",
		outputFormat: "mp3_44100",
	}, SESSION_ID);
	web.interruptOutputAudio(committed);
	assert.deepEqual(JSON.parse(String(webSocket.sent.at(-1))), { type: "interrupt_audio" });

	const handler = {
		isRunning: () => false,
		handleEvent: async () => {},
		handleSlashCommand: async () => false,
		handleSteer: () => {},
		handleStop: async () => {},
		resolvePendingInput: () => false,
	} satisfies MomHandler;
	const realtimeSocket = fakeSocket();
	const realtimeSession = new RealtimeVoiceSession(realtimeSocket.socket, { workingDir, handler });
	const realtime = new RealtimeVoiceCanonicalAdapter(realtimeSession, workingDir);
	realtime.interruptOutputAudio(committed);
	assert.deepEqual(JSON.parse(String(realtimeSocket.sent.at(-1))), { type: "interrupt_audio" });

	for (const file of ["src/adapters/voice.ts", "src/adapters/web-voice.ts", "src/adapters/realtime-voice.ts"]) {
		const source = readFileSync(file, "utf8");
		assert.match(source, /handleVoiceEvent/, `${file} submits committed transcripts to the central voice contract`);
		assert.doesNotMatch(source, /handleSteer\(event, this(?:\.adapter)?\)/, `${file} never steers a committed voice transcript`);
	}
	const webClient = readFileSync("ui/src/hooks/useVoiceChat.ts", "utf8");
	const macClient = readFileSync("mac/TroublemakerMac/MacVoiceSession.swift", "utf8");
	assert.match(webClient, /type === 'interrupt_audio'[\s\S]*?interruptTurnAudio\(\)/, "browser playback honors the web voice interruption hook");
	assert.match(macClient, /case "interrupt_audio":\s*callbacks\?\.interruptAudio\(\)/, "Mac playback honors adapter audio interruption");

	const agentsTemplate = readFileSync("src/templates/AGENTS.md", "utf8");
	assert.match(agentsTemplate, /Voice barge-in stops assistant audio immediately/);
	assert.match(agentsTemplate, /wait FIFO/);
	assert.match(agentsTemplate, /non-voice messages keep the platform's normal hard-interrupt behavior/);
	assert.match(agentsTemplate, /never auto-run SAG/);
	const repositoryGuidance = readFileSync("AGENTS.md", "utf8");
	assert.match(repositoryGuidance, /initial `hey <agent name>` wake phrase/);
	assert.match(repositoryGuidance, /Queue voice follow-ups FIFO/);
	assert.match(repositoryGuidance, /never spoken automatically/);
	const agentRunner = readFileSync("src/agent.ts", "utf8");
	assert.doesNotMatch(agentRunner, /speakConfiguredText|speak\.auto|automatic.*SAG/i, "ordinary final responses do not restore automatic speech");

	console.log("voice adapter interruption hooks ok");
} finally {
	rmSync(workingDir, { recursive: true, force: true });
}
