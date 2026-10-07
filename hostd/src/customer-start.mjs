/** Durable website signup intake into the existing scoped SMS conversation. */
export class CustomerStart {
 constructor({store,config,runtime,scheduler,phoneGateway,upstream}){Object.assign(this,{store,config,runtime,scheduler,phoneGateway,upstream});}
 async accept(job){
  if(job?.kind!=='customer_signup'||typeof job.id!=='string'||typeof job.lease!=='string')throw new Error('Invalid customer signup');
  if(!this.phoneGateway)throw new Error('Phone gateway unavailable');
  this.store.database.prepare('INSERT INTO work_intake(id,envelope) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope').run(job.id,JSON.stringify(job));
  const contact=await this.upstream('onboarding_contact',{id:job.id,lease:job.lease});
  if(!/^\+[1-9]\d{7,14}$/.test(contact.phone||''))throw new Error('Verified signup contact unavailable');
  const conversation=this.phoneGateway.ensureConversation(contact.phone);
  const eventId=`customer-signup:${job.id}`;
  const pinned=this.store.getMeta(`customer-start:${job.id}`);
  const workRaw=this.store.getMeta(`phone-work:${conversation.threadTarget}`);
  const work=workRaw?JSON.parse(workRaw):null;
  // Preserve an existing booking conversation instead of competing for replies.
  const route=pinned?JSON.parse(pinned):work||{contextId:conversation.contextId,targetId:conversation.targetId};
  const target=this.config.targetsById.get(route.targetId);
  if(!target)throw new Error('Signup target unavailable');
  this.store.setMeta(`customer-start:${job.id}`,JSON.stringify(route));
  if(this.store.isPhoneOptedOut(conversation.principalHash)){
   await this.upstream('onboarding_ack',{id:job.id,lease:job.lease,context:route.contextId,event:eventId});
   this.store.database.prepare('UPDATE work_intake SET completed=1 WHERE id=?').run(job.id);
   return {skipped:true,reason:'opted_out'};
  }
  const provisioned=await this.runtime.provisionOciContext(target,route.contextId);
  if(!provisioned.zulip)throw new Error('Signup requires a private context channel');
  await this.upstream('onboarding_ack',{id:job.id,lease:job.lease,context:route.contextId,event:eventId});
  this.store.upsertEvent({id:eventId,source:'customer_signup',providerMessageId:job.id,
   providerThreadId:conversation.providerThreadId,principalHash:conversation.principalHash,
   targetId:route.targetId,contextId:route.contextId,payload:{
    signup:{draft:contact.draft||null,welcomeStatus:contact.welcomeStatus||'unknown'},
    phone:{threadTarget:conversation.threadTarget,displayName:`Phone ending ${conversation.contactLastFour}`},
   }});
  this.store.database.prepare('UPDATE work_intake SET completed=1 WHERE id=?').run(job.id);
  this.scheduler.pump();
  return {contextId:route.contextId,eventId};
 }
}
