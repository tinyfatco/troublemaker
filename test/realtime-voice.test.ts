import assert from "node:assert/strict";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
	createRealtimeFunctionTools,
	createRealtimeSessionUpdate,
	createRealtimeVoiceInstructions,
	formatRealtimeToolResult,
} from "../src/adapters/realtime-voice.js";

const bashTool = {
	name: "bash",
	label: "bash",
	description: "Run a command.",
	parameters: Type.Object({
		label: Type.String(),
		command: Type.String(),
	}),
	execute: async () => ({
		content: [{ type: "text" as const, text: "ok" }],
		details: undefined,
	}),
} satisfies AgentTool<any>;

const speakTool = {
	...bashTool,
	name: "speak",
	label: "speak",
	description: "Legacy speech tool.",
} satisfies AgentTool<any>;

const instructions = createRealtimeVoiceInstructions();
assert.match(instructions, /You are Zip\b/, "Realtime voice identity is Zip");
assert.doesNotMatch(instructions, /agentName|generic/i, "Realtime prompt does not expose generic agent identity");

const functionTools = createRealtimeFunctionTools([bashTool, speakTool]);
assert.equal(functionTools.length, 1, "Realtime tool list excludes legacy speak");
assert.equal(functionTools[0]?.name, "bash", "Realtime function tools preserve host tool names");
assert.deepEqual((functionTools[0]?.parameters as any).required, ["label", "command"], "Realtime tools preserve JSON schema");

const update = createRealtimeSessionUpdate({ voice: "marin", tools: [bashTool, speakTool] }) as any;
assert.equal(update.session.model, "gpt-realtime-2", "Realtime bridge uses gpt-realtime-2");
assert.equal(update.session.audio.input.transcription.model, "gpt-realtime-whisper", "Realtime session keeps Whisper as input transcription model");
assert.equal(update.session.audio.input.turn_detection.create_response, false, "Node bridge owns response creation");
assert.equal(update.session.audio.input.turn_detection.interrupt_response, false, "Node bridge owns interruption");
assert.equal(update.session.audio.input.turn_detection.threshold, 0.6, "Realtime VAD threshold is stable");
assert.equal(update.session.audio.output.voice, "marin", "Realtime voice remains configurable");
assert.equal(update.session.tools.length, 1, "Session tools exclude speak");

const resultText = formatRealtimeToolResult({
	content: [
		{ type: "text", text: "hello" },
		{ type: "image", data: "abc", mimeType: "image/png" },
	],
	details: { ok: true },
});
assert.match(resultText, /hello/, "Tool result includes text content");
assert.match(resultText, /image png|image\/png/, "Tool result mentions omitted images");
assert.match(resultText, /"ok":true/, "Tool result includes compact details");

console.log("realtime voice bridge tests passed");
