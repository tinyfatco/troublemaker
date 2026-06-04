import assert from "node:assert/strict";
import {
	createCanonicalSpeechResponse,
	createRealtimeSessionUpdate,
	createRealtimeVoiceInstructions,
} from "../src/adapters/realtime-voice.js";

const instructions = createRealtimeVoiceInstructions();
assert.match(instructions, /voice transport/i, "Realtime session is explicitly transport-only");
assert.match(instructions, /not the agent brain/i, "Realtime prompt does not pretend to be Zip's brain");
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

const speech = createCanonicalSpeechResponse("Hello from Zip.");
const speechResponse = objectValue(speech.response);
const speechInput = arrayValue(speechResponse.input);
const firstInput = objectValue(speechInput[0]);
const content = arrayValue(firstInput.content);
const firstContent = objectValue(content[0]);
assert.equal(speech.type, "response.create", "Canonical text is rendered through a Realtime response");
assert.equal(speechResponse.conversation, "none", "Speech rendering does not pollute the Realtime transcript conversation");
assert.deepEqual(speechResponse.output_modalities, ["audio"], "Canonical response is rendered as audio");
assert.match(String(speechResponse.instructions), /exactly/i, "Speech response tells Realtime to read exact canonical text");
assert.match(String(firstContent.text), /Hello from Zip\./, "Canonical Zip text is supplied to speech renderer");

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
