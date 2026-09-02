import assert from "node:assert/strict";
import { mkdirSync,mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MomEvent,MomHandler,PlatformAdapter } from "../src/adapters/types.js";
import { projectConciseWatchHistory } from "../src/console/concise-watch-context.js";
import { ComputerVoiceCanonicalSubmitter } from "../src/console/voice-session-canonical.js";
import { buildConciseWatchRuntimeContext,buildRuntimeContext } from "../src/core/prompt.js";

const root=mkdtempSync(join(tmpdir(),"voice-session-canonical-"));mkdirSync(root,{recursive:true});
try{
 let observedEvent:MomEvent|undefined;let observedInstructions="";let observedContextProjection:unknown;
 const handler={async handleEvent(event:MomEvent,adapter:PlatformAdapter){observedEvent=event;observedInstructions=adapter.formatInstructions;const context=adapter.createContext(event,{} as never);observedContextProjection=context.message.contextProjection;await context.sendFinalResponse("Canonical answer.");return{stopReason:"end_turn"};}} as MomHandler;
 const submitter=new ComputerVoiceCanonicalSubmitter(handler,root);
 const identity={session_id:"session-canonical-example",capture_id:"capture-canonical-example",delivery_id:"delivery-canonical-example",subject_agent_id:"agent-example"};
 const prepared=await submitter.prepare({identity,text:"Question?",responsePolicy:"concise_watch",relationshipId:"relationship-example"});
 assert.equal(observedEvent,undefined,"prepare is side-effect free");assert.match(prepared.completionID,/^completion-/);
 const dispatch=prepared.dispatch();assert.equal(prepared.dispatch(),dispatch,"dispatch is idempotently claimed");const reply=await dispatch;
 const partials=[];for await(const partial of reply.partials)partials.push(partial);
 assert.deepEqual(await reply.final,{text:"Canonical answer.",speechEligible:true});
 assert.deepEqual(partials,[{text:"Canonical answer.",speechEligible:true}]);
 assert.equal(observedEvent?.deliveryId,identity.delivery_id);assert.equal(observedEvent?.sessionId,identity.session_id);assert.equal(observedEvent?.relationshipId,"relationship-example");assert.equal(observedEvent?.sourceEventType,"computer_voice_session");assert.equal(observedEvent?.contextProjection,"concise_watch");assert.equal(observedContextProjection,"concise_watch");assert.match(observedInstructions,/Apple Watch voice/);assert.match(observedInstructions,/uncertainty/);
 const log=readFileSync(join(root,"log.jsonl"),"utf8");assert.match(log,/Question\?/);assert.doesNotMatch(log,/completion-/);
 const standardPrepared=await submitter.prepare({identity:{...identity,session_id:"session-standard-example",delivery_id:"delivery-standard-example"},text:"Standard question?",responsePolicy:"standard"});const standardReply=await standardPrepared.dispatch();await standardReply.final;assert.equal(observedEvent?.contextProjection,undefined);assert.equal(observedContextProjection,undefined);assert.match(observedInstructions,/Computer voice/);assert.doesNotMatch(observedInstructions,/Apple Watch voice/);

 const history=[] as Array<{role:string;content:Array<{type:string;text:string}>}>;for(let index=0;index<40;index++){history.push({role:"user",content:[{type:"text",text:`request-${index}`}]},{role:"assistant",content:[{type:"text",text:`answer-${index}`}]});}
 const projected=projectConciseWatchHistory(history,8,4_096);assert.equal(projected.sourceMessageCount,80);assert.equal(projected.messages.length,8);assert.equal(projected.messages[0]?.role,"user","bounded suffix starts at a complete user turn");assert.deepEqual(projected.messages,history.slice(-8),"projection preserves complete exact messages and order");assert.ok(projected.projectedBytes<=4_096);assert.equal(history.length,80,"projection never mutates durable history");
 const oneOversizedTurn=projectConciseWatchHistory([{role:"user",content:[{type:"text",text:"x".repeat(5_000)}]},{role:"assistant",content:[{type:"text",text:"answer"}]}],8,512);assert.deepEqual(oneOversizedTurn.messages,[],"oversized history is omitted rather than clipped or detached from its user turn");

 const contextOptions={workspaceContext:"Agents:\nSAFETY\n\nIdentity:\nIDENTITY\n\nMemory:\nMEMORY",channels:[{id:"ios",name:"Computer"}],users:[{id:"computer-user",userName:"computer-user",displayName:"Computer user"}],skills:[{name:"safe-tool",description:"Tool authority",filePath:"/example/SKILL.md"}],displayChannelId:"ios",displayChannelName:"Computer"};
 const nonVoice=buildRuntimeContext(contextOptions);assert.equal(nonVoice,`<runtime_context>\nAttending: Computer (ios)\nChannels:\nios\t#Computer\nUsers:\ncomputer-user\t@computer-user\tComputer user\nSkills:\n\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>safe-tool</name>\n    <description>Tool authority</description>\n    <location>/example/SKILL.md</location>\n  </skill>\n</available_skills>\nAgents:\nSAFETY\n\nIdentity:\nIDENTITY\n\nMemory:\nMEMORY\n</runtime_context>`,`non-voice runtime context remains byte-equivalent`);
 const watchContext=buildConciseWatchRuntimeContext(contextOptions);for(const marker of ["SAFETY","IDENTITY","MEMORY","safe-tool","Tool authority","Attending: Computer (ios)"]){assert.equal(watchContext.split(marker).length-1,1,`Watch context preserves ${marker} exactly once`);}assert.ok(watchContext.indexOf("Memory:\nMEMORY")<watchContext.indexOf("Attending: Computer (ios)"),"stable workspace prefix precedes volatile Watch route state");
 console.log("voice session canonical submitter tests passed");
}finally{rmSync(root,{recursive:true,force:true});}
