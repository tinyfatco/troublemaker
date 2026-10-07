import {bodyDigest,PhoneDeliveryUncertainError} from './phone.mjs';

/** Links a verified upstream contact to work without copying its address into model input. */
export class WorkPhone {
 constructor({store,phoneGateway,upstream}) {Object.assign(this,{store,phoneGateway,upstream});}
 async bind(contextId,workId,targetId) {
  if(!this.phoneGateway)throw new Error('Customer messaging unavailable');
  const contact=await this.upstream('actions',{action:'customer_contact',context:contextId,workId});
  if(!/^\+[1-9]\d{7,14}$/.test(contact.phone||''))throw new Error('Invalid verified contact');
  const conversation=this.phoneGateway.ensureConversation(contact.phone);
  const key=`phone-work:${conversation.threadTarget}`;
  const previous=this.store.getMeta(key);
  if(previous&&JSON.parse(previous).contextId!==contextId){
   const old=JSON.parse(previous);
   const state=await this.upstream('actions',{action:'get',context:old.contextId,workId:old.workId});
   if(!['completed','cancelled','refunded'].includes(state.booking?.status))throw new Error('Customer already has active work; operator review required');
  }
  this.store.setMeta(key,JSON.stringify({contextId,workId,targetId}));
  this.store.setMeta(`work-phone:${contextId}`,conversation.threadTarget);
  return {available:true,testMode:!!contact.testMode};
 }
 async send(contextId,workId,targetId,body) {
  const threadTarget=this.store.getMeta(`work-phone:${contextId}`);
  const active=threadTarget&&this.store.getMeta(`phone-work:${threadTarget}`);
  if(!active||JSON.parse(active).contextId!==contextId)throw new Error('Customer messaging not bound to this work');
  const conversation=this.store.getPhoneConversation(threadTarget);
  if(!conversation)throw new Error('Customer conversation unavailable');
  // Revalidate paid state, verified ownership and preview enrollment on every send.
  const contact=await this.upstream('actions',{action:'customer_contact',context:contextId,workId});
  if(this.phoneGateway.ensureConversation(contact.phone).threadTarget!==threadTarget)throw new Error('Customer contact changed');
  if(!['welcome','update'].includes(body.kind))throw new Error('Message kind required');
  if(body.kind==='update'&&!/^[A-Za-z0-9_-]{1,80}$/.test(body.messageKey||''))throw new Error('Stable message key required');
  const key=`work-customer:${workId}:${body.kind}:${body.kind==='welcome'?'once':body.messageKey}`;
  const previous=this.store.getOutbox(key);
  if(previous?.status==='completed')return {accepted:true,duplicate:true};
  const message=typeof body.message==='string'?body.message.trim():'';
  if(!message||message.length>1600)throw new Error('Message must contain 1 to 1600 characters');
  if(contact.testMode&&!/test|sandbox|preview/i.test(message))throw new Error('Test messages must clearly identify the preview');
  if(body.kind==='update'&&this.store.getOutbox(`work-customer:${workId}:welcome:once`)?.status!=='completed')throw new Error('Send the welcome before coordination updates');
  const outbox=this.store.startOutbox({idempotencyKey:key,targetId,contextId,providerThreadId:conversation.providerThreadId,bodySha256:bodyDigest(message)});
  if(outbox.status==='uncertain')throw new Error('Delivery uncertain; operator review required');
  if(!outbox.claimed)throw new Error('Message already being sent');
  let accepted=false;
  try {
   const receipt=await this.phoneGateway.sendDirect(conversation,message);accepted=true;
   this.store.completePhoneOutboxWithLedger(key,receipt.providerMessageId,{
    id:`phone_outbound:${receipt.providerMessageId}`,source:'phone_outbound',providerMessageId:receipt.providerMessageId,
    providerThreadId:conversation.providerThreadId,principalHash:conversation.principalHash,targetId,contextId,
    payload:{direction:'outbound',sender:'Business SMS',recipient:`Phone ending ${conversation.contactLastFour}`,
     message:{id:receipt.providerMessageId,body:message},phone:{threadTarget,displayName:`SMS •••• ${conversation.contactLastFour}`},route:{projectSlug:'work'}},
   });
   this.phoneGateway.controlNotifier?.wake();
   return {accepted:true,status:receipt.status};
  }catch(error){
   if(accepted||error instanceof PhoneDeliveryUncertainError)this.store.markOutboxUncertain(key,'Provider delivery requires review');
   else this.store.failOutbox(key,'Provider delivery failed');
   throw new Error(accepted||error instanceof PhoneDeliveryUncertainError?'Delivery uncertain; do not retry with a new key.':'Customer message failed');
  }
 }
}
