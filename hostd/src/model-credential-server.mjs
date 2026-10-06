#!/usr/bin/env node
// Run under the existing model account owner. Never expose OAuth refresh credentials.
import { createServer } from 'node:http';
import { bearerMatches } from './security.mjs';
const { AuthStorage } = await import(process.env.MODEL_AUTH_MODULE);
const token=process.env.MODEL_CREDENTIAL_TOKEN;
const provider=process.env.MODEL_PROVIDER;
if(!token||!provider)throw new Error('Model credential service is not configured');
const server=createServer(async(req,res)=>{
 res.setHeader('cache-control','no-store');
 if(req.method!=='GET'||req.url!=='/credential'){res.writeHead(404);res.end();return}
 if(!bearerMatches(req.headers.authorization,token)){res.writeHead(401);res.end();return}
 try {
  const key=await AuthStorage.create().getApiKey(provider);
  if(!key){res.writeHead(503);res.end();return}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({provider,key}));
 }catch{res.writeHead(503);res.end()}
});
server.listen(Number(process.env.MODEL_CREDENTIAL_PORT),'127.0.0.1');
