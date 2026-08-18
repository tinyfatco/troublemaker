import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	createCanonicalSpeechResponse,
	createRealtimeSessionUpdate,
	createRealtimeVoiceInstructions,
	isRealtimeControlTokenAccepted,
	realtimeSafetyIdentifier,
	resolveRealtimeAuthPlan,
} from "../src/adapters/realtime-voice.js";

const instructions = createRealtimeVoiceInstructions();
assert.match(instructions, /voice transport/i, "Realtime session is explicitly transport-only");
assert.match(instructions, /not the agent brain/i, "Realtime prompt does not pretend to be Agent's brain");
assert.doesNotMatch(instructions, /tools for reading|running bash|send_message/i, "Realtime transport prompt does not expose mini-agent tool claims");

const update = createRealtimeSessionUpdate({ voice: "marin" });
const session = objectValue(update.session);
const audio = objectValue(session.audio);
const audioInput = objectValue(audio.input);
const turnDetection = objectValue(audioInput.turn_detection);
const transcription = objectValue(audioInput.transcription);
const audioOutput = objectValue(audio.output);
assert.equal(session.model, "gpt-realtime-2", "Realtime bridge uses gpt-realtime-2");
assert.deepEqual(session.output_modalities, ["audio"], "Realtime transport outputs audio");
assert.equal(transcription.model, "gpt-realtime-whisper", "Realtime session keeps Whisper as input transcription model");
assert.equal(turnDetection.create_response, false, "Canonical runtime owns response creation");
assert.equal(turnDetection.interrupt_response, false, "Troublemaker owns interruption");
assert.equal(turnDetection.threshold, 0.6, "Realtime VAD threshold is stable");
assert.equal(audioOutput.voice, "marin", "Realtime voice remains configurable");
assert.deepEqual(session.tools, [], "Realtime transport does not expose a separate tool loop");

const speech = createCanonicalSpeechResponse("Hello from Agent.");
const speechResponse = objectValue(speech.response);
const speechInput = arrayValue(speechResponse.input);
const firstInput = objectValue(speechInput[0]);
const content = arrayValue(firstInput.content);
const firstContent = objectValue(content[0]);
assert.equal(speech.type, "response.create", "Canonical text is rendered through a Realtime response");
assert.equal(speechResponse.conversation, "none", "Speech rendering does not pollute the Realtime transcript conversation");
assert.deepEqual(speechResponse.output_modalities, ["audio"], "Canonical response is rendered as audio");
assert.match(String(speechResponse.instructions), /exactly/i, "Speech response tells Realtime to read exact canonical text");
assert.match(String(firstContent.text), /Hello from Agent\./, "Canonical Agent text is supplied to speech renderer");

const localControlToken = "local-control-secret-with-at-least-32-bytes";
assert.equal(isRealtimeControlTokenAccepted(undefined, undefined), false, "Missing control-token configuration fails closed");
assert.equal(isRealtimeControlTokenAccepted("local-secret", "local-secret"), false, "Weak configured control tokens fail closed");
assert.equal(isRealtimeControlTokenAccepted(localControlToken, undefined), false, "Configured control token rejects missing client token");
assert.equal(isRealtimeControlTokenAccepted(localControlToken, "wrong-secret"), false, "Configured control token rejects wrong client token");
assert.equal(isRealtimeControlTokenAccepted(localControlToken, localControlToken), true, "Configured control token accepts exact client token");
assert.doesNotMatch(
	readFileSync(new URL("../src/adapters/realtime-voice.ts", import.meta.url), "utf8"),
	/local_control_token/,
	"Realtime control capabilities never enter request URLs",
);

assert.deepEqual(
	resolveRealtimeAuthPlan({
		env: {
			TROUBLEMAKER_CLOUD_BASE_URL: "https://crawdad.example",
			TROUBLEMAKER_CLOUD_AGENT_ID: "agent-1",
			TROUBLEMAKER_CLOUD_ACCESS_TOKEN: "tfat-token",
			OPENAI_API_KEY: "sk-local",
		},
	}),
	{ source: "broker" },
	"Cloud-bound runtimes prefer brokered Realtime credentials over inherited local OpenAI keys",
);
assert.deepEqual(
	resolveRealtimeAuthPlan({
		env: {
			TROUBLEMAKER_REALTIME_AUTH: "local",
			TROUBLEMAKER_CLOUD_BASE_URL: "https://crawdad.example",
			TROUBLEMAKER_CLOUD_AGENT_ID: "agent-1",
			OPENAI_API_KEY: "sk-local",
		},
	}),
	{ source: "local", key: "sk-local" },
	"Explicit local auth can opt into a local OpenAI key",
);
assert.deepEqual(
	resolveRealtimeAuthPlan({
		env: {},
		clientApiKey: "sk-client",
	}).source,
	"none",
	"Client-supplied Realtime keys are disabled by default",
);
assert.deepEqual(
	resolveRealtimeAuthPlan({
		env: { TROUBLEMAKER_ALLOW_CLIENT_REALTIME_KEY: "1" },
		clientApiKey: "sk-client",
	}),
	{ source: "client", key: "sk-client" },
	"Client-supplied Realtime keys require an explicit local testing opt-in",
);
const safetyIdentifier = realtimeSafetyIdentifier({
	TROUBLEMAKER_CLOUD_AGENT_ID: "agent-1",
	TROUBLEMAKER_LOCAL_AGENT_ID: "agent-1",
	TROUBLEMAKER_AGENT_PROFILE: "cloud-agent",
});
assert.match(safetyIdentifier, /^tfat:[a-f0-9]{48}$/, "Safety identifier is a stable hashed value");
assert.doesNotMatch(safetyIdentifier, /agent-1/, "Safety identifier does not expose the raw agent id");

console.log("realtime voice canonical bridge tests passed");

function objectValue(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
	assert.equal(Array.isArray(value), true);
	return value as unknown[];
}
