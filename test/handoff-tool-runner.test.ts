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
process.env.PI_AGENT_DIR=join(root,'agent');process.env.PI_OFFLINE='1';process.env.TROUBLEMAKER_PROMPT_PROFILE='compact';
const requests:any[]=[];const events:any[]=[];
const server=createServer(async(req,res)=>{
 let body='';for await(const c of req)body+=c;requests.push(JSON.parse(body));const n=requests.length;
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const emit=(delta:any,finish_reason:any=null)=>res.write(`data: ${JSON.stringify({id:`example-${n}`,object:'chat.completion.chunk',created:1,model:'example-model',choices:[{index:0,delta,finish_reason}]})}\n\n`);
 if(n<3){
 const name=n===1?'search_tools':'call_tool';
 const args=n===1?{query:'handoff_context',label:'Find context handoff'}:{name:'handoff_context',arguments:{label:'Hand off synthetic task',summary:'Synthetic task: return fixture complete.',nextSteps:'Return fixture complete',continue:true}};
 emit({role:'assistant',tool_calls:[{index:0,id:`example-call-${n}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});emit({},'tool_calls');
 }else{emit({role:'assistant',content:'Fixture complete.'});emit({},'stop');}
 res.end('data: [DONE]\n\n');
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
try{
 const address=server.address();assert(address&&typeof address!=='string');
 writeFileSync(join(root,'models.json'),JSON.stringify({providers:{example:{baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'example-key',api:'openai-completions',models:[{id:'example-model',name:'Example',reasoning:false,input:['text'],contextWindow:32768,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 writeFileSync(join(root,'settings.json'),JSON.stringify({defaultProvider:'example',defaultModel:'example-model',compaction:{enabled:true,mode:'handoff',reserveTokens:1000,keepRecentTokens:256}}));
 const noop=async()=>{};const ctx:any={message:{text:'Hand off and continue fixture',rawText:'Hand off and continue fixture',user:'example-user',channel:'example-channel',ts:'1',attachments:[]},channels:[],users:[],respond:noop,sendFinalResponse:noop,respondInThread:noop,setTyping:noop,uploadFile:noop,setWorking:noop,deleteMessage:noop,restartWorking:noop,emitContentBlock:(e:any)=>events.push(e)};
 const runner=await getOrCreateRunner({type:'host'},join(root,'awareness'),'Be concise.');
 const result=await runner.run(ctx,new ChannelStore({workingDir:root,botToken:''}));
 assert.equal(result.stopReason,'stop');assert.equal(requests.length,3,'tool should rotate without another summarization call');
 const transitions=readContextTransitions(root);assert.equal(transitions.length,1);assert.equal(transitions[0].state,'completed');assert.equal(transitions[0].trigger,'agent');
 assert(events.some(e=>e.contextTransition?.state==='completed'));
 const context=readFileSync(join(root,'awareness/context.jsonl'),'utf8');assert(context.includes('troublemaker.continuity-handoff.v1'));
 assert(JSON.stringify(requests[2]).includes('Harness continuation after context rotation'));
 console.log('PASS agent handoff tool rotates and continues with one durable marker');
}finally{server.close();await rm(root,{recursive:true,force:true});}
