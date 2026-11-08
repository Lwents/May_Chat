import assert from 'node:assert/strict';
import worker from '../infrastructure/cloudflare/_worker.js';
const originalFetch = globalThis.fetch;
const env = { BACKEND_ORIGIN: 'https://origin.example/may-chat', ORIGIN_TOKEN: 'fixture-only', ASSETS: { fetch: () => new Response('asset') } };
try {
 assert.equal(await (await worker.fetch(new Request('https://app.example/'),env)).text(),'asset');
 assert.equal((await worker.fetch(new Request('https://app.example/api/me'),{})).status,503);
 globalThis.fetch = async request => {
  assert.equal(request.url,'https://origin.example/may-chat/api/test?q=1');
  assert.equal(request.headers.get('cookie'),'may_session=fixture');
  assert.equal(request.headers.get('origin'),'https://app.example');
  assert.equal(request.headers.get('x-may-origin-key'),'fixture-only');
  assert.equal(request.headers.get('x-may-client-ip'),'203.0.113.8');
  assert.equal(request.redirect,'manual');
  assert.equal(await request.text(),'streamed body');
  return new Response('ok',{headers:{'Set-Cookie':'may_session=fixture; Secure; HttpOnly; SameSite=Strict'}});
 };
 const request=new Request('https://app.example/api/test?q=1',{method:'POST',headers:{Cookie:'may_session=fixture',Origin:'https://app.example','CF-Connecting-IP':'203.0.113.8','X-May-Origin-Key':'forged','X-May-Client-IP':'forged'},body:'streamed body'});
 assert.ok((await worker.fetch(request,env)).headers.get('set-cookie').includes('Secure'));
 const upgraded={status:101,webSocket:{fixture:true}};
 globalThis.fetch=async request=>{assert.equal(request.headers.get('upgrade'),'websocket');return upgraded;};
 assert.equal(await worker.fetch(new Request('https://app.example/api/ws',{headers:{Upgrade:'websocket'}}),env),upgraded);
 globalThis.fetch=async()=>{throw Error('private origin details');};
 const failed=await worker.fetch(new Request('https://app.example/api/me'),env);assert.equal(failed.status,502);assert.ok(!(await failed.text()).includes('private origin details'));
 console.log('PASS: Pages proxy preserves streamed body/cookies/origin/WebSocket response, overrides spoofed internal headers and handles unavailable origin.');
}finally{globalThis.fetch=originalFetch;}
