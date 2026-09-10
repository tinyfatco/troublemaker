import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexCliStream, getCodexCliModel, isCodexCliAuthenticated, resetCodexCliSession, buildCodexCliEnvironment } from '../src/codex-cli.js';
import { findModel } from '../src/model-config.js';
const root = mkdtempSync(join(tmpdir(), 'codex-wrapper-test-'));
const fake = join(root, 'codex');
const prior = { ...process.env };
try {
 mkdirSync(join(root, 'awareness'));
 writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'login') process.exit(0);
(async () => {
 let input = ''; for await (const chunk of process.stdin) input += chunk;
 fs.appendFileSync(process.env.TEST_CODEX_LOG, JSON.stringify({args:process.argv.slice(2),input,hasKey:!!process.env.OPENAI_API_KEY})+'\\n');
 const send = value => console.log(JSON.stringify(value));
 if (process.env.TEST_CODEX_MODE === 'malformed') { console.log('invalid'); return; }
 if (process.env.TEST_CODEX_MODE === 'incomplete') return;
 if (process.env.TEST_CODEX_MODE === 'hang') { setInterval(()=>{},1000); return; }
 send({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
 send({type:'item.completed',item:{type:'reasoning',text:'Never speak this'}});
 send({type:'item.completed',item:{type:'agent_message',text:'Hello.'}});
 send({type:'item.completed',item:{type:'agent_message',text:'Done.'}});
 send({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:5}});
})();
`, {mode:0o700});
 process.env.MOM_CODEX_CLI_PATH = fake;
 process.env.TEST_CODEX_LOG = join(root, 'calls.jsonl');
 process.env.OPENAI_API_KEY = 'synthetic-test-key';
 assert.equal(isCodexCliAuthenticated(), true);
 assert.equal(buildCodexCliEnvironment().OPENAI_API_KEY, undefined);
 assert.equal(findModel('codex-cli/example-model')?.provider, 'codex-cli');
 const model = getCodexCliModel('default')!;
 const stream = createCodexCliStream(root);
 const context = {systemPrompt:'Synthetic test instructions.',messages:[{role:'user' as const,content:'First question',timestamp:1}]};
 const first = await stream(model,context).result();
 assert.equal(first.stopReason,'stop');
 assert.deepEqual(first.content,[{type:'text',text:'Hello.\n\nDone.'}]);
 assert.equal(first.usage.input,60); assert.equal(first.usage.totalTokens,105);
 assert.equal(statSync(join(root,'awareness/codex-cli-session.json')).mode & 0o777,0o600);
 await stream(model,{...context,messages:[...context.messages,first,{role:'user',content:'Follow up',timestamp:2}]}).result();
 const calls = readFileSync(process.env.TEST_CODEX_LOG,'utf8').trim().split('\n').map(JSON.parse as any);
 assert.equal(calls[0].hasKey,false);
 assert.equal(calls[1].args.includes('resume'),true);
 assert.equal(calls[1].input.includes('First question'),false);
 assert.equal(calls[1].input.includes('Follow up'),true);
 assert.equal(calls[0].args.join(' ').includes('TROUBLEMAKER_CLAUDE_MCP_TOKEN'),true);
 assert.equal(calls[0].args.join(' ').includes('synthetic-test-key'),false);
 resetCodexCliSession(root);
 for (const mode of ['malformed','incomplete']) {
  process.env.TEST_CODEX_MODE=mode;
  assert.equal((await stream(model,context).result()).stopReason,'error');
 }
 process.env.TEST_CODEX_MODE='hang';
 const controller = new AbortController();
 const pending = stream(model,context,{signal:controller.signal}).result();
 setTimeout(()=>controller.abort(),100);
 assert.equal((await pending).stopReason,'aborted');
 console.log('Codex CLI: auth, text filtering, resume, private state, usage, malformed output, incomplete output, abort passed');
} finally { process.env = prior; rmSync(root,{recursive:true,force:true}); }
