import assert from "node:assert/strict";
import {
	assistantSpeechSimilarity,
	beginAssistantSpeech,
	finishAssistantSpeech,
	getAssistantSpeechGuardState,
	resetAssistantSpeechGuardForTests,
	shouldSuppressAssistantSpeechEcho,
} from "../src/audio-feedback-guard.js";

resetAssistantSpeechGuardForTests();

const mangledSimilarity = assistantSpeechSimilarity("Tiny soup voice online", "Tiny Soup Boys online");
assert(mangledSimilarity >= 0.72, `ASR mangle similarity should be high enough, got ${mangledSimilarity}`);

const start = 1_000_000;
const speechId = beginAssistantSpeech("Tiny soup voice online", {
	now: start,
	cooldownMs: 1000,
	recentWindowMs: 10_000,
	maxActiveMs: 30_000,
});

const activeEcho = shouldSuppressAssistantSpeechEcho("Tiny Soup Boys online", { now: start + 250 });
assert.equal(activeEcho.suppress, true, "active assistant speech echo should be suppressed");
assert.equal(activeEcho.reason, "active_assistant_speech_echo");

const activeState = getAssistantSpeechGuardState({ now: start + 250 });
assert.equal(activeState.active, true, "assistant speech state should be active while TTS is playing");
assert.equal(activeState.phase, "active");
assert.equal(activeState.recent.length, 1);

const activeBargeIn = shouldSuppressAssistantSpeechEcho("Noodle stop and open Stripe dashboard", { now: start + 300 });
assert.equal(activeBargeIn.suppress, false, "clearly different user barge-in should be allowed while speech is active");

finishAssistantSpeech(speechId, { now: start + 2000, cooldownMs: 1000, recentWindowMs: 10_000 });

const cooldownState = getAssistantSpeechGuardState({ now: start + 2400 });
assert.equal(cooldownState.active, true, "assistant speech state should stay active during cooldown");
assert.equal(cooldownState.phase, "cooldown");

const cooldownEcho = shouldSuppressAssistantSpeechEcho("Tiny suit boys online", { now: start + 2400 });
assert.equal(cooldownEcho.suppress, true, "cooldown assistant speech echo should be suppressed");
assert.equal(cooldownEcho.reason, "cooldown_assistant_speech_echo");

const laterEcho = shouldSuppressAssistantSpeechEcho("Tiny Soup Boys online", { now: start + 4000 });
assert.equal(laterEcho.suppress, true, "recent assistant speech echo should still be suppressed after cooldown");
assert.equal(laterEcho.reason, "recent_assistant_speech_echo");

const laterNewIntent = shouldSuppressAssistantSpeechEcho("Back in Black volume fifty", { now: start + 4100 });
assert.equal(laterNewIntent.suppress, false, "different short user intent should not be suppressed after cooldown");

const expiredEcho = shouldSuppressAssistantSpeechEcho("Tiny Soup Boys online", { now: start + 20_000 });
assert.equal(expiredEcho.suppress, false, "old spoken text should expire from echo suppression");

const expiredState = getAssistantSpeechGuardState({ now: start + 20_000 });
assert.equal(expiredState.active, false);
assert.equal(expiredState.phase, "idle");
assert.equal(expiredState.recent.length, 0);

resetAssistantSpeechGuardForTests();
