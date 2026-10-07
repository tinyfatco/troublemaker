import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostStore} from '../src/store.mjs';
import {CustomerStart} from '../src/customer-start.mjs';
import {RuntimeManager} from '../src/runtime.mjs';
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'signup-test-'));const store=new HostStore(join(directory,'state.db'));
 store.database.exec('CREATE TABLE work_intake (id TEXT PRIMARY KEY,envelope TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0)');
 const conversation={threadTarget:'phone-synthetic',providerThreadId:'synthetic-thread',principalHash:'synthetic-principal',targetId:'operator',contextId:'operator:synthetic:phone',contactLastFour:'0123'};
 const target={id:'operator'};let fail=false,pumps=0,optout=false;
 store.isPhoneOptedOut=()=>optout;
 const intake=new CustomerStart({store,config:{targetsById:new Map([['operator',target]])},runtime:{async provisionOciContext(t,id){if(!store.getContext(id))store.createContext({id,targetId:t.id,driver:'oci',runtimeName:'synthetic-runtime',port:12000});return {zulip:{channelId:123}}}},scheduler:{pump(){pumps++}},phoneGateway:{ensureConversation:()=>conversation},upstream:async op=>{if(op==='onboarding_contact')return {phone:'+15555550123',draft:{name:'Example Customer'},welcomeStatus:'accepted'};if(fail)throw new Error('Synthetic ack failure');return {ok:true}}});
 const job={kind:'customer_signup',id:'11111111-1111-4111-8111-111111111111',lease:'22222222-2222-4222-8222-222222222222'};
 return {store,intake,job,conversation,pumps:()=>pumps,setFail:v=>fail=v,setOptOut:v=>optout=v,close(){store.close();rmSync(directory,{recursive:true,force:true})}};
}
test('signup wakes one scoped event after durable ack and excludes raw contact data',async()=>{
 const f=fixture();try{
 f.setFail(true);await assert.rejects(()=>f.intake.accept(f.job));assert.equal(f.pumps(),0);assert.equal(f.store.database.prepare('SELECT count(*) n FROM events').get().n,0);
 f.setFail(false);await f.intake.accept(f.job);await f.intake.accept(f.job);
 const rows=f.store.database.prepare('SELECT * FROM events').all();assert.equal(rows.length,1);assert.equal(rows[0].source,'customer_signup');assert.ok(!JSON.stringify(rows).includes('+15555550123'));
 assert.equal(f.store.database.prepare('SELECT completed FROM work_intake').get().completed,1);
 }finally{f.close()}
});
test('signup preserves an existing booking conversation and retries cannot change its route',async()=>{
 const f=fixture();try{
 f.store.setMeta('phone-work:phone-synthetic',JSON.stringify({contextId:'operator:synthetic:work',targetId:'operator',workId:'synthetic-work'}));
 const first=await f.intake.accept(f.job);assert.equal(first.contextId,'operator:synthetic:work');
 f.store.setMeta('phone-work:phone-synthetic',JSON.stringify({contextId:'operator:other:work',targetId:'operator'}));
 assert.equal((await f.intake.accept(f.job)).contextId,first.contextId);
 }finally{f.close()}
});
test('opted-out contacts do not wake an agent or send a message',async()=>{
 const f=fixture();try{f.setOptOut(true);assert.equal((await f.intake.accept(f.job)).skipped,true);assert.equal(f.pumps(),0);assert.equal(f.store.database.prepare('SELECT count(*) n FROM events').get().n,0)}finally{f.close()}
});
test('signup model event is labelled internal and distinguishes existing work from an unpaid draft',async()=>{
 let sent,work=false;
 const runtime=new RuntimeManager({targetsById:new Map([['operator',{}]])},{getZulipBinding:()=>({channelId:123,channelName:'Synthetic'}),getMeta:()=>work?'bound':null});
 runtime.ensureOciContext=async()=>({});runtime.deliverZulipWebhook=async(t,c,e,p)=>{sent=p};
 const event={source:'customer_signup',targetId:'operator',contextId:'operator:synthetic:phone',providerMessageId:'synthetic-event',awarenessSequence:7,payloadJson:JSON.stringify({phone:{threadTarget:'phone-synthetic'},signup:{draft:{notes:'Untrusted note'},welcomeStatus:'accepted'}})};
 await runtime.acceptEvent(event);assert.equal(sent.message.id,-7);assert.match(sent.message.raw_content,/not a customer-authored SMS/);assert.match(sent.message.raw_content,/Do not repeat it/);assert.match(sent.message.raw_content,/UNTRUSTED/);assert.match(sent.message.raw_content,/phone-synthetic/);
 work=true;await runtime.acceptEvent(event);assert.match(sent.message.raw_content,/message_customer kind update/);
});
