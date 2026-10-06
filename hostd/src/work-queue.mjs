import { stablePrivateKey, contextCapability, bearerMatches } from './security.mjs';

// Host-owned durable work intake. Upstream credentials never enter runtimes.
export class WorkQueue {
 constructor({config,store,routingKey,runtime,zulip,scheduler,fetcher=fetch}) { Object.assign(this,{config,store,routingKey,runtime,zulip,scheduler,fetcher});this.busy=false;
  this.store.database.exec("CREATE TABLE IF NOT EXISTS work_intake (id TEXT PRIMARY KEY, envelope TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0)");
 }
 async upstream(operation,body) {
  const response=await this.fetcher(`${this.config.workQueue.url}/${operation}`,{method:'POST',headers:{authorization:`Bearer ${this.config.workQueue.token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const value=await response.json();if(!response.ok)throw new Error(`Work queue ${operation} failed (${response.status})`);return value;
 }
 async start(){ await this.tick();this.timer=setInterval(()=>void this.tick(),10000); }
 stop(){clearInterval(this.timer)}
 async tick(){
  if(this.busy||this.store.getMeta('scheduler:draining')==='true')return;
  this.busy=true;let job;
  try {
   for(const row of this.store.database.prepare('SELECT envelope FROM work_intake WHERE completed=0 LIMIT 10').all()) { try { await this.accept(JSON.parse(row.envelope)); } catch { /* Reclaim expired upstream leases below. */ } }
   ({job}=await this.upstream('claim',{}));if(!job)return;
   await this.accept(job);
  } catch(error) {
   console.error('hostd work queue:',error.message);
   if(job)await this.upstream('retry',{id:job.id,lease:job.lease}).catch(()=>{});
  } finally {this.busy=false}
 }
 async accept(job){
  if(!job?.work?.id||typeof job.work.id!=='string'||job.work.id.length>100||typeof job.id!=='string'||typeof job.lease!=='string')throw new Error('Invalid work envelope');
  this.store.database.prepare('INSERT INTO work_intake(id,envelope) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope').run(job.id,JSON.stringify(job));
  const hash=stablePrivateKey(this.routingKey,'work',job.work.id);
  const target=this.config.targetsById.get(this.config.workQueue.targetId);
  const contextId=`${target.id}:${hash.slice(0,24)}:work`;
  this.store.ensurePrincipal(hash.slice(0,24),undefined,`Reservation ${job.work.id.slice(0,8)}`);
  const key=`work-binding:${contextId}`;
  const previous=this.store.getMeta(key);
  if(previous&&JSON.parse(previous).workId!==job.work.id)throw new Error('Work binding conflict');
  const provisioned=await this.runtime.provisionOciContext(target,contextId);
  const channel=provisioned.zulip;
  if(!channel)throw new Error('Work queue requires an isolated Zulip channel');
  const eventId=`work:${job.id}`;
  // Binding is durable before acknowledgement; no model wakes until upstream agrees.
  this.store.setMeta(key,JSON.stringify({workId:job.work.id,channelId:channel.channelId,eventId}));
  await this.upstream('ack',{id:job.id,lease:job.lease,context:contextId,channel:Number(channel.channelId),event:eventId});
  this.store.upsertEvent({id:eventId,source:'work',providerMessageId:job.id,providerThreadId:job.work.id,principalHash:hash.slice(0,24),targetId:target.id,contextId,payload:{work:job.work}});
  this.store.database.prepare('UPDATE work_intake SET completed=1 WHERE id=?').run(job.id);
  this.scheduler.pump();
  return {contextId,channelId:channel.channelId,eventId};
 }
 async action(contextId,authorization,body){
  const target=this.config.targetsById.get(contextId.split(':')[0]);
  if(!target||!bearerMatches(authorization,contextCapability(target.outboundToken,'work',contextId)))return {status:401,value:{error:'Unauthorized'}};
  const bindingRaw=this.store.getMeta(`work-binding:${contextId}`);if(!bindingRaw)return {status:403,value:{error:'Not a work context'}};
  const binding=JSON.parse(bindingRaw);
  if(!body||typeof body!=='object'||Array.isArray(body)||!['get','drivers','offer','assign','escalate'].includes(body.action))return {status:400,value:{error:'Invalid work action'}};
  const input={action:body.action,driver:body.driver,context:contextId,workId:binding.workId};
  if(body.action==='assign'){
   if(!Number.isSafeInteger(body.managerMessageId)||body.managerMessageId<=0)return {status:400,value:{error:'Manager message required'}};
   const {message}=await this.zulip.request(`messages/${body.managerMessageId}`);
   if(message?.type!=='stream'||Number(message.stream_id)!==Number(binding.channelId)||message.sender_email?.toLowerCase()!==this.config.workQueue.managerEmail)return {status:403,value:{error:'Acceptance must come from the configured manager in this work channel'}};
   input.manager_ref=`zulip:${body.managerMessageId}`;
  }
  return {status:200,value:await this.upstream('actions',input)};
 }
}
