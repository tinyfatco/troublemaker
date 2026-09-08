import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ComputerOutputStore, COMPUTER_OUTPUT_BYTES } from "../src/tools/computer-output.js";
import { wrapMcpTool } from "../src/mcp-client/wrap-tool.js";
import { readFileSync } from "node:fs";

const tree = 'Application: Example Browser\nWindow: Example Encyclopedia\nURL: https://example.com/article\nSnapshot: example-state\n' +
 Array.from({length: 4000}, (_, i) => `[${i}] AXStaticText ${'Example article prose. '.repeat(6)}`).join('\n') +
 '\n[9001] AXButton "Search"\n[9002] AXTextField "Address"';
const store = new ComputerOutputStore('computer__read_output_detail');
const bounded = store.bound(tree);
assert.ok(Buffer.byteLength(bounded) <= COMPUTER_OUTPUT_BYTES);
assert.match(bounded, /TRUNCATED/);
assert.match(bounded, /Example Browser/);
assert.match(bounded, /Example Encyclopedia/);
assert.match(bounded, /\[9001\] AXButton/);
assert.match(bounded, /\[9002\] AXTextField/);
const id = bounded.match(/result_id:"([^"]+)"/)![1];
assert.match(store.read(id, 1, '[3999]'), /\[3999\]/);
assert.ok(Buffer.byteLength(store.read(id)) <= COMPUTER_OUTPUT_BYTES);
assert.match(store.read(id, 1, 'absent-example'), /No matching/);
assert.match(store.read(id, -1), /positive integer/);
assert.equal(store.bound('Small action result'), 'Small action result');

// Every action uses the same result boundary, including action-returned AX trees,
// structured-only results, multiple content blocks, errors and unknown future tools.
let calls = 0;
for (const action of ['get_app_state', 'click', 'type_text', 'press_key', 'scroll', 'drag', 'open', 'navigate', 'future_action']) {
 for (const variant of [
  {content: [{type: 'text', text: tree}]},
  {content: [{type: 'text', text: tree}, {type: 'text', text: tree}]},
  {structuredContent: {app: 'Example Browser', tree}},
  {isError: true, content: [{type: 'text', text: tree}]},
 ]) {
  const client = {callTool: async () => {calls++; return variant;}} as unknown as Client;
  const tool = wrapMcpTool('computer', {name: action, inputSchema: {type: 'object'}}, client, store);
  const result = await tool.execute('example-call', {label: 'Inspect example state'});
  assert.ok(Buffer.byteLength(JSON.stringify(result.content)) < 10_000);
  const text = (result.content[0] as {text:string}).text;
  assert.ok(Buffer.byteLength(text) <= COMPUTER_OUTPUT_BYTES);
  assert.match(text, /TRUNCATED/);
  assert.match(text, /9001/);
  const resultId = text.match(/result_id:"([^"]+)"/)![1];
  const before = calls;
  await store.tool().execute('example-detail', {label: 'Inspect example element', result_id: resultId, query: '3999'});
  assert.equal(calls, before, 'detail must never replay an action');
 }
}
const throwing = {callTool: async () => {throw new Error(tree);}} as unknown as Client;
const errorResult = await wrapMcpTool('computer', {name:'click', inputSchema:{type:'object'}}, throwing, store)
 .execute('example-error', {label:'Example error'});
assert.ok(Buffer.byteLength((errorResult.content[0] as {text:string}).text) <= COMPUTER_OUTPUT_BYTES);

// Huge single-line strings and multibyte Unicode cannot bypass the byte ceiling.
const single = store.bound('🙂'.repeat(20_000) + ' UNIQUE_TARGET ' + 'x'.repeat(20_000));
const singleId = single.match(/result_id:"([^"]+)"/)![1];
assert.ok(Buffer.byteLength(single) <= COMPUTER_OUTPUT_BYTES);
assert.match(store.read(singleId, 1, 'UNIQUE_TARGET'), /UNIQUE_TARGET/);
assert.doesNotMatch(single, /�/);
let cursor = 0, rebuilt = '';
const original = 'a'.repeat(20_000);
const pageId = store.bound(original).match(/result_id:"([^"]+)"/)![1];
for (let i=0;i<10;i++) {
 const page = store.read(pageId, 1, undefined, cursor);
 assert.ok(Buffer.byteLength(page) <= COMPUTER_OUTPUT_BYTES);
 rebuilt += page.match(/L1(?: column \d+)?: ([a]+)\n/)![1];
 const next = page.match(/column:(\d+)/);
 if (!next) break;
 cursor = Number(next[1]);
}
assert.equal(rebuilt, original, 'pagination must not skip or duplicate characters');
let now=0;
const expiring = new ComputerOutputStore('example_detail', () => now);
const expiredId = expiring.bound(tree).match(/result_id:"([^"]+)"/)![1];
now=16*60*1000;
assert.match(expiring.read(expiredId), /expired/);
for(let i=0;i<17;i++) store.bound(tree);
assert.match(store.read(id), /evicted/);
assert.match(store.bound('x'.repeat(33*1024*1024)), /not retained/);

// Wiring is deliberately server-wide, not an action-name allowlist.
const mcpSource = readFileSync(new URL('../src/mcp-client/bridge.ts', import.meta.url),'utf8');
assert.match(mcpSource, /wrapMcpTool\(config.alias, mcpTool, client, outputStore\)/);
const cuaSource = readFileSync(new URL('../src/cua-driver/bridge.ts', import.meta.url),'utf8');
assert.match(cuaSource, /toAgentResult\(result, this.outputStore\)/);
console.log(JSON.stringify({originalBytes: Buffer.byteLength(tree), boundedBytes: Buffer.byteLength(bounded), reductionPercent: +(100*(1-Buffer.byteLength(bounded)/Buffer.byteLength(tree))).toFixed(2)}));
console.log('Computer output regressions passed');
