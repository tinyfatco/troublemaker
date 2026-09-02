import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	VOICE_LIMITS, VOICE_SESSION_VERSION, VoiceInputLedger, VoiceSessionContractError,
	VoiceSpeechFlowLedger, strictBase64, validateSpeechControl, validateVoiceClientEvent,
	validateVoiceOpen, validateVoiceServerEvent, type VoiceIdentity, type VoiceServerEvent,
} from "../src/console/voice-session-contract.js";

const identity: VoiceIdentity = { session_id:"voice-session-fixture-0001", capture_id:"voice-capture-fixture-0001", delivery_id:"voice-delivery-fixture-0001", subject_agent_id:"agent-fixture" };
const audio = (sequence:number) => ({ version:VOICE_SESSION_VERSION, identity, sequence, kind:"audio" as const, audio:Buffer.alloc(32).toString("base64"), duration_milliseconds:1 });
const segment = (serverSequence:number, segmentSequence:number, id=`speech-segment-${segmentSequence}`, byte=0) => ({ version:VOICE_SESSION_VERSION, identity, sequence:serverSequence, event_id:`speech-event-${serverSequence}`, kind:"assistant_speech_segment" as const, completion_id:"completion-1", speech_stream_id:"speech-stream-1", speech_segment_id:id, speech_segment_sequence:segmentSequence, speech_audio:Buffer.alloc(48,byte).toString("base64"), speech_duration_milliseconds:1 });
const control = (sequence:number, acknowledged:number, kind:"audio_accepted"|"cancel"="audio_accepted") => ({ version:VOICE_SESSION_VERSION, identity, sequence, kind, completion_id:"completion-1", speech_stream_id:"speech-stream-1", acknowledged_speech_segment_sequence:acknowledged });

const baseFixture = JSON.parse(readFileSync(new URL("./fixtures/voice-session-v1.json", import.meta.url), "utf8"));
const speechFixture = JSON.parse(readFileSync(new URL("./fixtures/voice-session-spoken-reply-v1.json", import.meta.url), "utf8"));
assert.equal(baseFixture.version, VOICE_SESSION_VERSION);
assert.equal(speechFixture.version, VOICE_SESSION_VERSION);
for (const event of baseFixture.events) validateVoiceServerEvent(event, identity);
for (const event of speechFixture.events) validateVoiceServerEvent(event, identity);
validateVoiceOpen({ version:VOICE_SESSION_VERSION, identity, audio:{ encoding:"pcm_s16le", sample_rate:16000, channel_count:1 }, configuration:{ response_policy:"concise_watch", speech_mode:"progressive_audio" }, resume_after_server_sequence:0 });
assert.throws(() => validateVoiceOpen({ version:VOICE_SESSION_VERSION, identity, audio:{ encoding:"pcm_s16le", sample_rate:16000, channel_count:1 }, configuration:{ response_policy:"invent_prompt", speech_mode:"progressive_audio" } }), VoiceSessionContractError);
assert.equal(strictBase64("AAAA")?.byteLength, 3);
assert.equal(strictBase64("not base64"), null);

const input = new VoiceInputLedger(identity);
input.acknowledge(0, 64);
for (let sequence=1; sequence<=VOICE_LIMITS.audioEvents; sequence++) {
	if (input.availableAudioSlots === 0) input.acknowledge(sequence-1,64);
	assert.equal(input.apply(audio(sequence)), true);
}
const inputSnapshot = input.checkpoint();
assert.throws(() => input.apply(audio(VOICE_LIMITS.clientEvents)), /bounds_exceeded/);
assert.deepEqual(input.checkpoint(), inputSnapshot, "failed audio does not mutate state");
assert.equal(input.apply({ version:VOICE_SESSION_VERSION, identity, sequence:VOICE_LIMITS.clientEvents, kind:"end_of_utterance" }), true);
assert.equal(input.inputClosed, true);
const restoredInput = new VoiceInputLedger(identity, input.checkpoint());
assert.equal(restoredInput.inputClosed, true);
assert.equal(restoredInput.apply({ version:VOICE_SESSION_VERSION, identity, sequence:VOICE_LIMITS.clientEvents, kind:"end_of_utterance" }), false);
assert.throws(() => restoredInput.apply({ version:VOICE_SESSION_VERSION, identity, sequence:VOICE_LIMITS.clientEvents, kind:"cancel" }), /replay_mismatch/);

let speech = new VoiceSpeechFlowLedger(identity,"completion-1","speech-stream-1");
for (let sequence=1; sequence<=8; sequence++) assert.equal(speech.claim(segment(sequence,sequence)),true);
assert.equal(speech.availableSegmentSlots,0);
assert.throws(() => speech.claim(segment(9,9)),/backpressure_exceeded/);
assert.equal(speech.applyControl(control(1,4)),true);
assert.equal(speech.applyControl(control(1,4)),false);
assert.throws(() => speech.applyControl(control(1,5)),/replay_mismatch/);
assert.throws(() => speech.applyControl(control(2,4)),/acknowledgement_regression/);
const speechCheckpoint = speech.checkpoint();
speech = new VoiceSpeechFlowLedger(identity,"completion-1","speech-stream-1",speechCheckpoint);
assert.equal(speech.claim(segment(1,1)),false,"exact old segment replay remains idempotent despite older server sequence");
assert.throws(() => speech.claim(segment(1,1,"speech-segment-1",1)),/replay_mismatch/);
assert.throws(() => speech.claim(segment(7,9)),/invalid_sequence/);
assert.throws(() => speech.claim(segment(9,9,"speech-segment-1")),/duplicate_segment_id/);

speech = new VoiceSpeechFlowLedger(identity,"completion-1","speech-stream-1");
for (let sequence=1; sequence<=VOICE_LIMITS.speechSegments; sequence++) {
	assert.equal(speech.claim(segment(sequence,sequence)),true);
	assert.equal(speech.applyControl(control(sequence,sequence)),true);
}
const beforeSameAck = speech.checkpoint();
assert.throws(() => speech.applyControl(control(VOICE_LIMITS.speechControls,VOICE_LIMITS.speechSegments)),/invalid_speech_control/);
assert.deepEqual(speech.checkpoint(),beforeSameAck);
assert.equal(speech.applyControl(control(VOICE_LIMITS.speechControls,VOICE_LIMITS.speechSegments,"cancel")),true);
assert.equal(speech.cancelled,true);
assert.throws(() => validateSpeechControl(control(VOICE_LIMITS.speechControls,"512" as unknown as number)), VoiceSessionContractError);
assert.throws(() => validateVoiceClientEvent({ ...audio(1), audio:"AAAA=" }), VoiceSessionContractError);
console.log("voice session server contract tests passed");
