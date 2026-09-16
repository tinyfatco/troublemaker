import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCodexImage, createImagegenTool } from '../src/tools/imagegen.js';
const root = await mkdtemp(join(tmpdir(), 'imagegen-test-'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
try {
 const command=join(root,'fake-codex');
 await writeFile(command, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{example:{}}}}});
 if(m.method==='thread/start'){
  if(m.params.config['mcp_servers.example.enabled']!==false)process.exit(9);
  send({id:m.id,result:{thread:{id:'synthetic-thread'}}});
 }
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'synthetic-turn'}}});
  const p=m.params.input[0].text;
  if(p==='hang')return;
  if(p==='malformed'){process.stdout.write('bad-json\\n');return;}
  if(p!=='missing')send({method:'item/completed',params:{threadId:'synthetic-thread',item:{type:'imageGeneration',id:'image',status:'completed',result:p==='invalid'?'not an image':'${png}',failure:p==='limit'?{type:'usageLimitExceeded'}:null}}});
  if(p==='early-exit'){process.exit(0);return;}
  send({method:'turn/completed',params:{threadId:'synthetic-thread',turn:{status:p==='failed'?'failed':'completed'}}});
 }
});
`, {mode:0o700});
 const options={command,timeoutMs:3000};
 const paths=await generateCodexImage(root,'success',[],undefined,options);
 assert.equal(paths.length,1); assert.deepEqual(await readFile(paths[0]),Buffer.from(png,'base64'));
 const edited=await generateCodexImage(root,'edit',[paths[0]],undefined,options);assert.notEqual(edited[0],paths[0]);
 for(const [prompt,pattern] of [['early-exit',/exited before/],['missing',/no generated image/],['invalid',/valid image bytes/],['limit',/usage limit/],['failed',/failed or was interrupted/],['malformed',/malformed/]] as const){
  await assert.rejects(generateCodexImage(root,prompt,[],undefined,options),pattern);
 }
 await assert.rejects(generateCodexImage(root,'hang',[],undefined,{command,timeoutMs:150}),/timed out/);
 const controller=new AbortController();setTimeout(()=>controller.abort(),100);
 await assert.rejects(generateCodexImage(root,'hang',[],controller.signal,options),/cancelled/);
 await assert.rejects(generateCodexImage(root,' ',[],undefined,options),/nonblank/);
 await symlink('/etc/hosts',join(root,'outside.png'));
 await assert.rejects(generateCodexImage(root,'edit',['outside.png'],undefined,options),/inside this workspace/);
 assert.equal(createImagegenTool(root).name,'imagegen');
 console.log('imagegen: generation, edits, MCP isolation, errors, limits, timeout, cancellation, and reference boundaries passed');
} finally { await rm(root,{recursive:true,force:true}); }
