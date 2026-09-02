import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../src/gateway.js";
import { createHash } from "node:crypto";
import { VOICE_RECORDING_VERSION,VOICE_REPLAY_VERSION,VOICE_SESSION_VERSION,voiceFingerprint,voiceReplayRecordingDigest,type VoiceIdentity,type VoiceReplayFrameCommitment } from "../src/console/voice-session-contract.js";
import { VoiceSessionRuntime,type VoiceTranscriptionCallbacks } from "../src/console/voice-session-runtime.js";
import { VoiceSessionStore } from "../src/console/voice-session-store.js";

const root=mkdtempSync(join(tmpdir(),"voice-session-gateway-"));
const previousLocalAgentID=process.env.TROUBLEMAKER_LOCAL_AGENT_ID;
process.env.TROUBLEMAKER_LOCAL_AGENT_ID="agent-example";
try{
 mkdirSync(join(root,"awareness"),{recursive:true}); writeFileSync(join(root,"settings.json"),JSON.stringify({name:"Example Agent",localAgentId:"agent-example"}));
 let callbacks!:VoiceTranscriptionCallbacks;
 const runtime=new VoiceSessionRuntime({
  inputWindow:2,
  store:new VoiceSessionStore(join(root,"awareness","voice-sessions")),
  transcription:{open(_identity,next){callbacks=next;return{append(){next.speechStarted();next.partial("live partial");},finish(){next.segmentFinal("final words");next.thoughtCommitted("final words");},cancel(){}};}},
  canonical:{async prepare(){return{completionID:"completion-example",async dispatch(){async function* partials(){yield{text:"Short",speechEligible:false};}return{partials:partials(),final:Promise.resolve({text:"Short answer.",speechEligible:false})};}};}},
 });
 const gateway=new Gateway({workspaceDir:root,voiceSessions:runtime}); const port=await availablePort(); await gateway.start(port,"127.0.0.1");
 try{
  const base=`http://127.0.0.1:${port}/api/v2/agents/agent-example`;
  const status=await (await fetch(`${base}/status`)).json() as {capabilities:Record<string,boolean>}; assert.equal(status.capabilities.voice_session,true);
  const identity:VoiceIdentity={session_id:"session-example-voice",capture_id:"capture-example-voice",delivery_id:"delivery-example-voice",subject_agent_id:"agent-example"};
  const open={version:VOICE_SESSION_VERSION,identity,audio:{encoding:"pcm_s16le",sample_rate:16000,channel_count:1},configuration:{response_policy:"standard",speech_mode:"silent"}};
  let response=await fetch(`${base}/voice-sessions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(open)}); assert.equal(response.status,200);
  let body=await response.json() as {events:Array<{kind:string}>}; assert.deepEqual(body.events.map((event)=>event.kind),["ready"]);
  response=await fetch(`${base}/voice-sessions/${identity.session_id}/events`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:VOICE_SESSION_VERSION,identity,sequence:1,kind:"audio",audio:Buffer.alloc(640).toString("base64"),duration_milliseconds:20})}); assert.equal(response.status,200);
  await drain();
  response=await fetch(`${base}/voice-sessions/${identity.session_id}/events?after=1`); body=await response.json() as {events:Array<{kind:string}>}; assert.deepEqual(body.events.map((event)=>event.kind),["speech_started","transcript_partial"]);
  response=await fetch(`${base}/voice-sessions/${identity.session_id}/events`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:VOICE_SESSION_VERSION,identity,sequence:2,kind:"end_of_utterance"})}); assert.equal(response.status,200);
  await drain(8);
  body=await (await fetch(`${base}/voice-sessions/${identity.session_id}/events?after=4`)).json() as {events:Array<{kind:string}>,terminal:boolean}; assert.deepEqual(body.events.map((event)=>event.kind),["end_of_utterance","transcript_partial","transcript_final","send_accepted","assistant_partial","assistant_final","completed"]); assert.equal(body.terminal,true);
  const wrong=await fetch(`http://127.0.0.1:${port}/api/v2/agents/other-agent/voice-sessions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(open)}); assert.equal(wrong.status,404);
  const watchIdentity={...identity,session_id:"session-example-watch",capture_id:"capture-example-watch",delivery_id:"delivery-example-watch"};
  const watchOpen={...open,identity:watchIdentity,configuration:{response_policy:"concise_watch",speech_mode:"silent"}};
  const unverifiedWatch=await fetch(`${base}/voice-sessions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(watchOpen)}); assert.equal(unverifiedWatch.status,403,"concise_watch cannot be client-selected without verified Watch authority");
  const verifiedWatch=await fetch(`${base}/voice-sessions`,{method:"POST",headers:{"Content-Type":"application/json","X-Troublemaker-Verified-Device-Surface":"watch"},body:JSON.stringify(watchOpen)}); assert.equal(verifiedWatch.status,200);

  const recordingIdentity={...identity,session_id:"session-example-recording",capture_id:"capture-example-recording",delivery_id:"delivery-example-recording"};
  const recordingAudio=Buffer.alloc(640,0x27);
  const recordingRequest={version:VOICE_RECORDING_VERSION,identity:recordingIdentity,configuration:open.configuration,captured_at:new Date().toISOString(),recording_sha256:createHash("sha256").update(recordingAudio).digest("hex"),audio:recordingAudio.toString("base64")};
  response=await fetch(`${base}/voice-sessions/${recordingIdentity.session_id}/recording`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(recordingRequest)});assert.equal(response.status,200);
  const recordingPlan=await response.json() as {disposition:string;input?:{audio_event_count:number;input_closed:boolean}};assert.ok(["processing","completed"].includes(recordingPlan.disposition));assert.equal(recordingPlan.input?.audio_event_count,1);assert.equal(recordingPlan.input?.input_closed,true);
  await drain(8);
  response=await fetch(`${base}/voice-sessions/${recordingIdentity.session_id}/recording`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(recordingRequest)});assert.equal(response.status,200);assert.equal(((await response.json()) as {disposition:string}).disposition,"completed","an exact repeated full request returns existing canonical completion");
  const changedRecording={...recordingRequest,audio:Buffer.alloc(640,0x28).toString("base64"),recording_sha256:createHash("sha256").update(Buffer.alloc(640,0x28)).digest("hex")};
  response=await fetch(`${base}/voice-sessions/${recordingIdentity.session_id}/recording`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(changedRecording)});assert.equal(response.status,409,"same identity with changed PCM fails closed");

  const replayIdentity={...identity,session_id:"session-example-replay",capture_id:"capture-example-replay",delivery_id:"delivery-example-replay"};
  const replayAudio=Buffer.alloc(640,0x41);
  const replayEvent={version:VOICE_SESSION_VERSION,identity:replayIdentity,sequence:1,kind:"audio" as const,audio:replayAudio.toString("base64"),duration_milliseconds:20};
  const replayFrames:VoiceReplayFrameCommitment[]=[{sequence:1,audio_sha256:createHash("sha256").update(replayAudio).digest("hex"),event_fingerprint:voiceFingerprint(replayEvent),byte_count:640,duration_milliseconds:20}];
  response=await fetch(`${base}/voice-sessions/${replayIdentity.session_id}/reconcile`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:VOICE_REPLAY_VERSION,identity:replayIdentity,configuration:open.configuration,captured_at:new Date().toISOString(),recording_digest:voiceReplayRecordingDigest(replayFrames),frames:replayFrames})});
  assert.equal(response.status,200);
  const replayPlan=await response.json() as {disposition:string;retry_authorization?:{authorization_id:string;original_session_id:string;recording_digest:string;retry_identity:VoiceIdentity}};
  assert.equal(replayPlan.disposition,"never_admitted");assert.ok(replayPlan.retry_authorization);
  const retryOpen={...open,identity:replayPlan.retry_authorization!.retry_identity,retry_authorization:{original_session_id:replayPlan.retry_authorization!.original_session_id,authorization_id:replayPlan.retry_authorization!.authorization_id,recording_digest:replayPlan.retry_authorization!.recording_digest}};
  response=await fetch(`${base}/voice-sessions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(retryOpen)});assert.equal(response.status,200);
  assert.ok(callbacks);
 }finally{await gateway.stop();}
 console.log("voice session gateway tests passed");
}finally{rmSync(root,{recursive:true,force:true}); if(previousLocalAgentID===undefined)delete process.env.TROUBLEMAKER_LOCAL_AGENT_ID;else process.env.TROUBLEMAKER_LOCAL_AGENT_ID=previousLocalAgentID;}
async function availablePort(){const server=createServer();await new Promise<void>((resolve)=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address!=="string");const port=address.port;await new Promise<void>((resolve)=>server.close(()=>resolve()));return port;}
async function drain(turns=4){for(let index=0;index<turns;index++)await new Promise<void>((resolve)=>setImmediate(resolve));}
