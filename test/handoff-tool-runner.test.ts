import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getOrCreateRunner} from '../src/agent.js';
import {ChannelStore} from '../src/store.js';
import {readContextTransitions} from '../src/context-transition.js';
const root=mkdtempSync(join(tmpdir(),'example-handoff-tool-'));
process.env.PI_AGENT_DIR=join(root,'agent');process.env.PI_OFFLINE='1';process.env.TROUBLEMAKER_PROMPT_PROFILE='compact';process.env.TROUBLEMAKER_INPUT_BUDGET='small';
const requests:any[]=[];const events:any[]=[];let runner:any;let injectSteering=false;
const server=createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;requests.push(JSON.parse(body));const n=requests.length;
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const emit=(delta:any,finish_reason:any=null)=>res.write(`data: ${JSON.stringify({id:`example-${n}`,object:'chat.completion.chunk',created:1,model:'example-model',choices:[{index:0,delta,finish_reason}]})}\n\n`);
 if([1,2,4,5,7,8,9,10].includes(n)){
 const name=([1,4,7,9].includes(n))?'search_tools':'call_tool';
 const args=([1,4,7,9].includes(n))?{query:'handoff_context',label:'Find context handoff'}:{name:'handoff_context',arguments:{label:'Hand off synthetic task',summary:'Synthetic task: return fixture complete.',nextSteps:'Return fixture complete',continue:true}};
 emit({role:'assistant',tool_calls:[{index:0,id:`example-call-${n}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});emit({},'tool_calls');
  }else{
 if(n===3){
  const userMessages=requests[n-1].messages.filter((m:any)=>m.role==='user');
  assert(!userMessages.some((m:any)=>typeof m.content==='string' && m.content.includes('Hand off and continue fixture') && !m.content.includes('Historical dialogue')),'old request cannot be redelivered as a live user turn');
 }
 if(n===6){
  assert(!JSON.stringify(requests[n-1]).includes('PRIVATE CONTINUITY CHECKPOINT REQUIRED NOW'),'steering after staged handoff must not inject pressure checkpoint');
  assert(JSON.stringify(requests[n-1]).includes('Cancel the rotation and answer this correction.'));
 }
 emit({role:'assistant',content:'Fixture complete.'});emit({},'stop');}
 res.end('data: [DONE]\n\n');
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
try{
 const address=server.address();assert(address&&typeof address!=='string');
 writeFileSync(join(root,'models.json'),JSON.stringify({providers:{example:{baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'example-key',api:'openai-completions',models:[{id:'example-model',name:'Example',reasoning:false,input:['text'],contextWindow:32768,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 writeFileSync(join(root,'MEMORY.md'),'Synthetic durable fact. '.repeat(150)+'COMPLETE_MEMORY_END');
 writeFileSync(join(root,'SOUL.md'),'COMPLETE_SOUL_END');
 writeFileSync(join(root,'settings.json'),JSON.stringify({defaultProvider:'example',defaultModel:'example-model',compaction:{enabled:true,mode:'handoff',reserveTokens:1000,keepRecentTokens:256}}));
 const noop=async()=>{};const ctx:any={message:{text:'Hand off and continue fixture',rawText:'Hand off and continue fixture',user:'example-user',channel:'example-channel',ts:'1',attachments:[]},channels:[],users:[],respond:noop,sendFinalResponse:noop,respondInThread:noop,setTyping:noop,uploadFile:noop,setWorking:noop,deleteMessage:noop,restartWorking:noop,emitContentBlock:(e:any)=>{events.push(e);if(injectSteering && e.contextTransition?.state==='preparing'){injectSteering=false;void runner.steer('Cancel the rotation and answer this correction.');}}};
 runner=await getOrCreateRunner({type:'host'},join(root,'awareness'),'Be concise.');
 const result=await runner.run(ctx,new ChannelStore({workingDir:root,botToken:''}));
 assert.equal(result.stopReason,'stop');assert.equal(requests.length,3,'tool should rotate without another summarization call');
 const transitions=readContextTransitions(root);assert.equal(transitions.length,1);assert.equal(transitions[0].state,'completed');assert.equal(transitions[0].trigger,'agent');
 assert(events.some(e=>e.contextTransition?.state==='completed'));
 const context=readFileSync(join(root,'awareness/context.jsonl'),'utf8');assert(context.includes('troublemaker.continuity-handoff.v1'));
 assert(JSON.stringify(requests[2]).includes('Harness continuation after context rotation'));
 assert(JSON.stringify(requests[0]).includes('COMPLETE_MEMORY_END'));
 assert(JSON.stringify(requests[0]).includes('COMPLETE_SOUL_END'));
 writeFileSync(join(root,'MEMORY.md'),'CHANGED_MEMORY_NEXT_CONTEXT_ONLY');
 injectSteering=true;
 const second=await runner.run({...ctx,message:{...ctx.message,text:'Rotate the synthetic context again.'}},new ChannelStore({workingDir:root,botToken:''}));
 assert(!JSON.stringify(requests[3]).includes('CHANGED_MEMORY_NEXT_CONTEXT_ONLY'),'active context keeps its admitted workspace snapshot');
 assert.equal(second.stopReason,'stop');assert.equal(requests.length,6);
 assert.equal(readContextTransitions(root).at(-1)?.state,'aborted','new input supersedes staged snapshot without losing it');
 await runner.run({...ctx,message:{...ctx.message,text:'Another synthetic handoff.'}},new ChannelStore({workingDir:root,botToken:''}));
 assert.equal(requests.length,10,'repeated handoff in continuation ends without another rotation or model call');
 assert.equal(readContextTransitions(root).filter(t=>t.state==='completed').length,2);
 const resumed=JSON.stringify(requests[8]);
 assert(resumed.includes("CHANGED_MEMORY_NEXT_CONTEXT_ONLY"),"handoff loads complete updated workspace files");
 assert.equal(resumed.split('Harness continuation after context rotation').length-1,1,'old continuations are not retained');
 console.log('PASS tool handoff, historical replay boundaries, steering supersession, and duplicate-rotation guard');
}finally{server.close();await rm(root,{recursive:true,force:true});}
