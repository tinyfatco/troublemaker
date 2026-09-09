import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inferenceProgressURL, progressFromSnapshot, parseInferenceProgress, watchInferenceProgress } from "../src/inference-progress.js";
import { projectConversationTurnEvent } from "../src/console/conversation-projection.js";
const p={phase:"prefill",processedTokens:512,totalTokens:1024,cachedTokens:0,elapsedSeconds:2};
assert.deepEqual(parseInferenceProgress({...p,secret:"must not propagate"}),p);
for(const bad of [{...p,processedTokens:2048},{...p,totalTokens:0},{...p,cachedTokens:-1},{...p,elapsedSeconds:Infinity},{...p,processedTokens:1.5}]) assert.equal(parseInferenceProgress(bad),undefined);
const snapshot={in_flight:[{prefill_state:{request_id:"example-request",phase:"chunk",tokens_done:512,tokens_total:1024,cached_tokens:0,elapsed_s:2,prompt_preview:"private"}}]};
assert.deepEqual(progressFromSnapshot(snapshot,"example-request"),p);
assert.equal(progressFromSnapshot(snapshot,"another-request"),undefined);
assert.equal(inferenceProgressURL("https://example.com"),undefined);
assert.equal(inferenceProgressURL("http://user:password@localhost"),undefined);
assert.ok(inferenceProgressURL("http://127.0.0.1:1234/v1/mtplx/snapshot"));
const projected=projectConversationTurnEvent({type:"status",status:"processing",processing:{...p,secret:"private"}});
assert.deepEqual(projected,{type:"state",state:"thinking",processing:p});
const server=createServer((_request,response)=>{response.setHeader("Content-Type","application/json");response.end(JSON.stringify(snapshot));});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
try {
	const address=server.address();
	assert.ok(address && typeof address !== "string");
	let samples=0;
	await new Promise<void>((resolve,reject)=>{
		const timeout=setTimeout(()=>{stop();reject(new Error("Progress watcher did not emit"));},3000);
		const stop=watchInferenceProgress(new URL(`http://127.0.0.1:${address.port}`),"example-request",progress=>{
			try {assert.deepEqual(progress,p);samples++;stop();clearTimeout(timeout);resolve();}
			catch(error){stop();clearTimeout(timeout);reject(error);}
		});
	});
	assert.equal(samples,1);
} finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
console.log("inference progress: ok");
