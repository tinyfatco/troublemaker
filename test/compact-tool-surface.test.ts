import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { compactToolContext, restoreCompactToolCalls, restoreCompactToolStream } from "../src/core/compact-tool-surface.js";
const model: Model<"openai-completions"> = { id:"example-model",name:"Example",provider:"example",api:"openai-completions",baseUrl:"https://example.com",reasoning:false,input:["text"],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
const empty:AssistantMessage={role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,stopReason:"stop",timestamp:1,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
const search={name:"search_tools",description:"Discover tools",parameters:Type.Object({query:Type.String()})};
const original:AssistantMessage={...empty,content:[{type:"toolCall",id:"example-call",name:"example_tool",arguments:{value:"hello"}}],stopReason:"toolUse"};
const before=compactToolContext({systemPrompt:"Stable",messages:[original],tools:[search]});
const after=compactToolContext({systemPrompt:"Stable",messages:[original],tools:[search,{name:"example_tool",description:"Large documentation".repeat(1000),parameters:Type.Object({value:Type.String()})}]});
assert.deepEqual(before,after,"tool discovery must not rewrite the provider prefix");
assert.deepEqual(restoreCompactToolCalls(before.messages[0] as AssistantMessage),original);
assert.equal(original.content[0].type === "toolCall" && original.content[0].name,"example_tool","projection must not mutate durable history");
for(const mode of ["normal","blocked","invalid","truncated"] as const){
 let executions=0,calls=0,hooks=0;
 const agent=new Agent({initialState:{model,tools:[{name:"example_tool",label:"Example tool",description:"Example",parameters:Type.Object({value:Type.String()}),execute:async()=>{executions++;return {content:[{type:"text",text:"ok"}],details:{}};}}]},streamFn:()=>{
  const source=createAssistantMessageEventStream();
  const first=++calls===1;
  const message:AssistantMessage=first?{...empty,stopReason:mode==="truncated"?"length":"toolUse",content:[{type:"toolCall",id:"example-call",name:"call_tool",arguments:{name:"example_tool",arguments:mode==="invalid"?{}:{value:"hello"}}}]}:{...empty,content:[{type:"text",text:"Done"}]};
  source.push({type:"done",reason:message.stopReason as "stop"|"length"|"toolUse",message});source.end(message);
  return restoreCompactToolStream(source,empty);
 }});
 agent.beforeToolCall=async({toolCall})=>{hooks++;assert.equal(toolCall.name,"example_tool");return mode==="blocked"?{block:true,reason:"Example policy"}:undefined;};
 await agent.prompt("Run example tool");
 assert.equal(executions,mode==="normal"?1:0,mode);
 assert.equal(hooks,mode==="normal"||mode==="blocked"?1:0,mode);
 const result=agent.state.messages.find(m=>m.role==="toolResult");
 assert.ok(result && result.role==="toolResult");
 assert.equal(result.isError,mode!=="normal");
}
console.log("compact tool surface: prefix, native validation, blocking, truncation: ok");
