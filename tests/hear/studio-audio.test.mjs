import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceStudioAudioHandler,cacheIdentity,SYNTHETIC_TEXT} from '../../routes/voice-studio-audio.js';
const env={RENDER_SERVICE_NAME:'mss-voice-assets-qa',VOICE_STUDIO_AUDIO_SERVICE_SECRET:'synthetic-service-secret-not-a-real-credential'};
const profile={approved:true,provider:'heygen',actor:'julie',voice:'tiziana',language:'it',voiceId:'mock-only-not-verified',engine:'mock-engine',model:'mock-model',version:1,settings:{speed:1}};
const body={application:'voice-studio',actor:'julie',activity:'l2-scripted-host',language:'it',text:SYNTHETIC_TEXT,profile_version:1,approval_id:'test-grant'};
const req=(b=body)=>({method:'POST',headers:{authorization:`Bearer ${env.VOICE_STUDIO_AUDIO_SERVICE_SECRET}`,'x-service-id':'voice-studio'},body:b});
const res=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.data=data;return this;},send(data){this.data=data;return this;}});
function setup(options={}){
 const records=new Map(),objects=new Map();let calls=0,claimCalls=0;
 const key=cacheIdentity(SYNTHETIC_TEXT,profile);
 const journal={get:async k=>records.get(k),claim:async(k,v)=>{claimCalls++;if(records.has(k))return false;records.set(k,v);return true;},finish:async(k,v)=>{records.set(k,v);}};
 const storage={preflight:async()=>{},write:async(k,b)=>{objects.set(k,b);},read:async k=>objects.get(k)};
 const pipeline={getOrCreateTextItem:async()=>({id:1}),findExistingAsset:async()=>null,upsertVoiceAsset:async data=>({id:1,...data})};
 // Exercise the real shared pipeline with mocked IO. Dynamic import does not connect to anything.
 const render=async args=>(await import('../../lib/getOrCreateVoiceAsset.js')).getOrCreateVoiceAsset(args);
 const generate=async args=>{calls++;assert.equal(args.text,SYNTHETIC_TEXT);assert.equal(args.profile.language,'it');return {buffer:Buffer.from('synthetic mp3'),actualCostMicrousd:20,providerRequestId:'mock-request',usage:{characters:46}};};
 const approvals=new Map([['test-grant',{key,application:'voice-studio',expiresAt:Date.now()+60000,ceilingMicrousd:100,upperBoundMicrousd:80}]]);
 const config={env,enabled:true,profile,approvals,journal,storage,pipeline,generate,render,...options};
 return {handler:createVoiceStudioAudioHandler(config),config,key,records,objects,calls:()=>calls,claims:()=>claimCalls};
}
async function invoke(f,request=req()){const r=res();await f.handler(request,r);return r;}
test('distinct service identity rejects absent, wrong, and Ingle identities',async()=>{
 for(const headers of [{},{...req().headers,authorization:'Bearer wrong'},{...req().headers,'x-service-id':'ingle'}]){
 const f=setup();assert.equal((await invoke(f,{...req(),headers})).code,401);assert.equal(f.calls(),0);}
});
test('default adapter and production destination cannot generate',async()=>{
 assert.equal((await invoke({handler:createVoiceStudioAudioHandler({env})})).code,503);
 assert.equal((await invoke(setup({env:{...env,RENDER_SERVICE_NAME:'production'}}))).code,404);
});
test('unapproved and incompatible profiles fail closed',async()=>{
 for(const p of [null,{...profile,approved:false},{...profile,provider:'elevenlabs'},{...profile,language:'en'},{...profile,voiceId:''}]){
 const f=setup({profile:p});assert.equal((await invoke(f)).code,403);assert.equal(f.calls(),0);}
});
test('Italian synthetic actor activity and profile scope enforced',async()=>{
 for(const b of [{...body,language:'en'},{...body,actor:'marco'},{...body,text:'learner private content'},{...body,application:'fluently'},{...body,profile_version:2}]){
 const f=setup();assert.equal((await invoke(f,req(b))).code,400);assert.equal(f.calls(),0);}
});
test('client approval cannot replace server approval or spending bound',async()=>{
 for(const override of [{approvals:new Map()}, {approvals:new Map([['test-grant',{key:cacheIdentity(SYNTHETIC_TEXT,profile),application:'voice-studio',expiresAt:Date.now()+10000,ceilingMicrousd:10,upperBoundMicrousd:20}]])}]){
 const f=setup(override);assert.equal((await invoke(f,req({...body,approved:true}))).code,403);assert.equal(f.calls(),0);}
});
test('cache identity changes with provider configuration and exact text',()=>{
 const key=cacheIdentity(SYNTHETIC_TEXT,profile);
 for(const p of [{...profile,engine:'other'},{...profile,model:'other'},{...profile,version:2},{...profile,settings:{speed:2}},{...profile,voiceId:'other'}])assert.notEqual(cacheIdentity(SYNTHETIC_TEXT,p),key);
 assert.notEqual(cacheIdentity(SYNTHETIC_TEXT+' ',profile),key);
});
test('shared pipeline caches sequential and simultaneous requests with private retrieval',async()=>{
 const f=setup();const results=await Promise.all(Array.from({length:6},()=>invoke(f)));
 assert.equal(f.calls(),1);assert.equal(f.claims(),1);assert.ok(results.every(r=>r.data.ok));
 assert.equal((await invoke(f)).data.cache_hit,true);assert.equal(f.calls(),1);
 const get={...req(),method:'GET',query:{asset_id:results[0].data.asset_id}};
 assert.equal((await invoke(f,get)).data.toString(),'synthetic mp3');
 assert.equal((await invoke(f,{...get,headers:{...get.headers,'x-service-id':'other'}})).code,401);
 assert.equal((await invoke(f,{...get,query:{asset_id:'studio:'+ '0'.repeat(64)}})).code,404);
 assert.equal(JSON.stringify(results).includes('https://'),false);
 assert.equal(results[0].data.accounting.costStatus,'actual');
 assert.equal(results[0].data.accounting.providerRequestId,'mock-request');
});
test('storage preflight failure performs no dispatch or claim',async()=>{
 const f=setup({storage:{preflight:async()=>{throw Error('private detail');}}});
 assert.equal((await invoke(f)).code,503);assert.equal(f.calls(),0);assert.equal(f.claims(),0);
});
test('post-generation failure records uncertain accounting and prevents retry including new handler',async()=>{
 const f=setup();f.config.storage.write=async()=>{throw Error('secret storage error');};
 const result=await invoke(f);assert.equal(result.code,503);assert.equal(f.calls(),1);
 assert.equal(f.records.get(f.key).status,'uncertain');assert.equal(f.records.get(f.key).accounting.actualMicrousd,20);
 assert.equal((await invoke(f)).code,409);
 f.handler=createVoiceStudioAudioHandler(f.config);assert.equal((await invoke(f)).code,409);assert.equal(f.calls(),1);
 assert.doesNotMatch(JSON.stringify(result),/secret storage error/);
});
test('unknown dispatch outcomes retain unknown cost and block retry',async()=>{
 const f=setup({generate:async()=>{throw Error('provider secret');}});
 assert.equal((await invoke(f)).code,503);assert.equal(f.records.get(f.key).accounting.costStatus,'unknown');
 assert.equal((await invoke(f)).code,409);
});
test('estimated and unknown provider costs remain distinct',async()=>{
 for(const [metadata,status] of [[{estimatedCostMicrousd:25},'estimated'],[{},'unknown']]){
 const f=setup({generate:async()=>({buffer:Buffer.from('mock'),...metadata})});
 assert.equal((await invoke(f)).data.accounting.costStatus,status);}
});
test('preexisting in-flight durable marker is never redispatched',async()=>{
 const f=setup();f.records.set(f.key,{application:'voice-studio',status:'dispatching'});
 assert.equal((await invoke(f)).code,409);assert.equal(f.calls(),0);
});

