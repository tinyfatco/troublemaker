import assert from "node:assert/strict";
import {
	VOICE_SESSION_VERSION, type VoiceClientEvent, type VoiceIdentity,
} from "../src/console/voice-session-contract.js";
import {
	VoiceSessionRuntime, type VoiceCanonicalSubmitter, type VoiceTranscriptionCallbacks,
	type VoiceTranscriptionProvider, type VoiceTranscriptionSession,
} from "../src/console/voice-session-runtime.js";

const identity: VoiceIdentity = { session_id:"session-example-0001",capture_id:"capture-example-0001",delivery_id:"delivery-example-0001",subject_agent_id:"agent-example" };
const pcm = Buffer.alloc(640).toString("base64");
let callbacks!: VoiceTranscriptionCallbacks;
let appended = 0;
let finished = 0;
let cancelled = 0;
const transcription: VoiceTranscriptionProvider = { open(_identity, next) { callbacks=next; return { append(bytes){ appended+=bytes.byteLength; if(appended===640) callbacks.speechStarted(); callbacks.partial("hello"); }, finish(){ finished++; callbacks.segmentFinal("hello there"); callbacks.thoughtCommitted("hello there"); }, cancel(){ cancelled++; } } satisfies VoiceTranscriptionSession; } };
const submissions: string[]=[];
const canonical: VoiceCanonicalSubmitter = { async prepare(input) { return { completionID:"completion-example-0001",async dispatch(){submissions.push(`${input.responsePolicy}:${input.text}`);async function* partials(){ yield { text:"Brief",speechEligible:true }; }return {partials:partials(),final:Promise.resolve({ text:"Brief answer.",speechEligible:true })};} }; } };
assert.throws(()=>new VoiceSessionRuntime({transcription,canonical,inputWindow:1}),/Invalid voice input window/);
const runtime = new VoiceSessionRuntime({ transcription,canonical,inputWindow:2 });
const open={ version:VOICE_SESSION_VERSION,identity,audio:{encoding:"pcm_s16le" as const,sample_rate:16000 as const,channel_count:1 as const},configuration:{response_policy:"concise_watch" as const,speech_mode:"silent" as const} };
let poll=runtime.open("agent-example",open);
assert.deepEqual(poll.events.map((event)=>event.kind),["ready"]);
assert.equal(runtime.open("agent-example",open).events.length,1,"exact open replay returns existing ordered outbox");
assert.throws(()=>runtime.open("other-agent",open),/agent_identity_mismatch/);
const audio:VoiceClientEvent={version:VOICE_SESSION_VERSION,identity,sequence:1,kind:"audio",audio:pcm,duration_milliseconds:20};
poll=await runtime.applyClientEvent("agent-example",identity.session_id,audio);
await drain();
poll=runtime.poll(identity.session_id,0);
assert.deepEqual(poll.events.map((event)=>event.kind),["ready","speech_started","transcript_partial"]);
assert.equal(poll.events.find((event)=>event.kind==="transcript_partial")?.text,"hello");
assert.equal(appended,640);
const countBeforeReplay=poll.events.length;
await runtime.applyClientEvent("agent-example",identity.session_id,audio);
assert.equal(runtime.poll(identity.session_id,0).events.length,countBeforeReplay,"exact input replay has no duplicate event or provider call");
assert.equal(appended,640);
await assert.rejects(runtime.applyClientEvent("agent-example",identity.session_id,{...audio,audio:Buffer.alloc(640,1).toString("base64")}),/replay_mismatch/);
await runtime.applyClientEvent("agent-example",identity.session_id,{version:VOICE_SESSION_VERSION,identity,sequence:2,kind:"end_of_utterance"});
await drain(8);
poll=runtime.poll(identity.session_id,0);
assert.deepEqual(poll.events.map((event)=>event.kind),["ready","speech_started","transcript_partial","audio_accepted","end_of_utterance","transcript_partial","transcript_final","send_accepted","assistant_partial","assistant_final","completed"]);
assert.equal(finished,1);
assert.deepEqual(submissions,["concise_watch:hello there"]);
assert.equal(poll.terminal,true);
assert.equal(runtime.poll(identity.session_id,6).events[0]?.kind,"transcript_final");

const cancelIdentity={...identity,session_id:"session-example-0002",capture_id:"capture-example-0002",delivery_id:"delivery-example-0002"};
runtime.open("agent-example",{...open,identity:cancelIdentity});
await runtime.applyClientEvent("agent-example",cancelIdentity.session_id,{version:VOICE_SESSION_VERSION,identity:cancelIdentity,sequence:1,kind:"cancel"});
assert.equal(cancelled,1);
assert.equal(runtime.poll(cancelIdentity.session_id,0).events.at(-1)?.kind,"cancelled");

let lateCallbacks!:VoiceTranscriptionCallbacks;
const lateRuntime=new VoiceSessionRuntime({transcription:{open(_identity,next){lateCallbacks=next;return{append(){},finish(){next.segmentFinal("late vad words");next.thoughtCommitted("late vad words");},cancel(){}};}},canonical,inputWindow:2});
const lateIdentity={...identity,session_id:"session-example-late-vad",capture_id:"capture-example-late-vad",delivery_id:"delivery-example-late-vad"};
lateRuntime.open("agent-example",{...open,identity:lateIdentity});
await lateRuntime.applyClientEvent("agent-example",lateIdentity.session_id,{version:VOICE_SESSION_VERSION,identity:lateIdentity,sequence:1,kind:"end_of_utterance"});
await drain(8);
assert.deepEqual(lateRuntime.poll(lateIdentity.session_id,0).events.map((event)=>event.kind),["ready","audio_accepted","speech_started","end_of_utterance","transcript_partial","transcript_final","send_accepted","assistant_partial","assistant_final","completed"]);
assert.ok(lateCallbacks);

