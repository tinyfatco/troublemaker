import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostStore} from '../src/store.mjs';
import {PhoneGateway,PhoneDeliveryUncertainError} from '../src/phone.mjs';
import {ContextRouter} from '../src/router.mjs';
import {WorkPhone} from '../src/work-phone.mjs';
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'work-phone-'));const store=new HostStore(join(directory,'state.db'));const routingKey=Buffer.alloc(32,7);
 const target={id:'operator',driver:'oci'};const config={phone:{provider:'sendly',directOnly:true,senderAddress:'+15555550100',apiKey:'synthetic',apiBaseUrl:'https://example.com',webhookSecret:'synthetic'},routing:{actorTarget:'operator',knownPrincipals:[]},targetsById:new Map([['operator',target]])};
 const gateway=new PhoneGateway({config,store,routingKey,router:new ContextRouter(config,store,routingKey),scheduler:{pump(){}}});let sent=0,fail=false,phone='+15555550123',status='paid';
 gateway.sendDirect=async()=>{sent++;if(fail)throw new PhoneDeliveryUncertainError('Synthetic ambiguity');return {providerMessageId:'synthetic-message',status:'queued'}};
 const customer=new WorkPhone({store,phoneGateway:gateway,upstream:async(op,body)=>body.action==='get'?{booking:{status}}:{phone,testMode:true}});
 return {store,gateway,customer,sent:()=>sent,setFail(){fail=true},setPhone(){phone='+15555550124'},setStatus(v){status=v},close(){store.close();rmSync(directory,{recursive:true,force:true})}};
}
test('welcome is authored, preview labelled, scoped, and accepted once under concurrent retries',async()=>{
 const f=fixture();try{
 await f.customer.bind('example:work','synthetic-work','operator');
 await assert.rejects(()=>f.customer.send('other:work','synthetic-work','operator',{kind:'welcome',message:'Test welcome'}));
 await assert.rejects(()=>f.customer.send('example:work','synthetic-work','operator',{kind:'welcome',message:'Welcome'}));
 await assert.rejects(()=>f.customer.send('example:work','synthetic-work','operator',{kind:'update',messageKey:'first',message:'Test update'}));
 const body={kind:'welcome',message:'Welcome to this test. No driver is dispatched.'};
 const results=await Promise.allSettled([f.customer.send('example:work','synthetic-work','operator',body),f.customer.send('example:work','synthetic-work','operator',body)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.sent(),1);
 assert.equal((await f.customer.send('example:work','synthetic-work','operator',{...body,message:'Rewritten test welcome'})).duplicate,true);assert.equal(f.sent(),1);
 }finally{f.close()}
});
test('ambiguous delivery never retries and verified contact changes block sends',async()=>{
 const f=fixture();try{await f.customer.bind('example:work','synthetic-work','operator');f.setFail();const body={kind:'welcome',message:'Test welcome'};
 await assert.rejects(()=>f.customer.send('example:work','synthetic-work','operator',body),/uncertain/);
 await assert.rejects(()=>f.customer.send('example:work','synthetic-work','operator',body),/uncertain/);assert.equal(f.sent(),1);
 f.setPhone();await assert.rejects(()=>f.customer.send('example:work','synthetic-work','operator',body),/changed/);
 }finally{f.close()}
});
test('a second active booking cannot take over the SMS context',async()=>{
 const f=fixture();try{await f.customer.bind('example:work','synthetic-work','operator');
 await assert.rejects(()=>f.customer.bind('second:work','second-work','operator'),/active work/);
 f.setStatus('completed');await f.customer.bind('second:work','second-work','operator');
 await assert.rejects(()=>f.customer.send('example:work','synthetic-work','operator',{kind:'welcome',message:'Test welcome'}),/not bound/);
 }finally{f.close()}
});
