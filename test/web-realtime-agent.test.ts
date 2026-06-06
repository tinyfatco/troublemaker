import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const voiceHook = readFileSync("ui/src/hooks/useVoiceChat.ts", "utf8");
const awarenessPane = readFileSync("ui/src/components/AwarenessPane.tsx", "utf8");

assert.match(voiceHook, /Realtime owns the live voice turn/, "web voice hook documents direct Realtime ownership");
assert.doesNotMatch(voiceHook, /onTranscript/, "web voice no longer exposes transcript handoff callback");
assert.doesNotMatch(voiceHook, /not the agent brain/i, "web voice no longer tells Realtime it is not the agent");
assert.doesNotMatch(voiceHook, /Do not answer the user/i, "web voice no longer suppresses Realtime answers");
assert.match(voiceHook, /create_response:\s*true/, "Realtime server VAD creates model responses");
assert.match(voiceHook, /interrupt_response:\s*true/, "Realtime handles barge-in interruption");
assert.match(voiceHook, /tool_choice:\s*'none'/, "first slice exposes no tools");
assert.doesNotMatch(voiceHook, /createCanonicalSpeechResponse/, "canonical speech handoff is removed from web voice");
assert.doesNotMatch(voiceHook, /source:\s*'web-voice'/, "web voice no longer posts transcripts to web chat");

assert.match(awarenessPane, /const voice = useVoiceChat\(\);/, "AwarenessPane starts voice without a transcript callback");
assert.doesNotMatch(awarenessPane, /handleVoiceTranscript/, "AwarenessPane has no voice transcript bridge");
assert.doesNotMatch(awarenessPane, /voice\.speak/, "AwarenessPane no longer speaks text-chat responses through Realtime");

console.log("web realtime agent wiring ok");
