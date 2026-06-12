import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const voiceHook = readFileSync("ui/src/hooks/useVoiceChat.ts", "utf8");
const awarenessPane = readFileSync("ui/src/components/AwarenessPane.tsx", "utf8");
const cli = readFileSync("src/host/node/cli.ts", "utf8");

assert.match(voiceHook, /compact context handoff plus narrow read\/search tools/, "web voice hook documents narrowed Realtime ownership");
assert.doesNotMatch(voiceHook, /onTranscript/, "web voice no longer exposes transcript handoff callback");
assert.doesNotMatch(voiceHook, /not the agent brain/i, "web voice no longer tells Realtime it is not the agent");
assert.doesNotMatch(voiceHook, /Do not answer the user/i, "web voice no longer suppresses Realtime answers");
assert.match(voiceHook, /create_response:\s*true/, "Realtime server VAD creates model responses");
assert.match(voiceHook, /interrupt_response:\s*true/, "Realtime handles barge-in interruption");
assert.match(voiceHook, /tool_choice:\s*'auto'/, "Realtime can choose workspace tools");
assert.match(voiceHook, /executeWorkspaceTool/, "Realtime function calls execute through the console tool proxy");
assert.match(voiceHook, /fetchRealtimeVoicePreference/, "web voice reads the configured Realtime voice");
assert.match(voiceHook, /activeVoiceRef\.current/, "web voice reuses the selected voice for session updates");
assert.match(voiceHook, /buildRealtimeContextHandoff/, "Realtime starts with a compact context handoff");
assert.match(voiceHook, /createRealtimeTruncationConfig/, "Realtime config sets an explicit context cap");
assert.match(voiceHook, /isBenignRealtimeCancellationError/, "Realtime ignores the benign no-active-response cancel race");
assert.match(voiceHook, /name:\s*'read'/, "Realtime exposes the read tool");
assert.match(voiceHook, /name:\s*'get_context_briefing'/, "Realtime exposes the compact context briefing tool");
assert.match(voiceHook, /name:\s*'search_context'/, "Realtime exposes the context search tool");
assert.doesNotMatch(voiceHook, /name:\s*'write'/, "Realtime does not expose write as a broad workspace tool");
assert.doesNotMatch(voiceHook, /name:\s*'edit'/, "Realtime does not expose edit as a broad workspace tool");
assert.doesNotMatch(voiceHook, /name:\s*'bash'/, "Realtime does not expose bash as a broad workspace tool");
assert.match(voiceHook, /conversation\.item\.create/, "Realtime returns function_call_output items");
assert.match(voiceHook, /response\.create/, "Realtime continues the assistant response after tool output");
assert.match(voiceHook, /localEntries:\s*AwarenessEntry\[\]/, "web voice exposes local awareness entries for visible Realtime turns");
assert.match(voiceHook, /channel:\s*'voice'/, "web voice labels visible turns as voice channel entries");
assert.match(voiceHook, /VoiceMode = 'realtime' \| 'turn'/, "web voice has a distinct turn-based voice mode");
assert.match(voiceHook, /\/voice\/stream/, "turn-based voice mode uses the canonical web-voice route");
assert.doesNotMatch(voiceHook, /createCanonicalSpeechResponse/, "canonical speech handoff is removed from web voice");
assert.doesNotMatch(voiceHook, /source:\s*'web-voice'/, "web voice no longer posts transcripts to web chat");

assert.match(awarenessPane, /useVoiceChat\(\{ contextEntries: contextEntriesForVoice \}\)/, "AwarenessPane passes current context into voice startup");
assert.match(awarenessPane, /voice\.localEntries/, "AwarenessPane renders local Realtime voice turns in the message stream");
assert.match(awarenessPane, /voice\.toggleMode/, "AwarenessPane exposes a minimal Realtime/turn-based voice mode switch");
assert.match(awarenessPane, /buildContextWindowStatus/, "AwarenessPane computes visible context-window status");
assert.match(awarenessPane, /contextWindow=\{contextWindow\}/, "AwarenessPane passes context-window status into the status strip");
assert.doesNotMatch(awarenessPane, /handleVoiceTranscript/, "AwarenessPane has no voice transcript bridge back to web chat");
assert.doesNotMatch(awarenessPane, /voice\.speak/, "AwarenessPane no longer speaks text-chat responses through Realtime");

assert.match(cli, /MOM_VOICE_ADAPTER === "true"/, "legacy port-8765 voice requires an explicit adapter env");
assert.doesNotMatch(cli, /if \(process\.env\.MOM_ELEVENLABS_API_KEY\) \{\s*adapters\.push\("voice"\)/, "managed ElevenLabs web voice does not auto-start the legacy adapter");

console.log("web realtime agent wiring ok");
