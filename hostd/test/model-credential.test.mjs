import assert from 'node:assert/strict';
import test from 'node:test';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
test('model broker requires host authentication and returns only the short-lived key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'credential-test-'));const module=join(dir,'auth.mjs');
 writeFileSync(module,'export class AuthStorage { static create() { return {getApiKey: async()=>"synthetic-access"}; } }');
 const child=fork(new URL('../src/model-credential-server.mjs',import.meta.url),[],{env:{...process.env,MODEL_AUTH_MODULE:pathToFileURL(module).href,MODEL_PROVIDER:'example-provider',MODEL_CREDENTIAL_TOKEN:'synthetic-host-token',MODEL_CREDENTIAL_PORT:'0'},stdio:['ignore','ignore','ignore','ipc']});
 try {const [{port}]=await once(child,'message');const url=`http://127.0.0.1:${port}/credential`;
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{authorization:'Bearer wrong'}})).status,401);
 const r=await fetch(url,{headers:{authorization:'Bearer synthetic-host-token'}});assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{provider:'example-provider',key:'synthetic-access'});
 assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer synthetic-host-token'}})).status,404);
 }finally{child.kill();await once(child,'exit');rmSync(dir,{recursive:true,force:true})}
});