test('reusing the Ingle shared secret is explicitly rejected',async()=>{
 const f=setup({env:{...env,INGLE_VOICE_SERVICE_SECRET:env.VOICE_STUDIO_AUDIO_SERVICE_SECRET}});
 assert.equal((await invoke(f)).code,401);assert.equal(f.calls(),0);
});
test('expired or different cache-scope approvals cannot dispatch',async()=>{
 for(const change of [{expiresAt:0},{expiresAt:undefined},{expiresAt:NaN},{key:'different'},{application:'other'}]){
 const f=setup();Object.assign(f.config.approvals.get('test-grant'),change);
 assert.equal((await invoke(f)).code,403);assert.equal(f.calls(),0);}
});
test('two handler instances share an atomic claim and dispatch only once',async()=>{
 const f=setup(),g={handler:createVoiceStudioAudioHandler(f.config)};
 const results=await Promise.all([invoke(f),invoke(g)]);
 assert.equal(f.calls(),1);assert.ok(results.some(r=>r.data.ok));
 assert.equal(f.records.get(f.key).status,'ready');
});
test('database asset-write failure after generation is uncertain, never zero-cost or retryable',async()=>{
 const f=setup();f.config.pipeline.upsertVoiceAsset=async()=>{throw Error('database detail');};
 assert.equal((await invoke(f)).code,503);
 assert.equal(f.records.get(f.key).status,'uncertain');
 assert.equal(f.records.get(f.key).accounting.actualMicrousd,20);
 assert.equal((await invoke(f)).code,409);assert.equal(f.calls(),1);
});
