import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceStudioAccountingClient} from '../../lib/voice-studio-accounting-client.js';
const secret='synthetic-local-service-secret-never-a-real-key';
const env={NODE_ENV:'development',VOICE_STUDIO_ACCOUNTING_CALLBACK_URL:'http://127.0.0.1:3117/api/internal/voiceassets/heygen-accounting',
 VOICE_STUDIO_LOCAL_AUDIO_SERVICE_SECRET:secret};
const key='b'.repeat(64);
test('callback client authenticates to the fixed local endpoint and sends only bounded accounting metadata',async()=>{
 const requests=[];const client=createVoiceStudioAccountingClient({env,fetchImpl:async(url,options)=>{
  requests.push({url,options});return new Response(JSON.stringify(options.body.includes('"phase":"claim"')?{ok:true,recorded:true}:{ok:true,recorded:true}),{status:200});}});
 assert.deepEqual(await client.claim({generation_key:key,input_characters:71}),{recorded:true,existing:false});
 assert.deepEqual(await client.outcome({generation_key:key,input_characters:71,dispatch_status:'completed',engine:'elevenlabs',provider_request_id:'synthetic-id'}),{recorded:true});
 assert.equal(requests.length,2);for(const item of requests){assert.equal(item.url,env.VOICE_STUDIO_ACCOUNTING_CALLBACK_URL);assert.equal(item.options.redirect,'error');
  assert.equal(item.options.headers['X-Service-ID'],'voice-assets-qa');assert.equal(item.options.headers.Authorization,`Bearer ${secret}`);
  assert.doesNotMatch(item.options.body,/audio_url|signature=|api.?key/i);}
});
test('callback destination, deployment environment, and secret conflicts fail closed',()=>{
 for(const change of [{VOICE_STUDIO_ACCOUNTING_CALLBACK_URL:'https://127.0.0.1:3117/api/internal/voiceassets/heygen-accounting'},
  {VOICE_STUDIO_ACCOUNTING_CALLBACK_URL:'http://example.test:3117/api/internal/voiceassets/heygen-accounting'},
  {VOICE_STUDIO_ACCOUNTING_CALLBACK_URL:'http://127.0.0.1:3117/other'},
  {NODE_ENV:'production'},{RENDER_SERVICE_NAME:'mss-voice-assets-qa'},
  {INGLE_VOICE_SERVICE_SECRET:secret}])assert.throws(()=>createVoiceStudioAccountingClient({env:{...env,...change},fetchImpl:async()=>{throw Error();}}),{message:'voice_studio_accounting_unavailable'});
});
test('callback errors and redirects are redacted, and no automatic retry occurs',async()=>{
 let calls=0;const client=createVoiceStudioAccountingClient({env,fetchImpl:async()=>{calls++;return new Response('sensitive provider response',{status:302,headers:{location:'https://private.invalid'}});}});
 await assert.rejects(client.claim({generation_key:key,input_characters:71}),{message:'voice_studio_accounting_unavailable'});assert.equal(calls,1);
});
