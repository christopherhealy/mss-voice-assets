import test from 'node:test';
import assert from 'node:assert/strict';
import {createHeygenSpeech,HOST_TEXT,TIZIANA_ID} from '../../lib/generateSpeech.heygen.js';
import {createVoiceStudioAudioHandler,cacheIdentity} from '../../routes/voice-studio-audio.js';
const profile={approved:true,provider:'heygen',actor:'julie',voice:'tiziana',language:'it',voiceId:TIZIANA_ID,
 engine:'elevenlabs',model:'eleven_multilingual_v2',version:1,settings:{speed:1}};
const signed='https://files.heygen.ai/audio/sample.mp3?signature=synthetic-private-token';
const mp3=Buffer.from('ID3 synthetic audio');
const reply=()=>new Response(JSON.stringify({data:{audio_url:signed,request_id:'request-test',duration:5.4596,engine:'elevenlabs'}}),{status:200});
const audio=()=>new Response(mp3,{status:200,headers:{'content-type':'audio/mpeg'}});
function setup({post=reply,download=audio,persist=async()=>{},resolve=async()=>[{address:'8.8.8.8'}]}={}){
 let posts=0,gets=0,saved=null;const calls=[];
 const generate=createHeygenSpeech({credential:async()=>'synthetic-api-key',resolve,
  request:async(url,options)=>{calls.push({url,options});if(options.method==='POST'){posts++;return post();}gets++;return download(url,options);}});
 return {generate,calls,posts:()=>posts,gets:()=>gets,saved:()=>saved,
  run:()=>generate({text:HOST_TEXT,profile,persistRecovery:async record=>{await persist(record);saved=record;}})};
}
test('HeyGen response persisted before download and adapted to shared buffer contract',async()=>{
 const f=setup({download:()=>{assert.ok(f.saved());return audio();}});const out=await f.run();
 assert.equal(out.buffer.toString(),mp3.toString());assert.equal(out.providerRequestId,'request-test');
 assert.equal(out.durationSeconds,5.4596);assert.equal(out.durationMs,5460);assert.equal(f.saved().audioUrl,signed);
 const body=JSON.parse(f.calls[0].options.body);assert.equal(body.text,HOST_TEXT);assert.equal(body.voice_id,TIZIANA_ID);
 assert.equal(body.settings.model_id,'eleven_multilingual_v2');assert.equal(body.language,'it');assert.equal(body.force_regenerate,false);
 assert.equal(out.actualCostMicrousd,undefined);assert.equal(f.posts(),1);
 assert.equal(f.calls[0].options.redirect,'manual');assert.equal(f.calls[1].options.headers['X-Api-Key'],undefined);
 assert.doesNotMatch(JSON.stringify(out),/signature=|synthetic-api-key/);
});
test('download failure preserves URL and allows download-only recovery',async()=>{
 let fail=true;const f=setup({download:()=>{if(fail)throw Error('signed secret failure');return audio();}});
 await assert.rejects(f.run(),{message:'heygen_audio_unavailable_no_regeneration'});assert.ok(f.saved());
 fail=false;await f.generate.recover({text:HOST_TEXT,profile,recovery:f.saved()});assert.equal(f.posts(),1);assert.equal(f.gets(),2);
});
test('recovery persistence failure prevents audio download and never retries POST',async()=>{
 const f=setup({persist:async()=>{throw Error('private journal detail');}});
 await assert.rejects(f.run(),{message:'heygen_audio_unavailable_no_regeneration'});assert.equal(f.posts(),1);assert.equal(f.gets(),0);
});
test('ambiguous provider dispatch is never retried and errors are redacted',async()=>{
 const f=setup({post:()=>{throw Error('synthetic-api-key raw error');}});
 await assert.rejects(f.run(),{message:'heygen_audio_unavailable_no_regeneration'});assert.equal(f.posts(),1);assert.equal(f.gets(),0);
});
test('generation redirects are not followed',async()=>{
 const f=setup({post:()=>new Response(null,{status:302,headers:{location:'https://other.example'}})});
 await assert.rejects(f.run());assert.equal(f.posts(),1);assert.equal(f.gets(),0);
});
test('legitimate HTTPS audio redirects carry no API credential',async()=>{
 let count=0;const f=setup({download:(url,options)=>{
 assert.deepEqual(options.headers,{Accept:'audio/mpeg'});assert.equal(options.redirect,'manual');
 if(count++===0)return new Response(null,{status:307,headers:{location:'/audio/second.mp3?signature=another'}});
 return audio();}});await f.run();assert.equal(f.gets(),2);assert.equal(f.posts(),1);
});
test('cross-host redirects require an exact server-owned allowlist',async()=>{
 const calls=[];const generate=createHeygenSpeech({credential:async()=>'mock-key',allowedAudioHosts:['files.heygen.ai','cdn.example.test'],
 resolve:async()=>[{address:'8.8.8.8'}],request:async(url,opts)=>{
 calls.push(opts);if(opts.method==='POST')return reply();
 if(calls.length===2)return new Response(null,{status:302,headers:{location:'https://cdn.example.test/audio.mp3'}});
 assert.equal(opts.headers['X-Api-Key'],undefined);return audio();}});
 await generate({text:HOST_TEXT,profile,persistRecovery:async()=>{}});assert.equal(calls.length,3);
});
test('HTTP, userinfo and unapproved redirect destinations are rejected',async()=>{
 for(const location of ['http://files.heygen.ai/x','https://evil.example/x','https://user:pass@files.heygen.ai/x']){
 const f=setup({download:()=>new Response(null,{status:302,headers:{location}})});
 await assert.rejects(f.run());assert.equal(f.gets(),1);}
});
test('private DNS and redirect loops fail closed',async()=>{
 const f=setup({resolve:async()=>[{address:'127.0.0.1'}]});await assert.rejects(f.run());assert.equal(f.gets(),0);
 const g=setup({download:()=>new Response(null,{status:302,headers:{location:'/again'}})});
 await assert.rejects(g.run());assert.equal(g.gets(),4);
});
test('wrong audio content and oversized bytes are rejected',async()=>{
 for(const download of [()=>new Response('<html>bad</html>',{headers:{'content-type':'text/html'}}),
 ()=>new Response('not mp3',{headers:{'content-type':'audio/mpeg'}}),
 ()=>new Response('ID3',{headers:{'content-type':'audio/mpeg','content-length':String(21*1024*1024)}})]){
 const f=setup({download});await assert.rejects(f.run());assert.equal(f.posts(),1);}
});
test('recovery context mismatch cannot download or regenerate',async()=>{
 const f=setup();await f.run();const before=f.calls.length;
 await assert.rejects(f.generate.recover({text:HOST_TEXT,profile,recovery:{...f.saved(),textHash:'other'}}));assert.equal(f.calls.length,before);
});
const env={RENDER_SERVICE_NAME:'mss-voice-assets-qa',VOICE_STUDIO_AUDIO_SERVICE_SECRET:'synthetic-only-distinct-service-secret'};
const request=(operation)=>({method:'POST',headers:{'x-service-id':'voice-studio',authorization:`Bearer ${env.VOICE_STUDIO_AUDIO_SERVICE_SECRET}`},
 body:{application:'voice-studio',actor:'julie',activity:'l2-scripted-host',language:'it',text:HOST_TEXT,profile_version:1,approval_id:operation==='recover'?'recovery-grant':'generation-grant',operation}});
