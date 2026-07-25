import assert from "node:assert/strict";
import { AssistantAudioGate, pcm16RmsLevel } from "../src/audio-capture-gate.js";

const gate = new AssistantAudioGate({
	activeBargeInLevel: 0.08,
	cooldownBargeInLevel: 0.05,
	sustainMs: 200,
	bargeInOpenMs: 1000,
});

const quietActive = gate.decide({ phase: "active", audioLevel: 0.02, now: 1000 });
assert.equal(quietActive.sendToStt, false, "quiet assistant-active mic audio should be held before STT upload");
assert.equal(quietActive.reason, "assistant_speech_gate");

const firstLoudActive = gate.decide({ phase: "active", audioLevel: 0.1, now: 1100 });
assert.equal(firstLoudActive.sendToStt, false, "one loud chunk is not enough to open barge-in");

const sustainedLoudActive = gate.decide({ phase: "active", audioLevel: 0.11, now: 1325 });
assert.equal(sustainedLoudActive.sendToStt, true, "sustained loud active audio should be allowed as a barge-in candidate");
assert.equal(sustainedLoudActive.reason, "barge_in_candidate");

const followOnBargeInAudio = gate.decide({ phase: "active", audioLevel: 0.03, now: 1500 });
assert.equal(followOnBargeInAudio.sendToStt, true, "barge-in window should keep the utterance flowing to STT");

const afterBargeWindow = gate.decide({ phase: "active", audioLevel: 0.03, now: 2600 });
assert.equal(afterBargeWindow.sendToStt, false, "assistant-active audio should be held again after the barge-in window closes");

const idle = gate.decide({ phase: "idle", audioLevel: 0, now: 2700 });
assert.equal(idle.sendToStt, true, "idle mic audio should pass through");

const samples = Buffer.alloc(8);
samples.writeInt16LE(16384, 0);
samples.writeInt16LE(-16384, 2);
samples.writeInt16LE(0, 4);
samples.writeInt16LE(0, 6);
const rms = pcm16RmsLevel(samples);
assert(rms > 0.35 && rms < 0.36, `PCM16 RMS should be normalized, got ${rms}`);