const continuationIdentity={...identity,session_id:"session-example-continuation",capture_id:"capture-example-continuation",delivery_id:"delivery-example-continuation"};
let continuationCallbacks!:VoiceTranscriptionCallbacks;const committedInputs:string[]=[];
const continuationRuntime=new VoiceSessionRuntime({inputWindow:2,transcription:{open(_identity,next){continuationCallbacks=next;return{append(){},finish(){},cancel(){}};}},canonical:{async prepare(input){committedInputs.push(input.text);return{completionID:"completion-continuation",async dispatch(){async function* partials(){}return{partials:partials(),final:Promise.resolve({text:"done",speechEligible:false})};}};}}});
continuationRuntime.open("agent-example",{...open,identity:continuationIdentity});continuationCallbacks.speechStarted();continuationCallbacks.segmentFinal("first segment");await drain();let continuationEvents=continuationRuntime.poll(continuationIdentity.session_id,0).events;assert.deepEqual(continuationEvents.map((event)=>event.kind),["ready","speech_started","transcript_partial"]);assert.deepEqual(committedInputs,[],"segmentFinal is preview custody, never delivery authority");
continuationCallbacks.speechResumed();continuationCallbacks.partial("first segment continued");continuationCallbacks.segmentFinal("continued");await drain();continuationEvents=continuationRuntime.poll(continuationIdentity.session_id,0).events;assert.equal(continuationEvents.some((event)=>event.kind==="transcript_final"),false);assert.deepEqual(committedInputs,[],"resumed speech retracts early thought delivery");
continuationCallbacks.thoughtCommitted("first segment continued");await drain(8);continuationEvents=continuationRuntime.poll(continuationIdentity.session_id,0).events;assert.equal(continuationEvents.filter((event)=>event.kind==="transcript_final").length,1);assert.equal(continuationEvents.filter((event)=>event.kind==="send_accepted").length,1);assert.deepEqual(committedInputs,["first segment continued"]);

const hardBoundIdentity={...identity,session_id:"session-example-hard-bound",capture_id:"capture-example-hard-bound",delivery_id:"delivery-example-hard-bound"};let hardBoundCallbacks!:VoiceTranscriptionCallbacks;let hardBoundCancelled=0;let hardBoundPrepares=0;let emittedHardBoundSegment=false;
const hardBoundRuntime=new VoiceSessionRuntime({inputWindow:64,transcription:{open(_identity,next){hardBoundCallbacks=next;return{append(){if(!emittedHardBoundSegment){emittedHardBoundSegment=true;next.speechStarted();next.partial("partial must not submit");next.segmentFinal("partial must not submit");}},finish(){},cancel(){hardBoundCancelled++;}};}},canonical:{async prepare(){hardBoundPrepares++;throw new Error("hard bound must not prepare");}}});
hardBoundRuntime.open("agent-example",{...open,identity:hardBoundIdentity});const maximumChunk=Buffer.alloc(8_000).toString("base64");let hardBoundPoll=hardBoundRuntime.poll(hardBoundIdentity.session_id,0);for(let sequence=1;sequence<=240;sequence++)hardBoundPoll=await hardBoundRuntime.applyClientEvent("agent-example",hardBoundIdentity.session_id,{version:VOICE_SESSION_VERSION,identity:hardBoundIdentity,sequence,kind:"audio",audio:maximumChunk,duration_milliseconds:250});await drain();hardBoundPoll=hardBoundRuntime.poll(hardBoundIdentity.session_id,0);assert.equal(hardBoundPoll.terminal,true);assert.equal(hardBoundPoll.events.at(-1)?.error_code,"bounds_exceeded");assert.equal(hardBoundPoll.events.some((event)=>event.kind==="transcript_final"||event.kind==="send_accepted"),false);assert.equal(hardBoundPrepares,0);assert.equal(hardBoundCancelled,1);assert.ok(hardBoundCallbacks);

const boundedIdentity={...identity,session_id:"session-example-bounded",capture_id:"capture-example-bounded",delivery_id:"delivery-example-bounded"};
const boundedRuntime=new VoiceSessionRuntime({transcription:{open(){return{append(){},finish(){},cancel(){}};}},canonical,inputWindow:8});
boundedRuntime.open("agent-example",{...open,identity:boundedIdentity});
for(let sequence=1;sequence<=80;sequence++)await boundedRuntime.applyClientEvent("agent-example",boundedIdentity.session_id,{version:VOICE_SESSION_VERSION,identity:boundedIdentity,sequence,kind:"audio",audio:Buffer.alloc(32).toString("base64"),duration_milliseconds:1});
const boundedEvents=boundedRuntime.poll(boundedIdentity.session_id,0).events;assert.equal(boundedEvents.filter((event)=>event.kind==="audio_accepted").length,10,"input acknowledgements are cumulative rather than one server event per frame");assert.equal(boundedEvents.length,11);
console.log("voice session runtime tests passed");

async function drain(turns=4):Promise<void>{ for(let index=0;index<turns;index++) await new Promise<void>((resolve)=>setImmediate(resolve)); }
