import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelInfo, MomContext, MomEvent, MomHandler, PlatformAdapter, RunResult, UserInfo } from "../adapters/types.js";
import type { ChannelStore } from "../store.js";
import type { VoiceIdentity, VoiceResponsePolicy } from "./voice-session-contract.js";
import type { VoiceCanonicalPrepared, VoiceCanonicalReply, VoiceCanonicalSubmitter } from "./voice-session-runtime.js";

const COMPUTER_CHANNEL = "ios";
const COMPUTER_USER = "computer-user";

/** Canonical agent adapter for the authenticated Computer voice-session route. */
export class ComputerVoiceCanonicalSubmitter implements VoiceCanonicalSubmitter {
	constructor(private readonly handler: MomHandler, private readonly workingDir: string) {}
	async prepare(input: {
		identity: VoiceIdentity;
		text: string;
		responsePolicy: VoiceResponsePolicy;
		relationshipId?: string;
	}): Promise<VoiceCanonicalPrepared> {
		const completionID = `completion-${createHash("sha256").update(`${input.identity.session_id}\n${input.identity.delivery_id}`).digest("hex").slice(0, 32)}`;
		let dispatched: Promise<VoiceCanonicalReply> | undefined;
		return { completionID, dispatch: () => dispatched ??= this.dispatch(input) };
	}
	private async dispatch(input: {
		identity: VoiceIdentity;
		text: string;
		responsePolicy: VoiceResponsePolicy;
		relationshipId?: string;
	}): Promise<VoiceCanonicalReply> {
		const queue = new SnapshotQueue();
		let resolveFinal!: (value: { text: string; speechEligible: boolean }) => void;
		let rejectFinal!: (error: Error) => void;
		let settled = false;
		const final = new Promise<{ text: string; speechEligible: boolean }>((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
		const adapter = new ComputerVoiceCanonicalAdapter(this.workingDir, input.responsePolicy, (text) => {
			if (settled) return;
			const clean = text.trim();
			if (!clean) return;
			settled = true;
			queue.push({ text: clean, speechEligible: true });
			queue.close();
			resolveFinal({ text: clean, speechEligible: true });
		});
		const event: MomEvent = {
			type: "dm", channel: COMPUTER_CHANNEL, ts: String(Date.now()), user: COMPUTER_USER,
			text: input.text, rawText: input.text, sessionId: input.identity.session_id,
			deliveryId: input.identity.delivery_id, sourceEventType: "computer_voice_session",
			relationshipId: input.relationshipId,
			...(input.responsePolicy === "concise_watch"
				? { contextProjection: "concise_watch" as const }
				: {}),
			directlyAddressed: true,
		};
		adapter.logInbound(event);
		void this.handler.handleEvent(event, adapter).then((result) => {
			if (!settled && result?.stopReason === "error") throw new Error(safeRunError(result));
			if (!settled) throw new Error("Canonical voice turn completed without a final response");
		}).catch((error: unknown) => {
			if (settled) return;
			settled = true;
			queue.close();
			rejectFinal(error instanceof Error ? error : new Error("Canonical voice turn failed"));
		});
		return { partials: queue, final };
	}
}

class SnapshotQueue implements AsyncIterable<{ text: string; speechEligible: boolean }> {
	private values: Array<{ text: string; speechEligible: boolean }> = [];
	private waiters: Array<(value: IteratorResult<{ text: string; speechEligible: boolean }>) => void> = [];
	private ended = false;
	push(value: { text: string; speechEligible: boolean }): void { const waiter=this.waiters.shift();if(waiter)waiter({done:false,value});else this.values.push(value); }
	close(): void { this.ended=true;for(const waiter of this.waiters.splice(0))waiter({done:true,value:undefined}); }
	[Symbol.asyncIterator](): AsyncIterator<{ text: string; speechEligible: boolean }> { return { next:()=>{const value=this.values.shift();if(value)return Promise.resolve({done:false,value});if(this.ended)return Promise.resolve({done:true,value:undefined});return new Promise((resolve)=>this.waiters.push(resolve));} }; }
}

class ComputerVoiceCanonicalAdapter implements PlatformAdapter {
	readonly name = "computer-voice-session";
	readonly maxMessageLength = 100_000;
	readonly formatInstructions: string;
	private readonly users: UserInfo[] = [{ id: COMPUTER_USER, userName: "computer-user", displayName: "Computer user" }];
	constructor(private readonly workingDir: string, policy: VoiceResponsePolicy, private readonly finish: (text: string) => void) {
		this.formatInstructions = policy === "concise_watch"
			? "## Apple Watch voice\nAnswer ordinary requests very briefly and naturally for speech. Preserve uncertainty, required confirmations, refusals, exact errors, and safety-critical content."
			: "## Computer voice\nAnswer naturally for a spoken interface. Keep operational tool details silent unless the user explicitly asks for them.";
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async postMessage(_channel:string,text:string):Promise<string>{this.finish(text);return String(Date.now());}
	async updateMessage():Promise<void>{}
	async deleteMessage():Promise<void>{}
	async postInThread(_channel:string,_thread:string,text:string):Promise<string>{this.finish(text);return String(Date.now());}
	async uploadFile():Promise<void>{}
	logInbound(event:MomEvent):void{this.logToFile({date:new Date().toISOString(),ts:event.ts,channel:`computer:${event.channel}`,channelId:event.channel,user:event.user,userName:"computer-user",text:event.text,attachments:[],isBot:false,adapter:this.name,deliveryId:event.deliveryId,sessionId:event.sessionId});}
	logToFile(entry:object):void{try{appendFileSync(join(this.workingDir,"log.jsonl"),`${JSON.stringify(entry)}\n`);}catch{}}
	logBotResponse(channel:string,text:string,ts:string):void{this.logToFile({date:new Date().toISOString(),ts,channel:`computer:${channel}`,channelId:channel,user:"agent",text,attachments:[],isBot:true,adapter:this.name});}
	getUser(id:string):UserInfo|undefined{return this.users.find((user)=>user.id===id);}
	getChannel(id:string):ChannelInfo|undefined{return id===COMPUTER_CHANNEL?{id,name:"Computer"}:undefined;}
	getAllUsers():UserInfo[]{return [...this.users];}
	getAllChannels():ChannelInfo[]{return [{id:COMPUTER_CHANNEL,name:"Computer"}];}
	createContext(event:MomEvent,_store:ChannelStore):MomContext{return {
		message:{text:event.text,rawText:event.rawText??event.text,user:event.user,userName:"computer-user",channel:event.channel,ts:event.ts,sessionId:event.sessionId,eventType:event.type,sourceEventType:event.sourceEventType,contextProjection:event.contextProjection,deliveryId:event.deliveryId,directlyAddressed:true,attachments:[]},
		channelName:"Computer",channels:this.getAllChannels(),users:this.getAllUsers(),
		respond:async()=>{},sendFinalResponse:async(text)=>{this.finish(text);},respondInThread:async(text)=>{this.finish(text);},setTyping:async()=>{},uploadFile:async()=>{},setWorking:async()=>{},deleteMessage:async()=>{},restartWorking:async()=>{},emitContentBlock:()=>{},
	};}
	enqueueEvent():boolean{return false;}
}
function safeRunError(result:RunResult):string{const text=(result.errorMessage||"Canonical voice turn failed").replace(/Bearer\s+\S+/gi,"Bearer [redacted]").replace(/\b(?:sk|sess|ghp|gho|github_pat)_[A-Za-z0-9._~+/=-]{12,}\b/g,"[redacted-token]");return text.slice(0,500);}
