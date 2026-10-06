import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from '../src/store.mjs';
import { WorkQueue } from '../src/work-queue.mjs';
import { contextCapability } from '../src/security.mjs';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'work-test-')); const store=new HostStore(join(dir,'state.db')); const close=store.close.bind(store);store.close=()=>{close();rmSync(dir,{recursive:true,force:true})};let failAck=false;let pumps=0;const calls=[];
 const target={id:'operator',outboundToken:'synthetic-secret'};
 const config={routing:{actorTarget:'operator'},targetsById:new Map([['operator',target]]),workQueue:{targetId:'operator',url:'https://example.com/work',token:'synthetic-token',managerEmail:'manager@example.com'}};
 const runtime={async provisionOciContext(t,id){if(!store.getContext(id))store.createContext({id,targetId:t.id,driver:'oci',runtimeName:'example-runtime',port:12345});return {zulip:{channelId:123}}}};
 let message={type:'stream',stream_id:123,sender_email:'manager@example.com'};
 const queue=new WorkQueue({config,store,routingKey:Buffer.alloc(32,1),runtime,zulip:{async request(){return {message}}},scheduler:{pump(){pumps++}},fetcher:async(url,req)=>{calls.push({url,body:JSON.parse(req.body)});return Response.json(url.endsWith('/claim')?{job:null}:{ok:true},{status:failAck&&url.endsWith('/ack')?503:200})}});
 const job={id:'11111111-1111-4111-8111-111111111111',lease:'22222222-2222-4222-8222-222222222222',work:{id:'33333333-3333-4333-8333-333333333333',test_mode:true}};
 return {store,queue,job,calls,target,setFail(v){failAck=v},setMessage(v){message=v},pumps:()=>pumps};
}
test('durable acknowledgement before wake; duplicate delivery creates one event',async()=>{
 const f=fixture();f.setFail(true);await assert.rejects(()=>f.queue.accept(f.job));assert.equal(f.pumps(),0);assert.equal(f.store.database.prepare('SELECT count(*) n FROM events').get().n,0);
 assert.equal(f.store.database.prepare('SELECT completed FROM work_intake').get().completed,0);
 f.setFail(false);await f.queue.tick();await f.queue.accept(f.job);
 assert.equal(f.store.database.prepare('SELECT count(*) n FROM events').get().n,1);assert.equal(f.store.database.prepare('SELECT completed FROM work_intake').get().completed,1);
 f.store.close();
});
test('scope cannot be swapped and assignment verifies manager and channel',async()=>{
 const f=fixture();const {contextId}=await f.queue.accept(f.job);const auth=`Bearer ${contextCapability(f.target.outboundToken,'work',contextId)}`;
 assert.equal((await f.queue.action(contextId,'Bearer wrong',{action:'get'})).status,401);
 assert.equal((await f.queue.action(contextId,auth,{action:'assign',driver:'example'})).status,400);
 f.setMessage({type:'stream',stream_id:999,sender_email:'manager@example.com'});assert.equal((await f.queue.action(contextId,auth,{action:'assign',managerMessageId:42})).status,403);
 f.setMessage({type:'stream',stream_id:123,sender_email:'customer@example.com'});assert.equal((await f.queue.action(contextId,auth,{action:'assign',managerMessageId:42})).status,403);
 f.setMessage({type:'stream',stream_id:123,sender_email:'manager@example.com'});assert.equal((await f.queue.action(contextId,auth,{action:'assign',managerMessageId:42,workId:'another',context:'another'})).status,200);
 const body=f.calls.at(-1).body;assert.equal(body.workId,f.job.work.id);assert.equal(body.context,contextId);assert.equal(body.manager_ref,'zulip:42');f.store.close();
});
test('crash after upstream ack recovers from the host journal without another upstream claim',async()=>{
 const f=fixture();const original=f.store.upsertEvent.bind(f.store);let once=true;
 f.store.upsertEvent=(e)=>{if(once){once=false;throw new Error('synthetic crash')}return original(e)};
 await assert.rejects(()=>f.queue.accept(f.job));assert.equal(f.pumps(),0);
 await f.queue.tick();assert.equal(f.store.database.prepare('SELECT count(*) n FROM events').get().n,1);assert.equal(f.pumps(),1);f.store.close();
});