const response=()=>({setHeader(){},status(code){this.code=code;return this;},json(value){this.value=value;return this;}});
function routeFixture({downloadFailure=false,storageFailure=false}={}){
 let failDownload=downloadFailure,failStorage=storageFailure;const records=new Map(),objects=new Map(),f=setup({download:()=>{if(failDownload)throw Error('download failed');return audio();}});
 const journal={get:async key=>records.get(key),claim:async(key,record)=>{if(records.has(key))return false;records.set(key,record);return true;},
 saveRecovery:async(key,recovery)=>{records.set(key,{...records.get(key),recovery});},
 claimRecovery:async key=>{const old=records.get(key);if(old?.status!=='recoverable')return false;records.set(key,{...old,status:'recovering'});return true;},
 finish:async(key,record)=>{records.set(key,record);}};
 const key=cacheIdentity(HOST_TEXT,profile),approval={application:'voice-studio',key,expiresAt:Date.now()+60000,upperBoundMicrousd:100,ceilingMicrousd:100};
 const config={env,enabled:true,profile,journal,generate:f.generate,
 approvals:new Map([['generation-grant',approval]]),recoveryApprovals:new Map([['recovery-grant',approval]]),
 storage:{preflight:async()=>{},write:async(k,b)=>{if(failStorage)throw Error('storage failed');objects.set(k,b);}},
 pipeline:{getOrCreateTextItem:async()=>({id:1}),findExistingAsset:async()=>null,upsertVoiceAsset:async a=>a}};
 let handler=createVoiceStudioAudioHandler(config);
 return {f,config,records,key,objects,reset:()=>{failDownload=false;failStorage=false;handler=createVoiceStudioAudioHandler(config);},
 invoke:async(operation)=>{const res=response();await handler(request(operation),res);return res;}};
}
test('route concurrent generation and ready-cache requests dispatch once',async()=>{
 const f=routeFixture();const results=await Promise.all([f.invoke(),f.invoke(),f.invoke()]);
 assert.ok(results.every(r=>r.value.ok));assert.equal(f.f.posts(),1);
 await f.invoke();assert.equal(f.f.posts(),1);
 assert.doesNotMatch(JSON.stringify(results),/signature=|synthetic-api-key|audioUrl/);
});
for(const kind of ['downloadFailure','storageFailure'])test(`explicit route recovery after ${kind} survives handler restart with no generation`,async()=>{
 const f=routeFixture({[kind]:true});assert.equal((await f.invoke()).code,503);
 assert.equal(f.records.get(f.key).status,'recoverable');assert.ok(f.records.get(f.key).recovery.audioUrl);
 assert.equal((await f.invoke()).code,409);assert.equal(f.f.posts(),1);
 f.reset();const result=await f.invoke('recover');assert.equal(result.value.ok,true);assert.equal(f.f.posts(),1);
 assert.equal(result.value.accounting.providerRequestId,'request-test');assert.equal(result.value.accounting.costStatus,'unknown');
 assert.equal(f.objects.size,1);assert.equal(f.records.get(f.key).status,'ready');
});
test('recovery requires a separate server-side grant, never falls back to paid generation',async()=>{
 const f=routeFixture({downloadFailure:true});await f.invoke();f.config.recoveryApprovals.clear();f.reset();
 assert.equal((await f.invoke('recover')).code,403);assert.equal(f.f.posts(),1);
});

test('missing protected journal writer blocks route before provider dispatch',async()=>{
 const f=routeFixture();delete f.config.journal.saveRecovery;f.reset();
 assert.equal((await f.invoke()).code,503);assert.equal(f.f.posts(),0);
});
