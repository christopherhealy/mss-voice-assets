import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createVoiceStudioJournal} from '../../lib/voice-studio-journal.js';
import {createHeygenSpeech,HOST_TEXT,TIZIANA_ID} from '../../lib/generateSpeech.heygen.js';
import {createVoiceStudioAudioHandler,cacheIdentity} from '../../routes/voice-studio-audio.js';
import {upsertVoiceAsset,JOURNAL_PROTECTION_KEY as marker} from '../../lib/upsertVoiceAsset.js';
const encryptionKey=Buffer.alloc(32,7); // Synthetic test key, never a real credential.
const profile={id:17,approved:true,provider:'heygen',actor:'julie',voice:'tiziana',language:'it',voiceId:TIZIANA_ID,engine:'elevenlabs',model:'eleven_multilingual_v2',version:1,settings:{speed:1}};
const key=cacheIdentity(HOST_TEXT,profile),assetId=`studio:${key}`,textHash=createHash('sha256').update(HOST_TEXT).digest('hex');
const recovery={version:1,voiceId:TIZIANA_ID,textHash,audioUrl:'https://files.heygen.ai/audio/test.mp3?signature=synthetic-secret',requestId:'synthetic-provider-request',duration:5.46,engine:'elevenlabs',requestedModel:profile.model,generationMs:100};
const mp3=Buffer.from('ID3 synthetic audio');
import {database} from './fixtures/studio-journal-db.mjs';

const make=db=>createVoiceStudioJournal({db,encryptionKey,keyId:'synthetic-test-key-v1',profile});
const claim=async j=>{const got=await j.claim(key,{application:'voice-studio',status:'pending'});if(got){await j.accountingDelivery(key,'claim','confirmed');await j.markDispatching(key);}return got;};
const ready=async j=>{await claim(j);await j.saveRecovery(key,recovery);await j.markDownloaded(key,mp3);await j.markStored(key);await j.pipeline.upsertVoiceAsset({textItemId:11,voiceProfileId:17,textHash,storageKey:assetId,audioUrl:assetId,mimeType:'audio/mpeg',durationMs:5460});await j.finish(key,{application:'voice-studio',status:'ready'});};
test('atomic concurrent claims use existing uniqueness; only one may dispatch',async()=>{
 const {db,state}=database();const jobs=[make(db),make(db),make(db)];
 assert.deepEqual((await Promise.all(jobs.map(claim))).sort(),[false,false,true]);
 assert.equal((await jobs[0].get(key)).status,'dispatching');assert.equal(state.asset.text_item_id,11);
});
test('all guarded lifecycle stages complete without ordinary upsert',async()=>{
 const {db,state}=database(),j=make(db);await claim(j);assert.equal((await j.get(key)).status,'dispatching');
 await j.saveRecovery(key,recovery);assert.equal((await j.get(key)).status,'generated');
 await j.markDownloaded(key,mp3);assert.equal((await j.get(key)).status,'downloaded');
 await j.markStored(key);assert.equal((await j.get(key)).status,'stored');
 await j.pipeline.upsertVoiceAsset({textItemId:11,voiceProfileId:17,textHash,storageKey:assetId,audioUrl:assetId,mimeType:'audio/mpeg',durationMs:5460});
 await j.finish(key,{application:'voice-studio',status:'ready'});assert.equal((await make(db).get(key)).status,'ready');
 assert.equal(state.asset.audio_url,assetId);assert.equal(state.asset.duration_ms,5460);
});
test('URL and request identifiers are encrypted with fresh IVs and versioned metadata',async()=>{
 const {db,state}=database(),j=make(db);await claim(j);const first=state.asset.provider_response_json[marker].iv;
 await j.saveRecovery(key,recovery);const raw=JSON.stringify(state.asset);
 assert.doesNotMatch(raw,/synthetic-secret|synthetic-provider-request|https:|audioUrl/);
 assert.doesNotMatch(JSON.stringify(state.queries),/signature=|synthetic-provider-request/);
 const envelope=state.asset.provider_response_json[marker];assert.equal(envelope.version,1);assert.notEqual(envelope.iv,first);
 assert.equal((await make(db).get(key)).recovery.requestId,recovery.requestId);
});
test('accounting claim and pending outcome delivery are durably recoverable but encrypted',async()=>{
 const {db,state}=database(),j=make(db);assert.equal(await j.claim(key,{application:'voice-studio',status:'pending'}),true);
 await j.accountingDelivery(key,'claim','confirmed');
 const outcome={dispatch_status:'completed',provider_request_id:'private-request-id',duration_seconds:5.46,engine:'elevenlabs',output_audio_bytes:1234};
 await j.accountingDelivery(key,'outcome','pending',outcome);
 const resumed=make(db),record=await resumed.get(key);assert.equal(record.accountingDelivery.claim,'confirmed');
 assert.deepEqual(record.accountingDelivery.pendingOutcome,outcome);
 assert.doesNotMatch(JSON.stringify(state.asset.provider_response_json),/private-request-id|elevenlabs|dispatch_status/);
 await resumed.accountingDelivery(key,'outcome','confirmed');
 assert.equal((await make(db).get(key)).accountingDelivery.pendingOutcome,null);
});
test('wrong keys, key versions, modified ciphertext and copied-context envelopes fail closed',async()=>{
 for(const change of ['key','version','ciphertext','context']){
 const {db,state}=database(),j=make(db);await claim(j);await j.saveRecovery(key,recovery);
 let reader;
 if(change==='key')reader=createVoiceStudioJournal({db,encryptionKey:Buffer.alloc(32,8),keyId:'synthetic-test-key-v1',profile});
 else {reader=make(db);const e=state.asset.provider_response_json[marker];if(change==='version')e.version=2;else if(change==='ciphertext')e.ciphertext='AAAA';else reader=createVoiceStudioJournal({db,encryptionKey,keyId:'synthetic-test-key-v1',profile:{...profile,version:2}});}
 await assert.rejects(reader.get(change==='context'?cacheIdentity(HOST_TEXT,{...profile,version:2}):key),{message:'studio_journal_conflict_or_unavailable'});}
});
test('uncertain dispatch never becomes a new generation or recovery claim after restart',async()=>{
 const {db}=database(),j=make(db);await claim(j);await j.finish(key,{application:'voice-studio',status:'uncertain'});
 const restarted=make(db);assert.equal(await claim(restarted),false);assert.equal(await restarted.claimRecovery(key),false);assert.equal((await restarted.get(key)).status,'uncertain');
});
test('generated state survives abrupt process loss and permits only explicit recovery takeover',async()=>{
 const {db}=database(),j=make(db);await claim(j);await j.saveRecovery(key,recovery);
 const restarted=make(db);assert.equal(await claim(restarted),false);assert.equal(await restarted.claimRecovery(key),true);
 await assert.rejects(j.markDownloaded(key,mp3));
 await restarted.markDownloaded(key,mp3);await restarted.markStored(key);assert.equal((await restarted.get(key)).status,'stored');
});
test('persisted byte hash rejects changed audio during restart recovery',async()=>{
 const {db}=database(),j=make(db);await claim(j);await j.saveRecovery(key,recovery);await j.markDownloaded(key,mp3);
 const next=make(db);assert.equal(await next.claimRecovery(key),true);await assert.rejects(next.markDownloaded(key,Buffer.from('ID3 changed')));
});
test('lost claim acknowledgement leaves pending and never grants a second dispatch',async()=>{
 const {db,state}=database(),j=make(db);state.after=tag=>{if(tag==='claim')throw Error('lost acknowledgement');};
 await assert.rejects(claim(j));state.after=null;const next=make(db);assert.equal(await claim(next),false);assert.equal((await next.get(key)).status,'pending');
});
test('lost generated-state acknowledgement retains encrypted recovery evidence',async()=>{
 const {db,state}=database(),j=make(db);await claim(j);state.after=tag=>{if(tag==='transition')throw Error('lost acknowledgement');};
 await assert.rejects(j.saveRecovery(key,recovery));state.after=null;const next=make(db);assert.equal((await next.get(key)).status,'generated');assert.equal(await next.claimRecovery(key),true);
});
test('ordinary upsert cannot remove journal protection or replace recovery/storage',async()=>{
 const {db,state}=database(),j=make(db);await ready(j);const before=structuredClone(state.asset);
 await assert.rejects(upsertVoiceAsset({textItemId:11,voiceProfileId:17,textHash,storageType:'permanent',providerResponseJson:{}},{db}),{code:'VOICE_ASSET_JOURNAL_CONFLICT'});assert.deepEqual(state.asset,before);
});
test('invalid transitions and wrong QA identity/profile fail before asset mutation',async()=>{
 const {db,state}=database(),j=make(db);await assert.rejects(j.markStored(key));assert.equal(state.asset,null);
 await assert.rejects(j.claim('wrong-context',{application:'voice-studio',status:'dispatching'}));
 const wrong={query:async()=>({rows:[{name:'production'}]})};await assert.rejects(claim(make(wrong)));assert.equal(state.asset,null);
});
const env={RENDER_SERVICE_NAME:'mss-voice-assets-qa',VOICE_STUDIO_AUDIO_SERVICE_SECRET:'synthetic-distinct-only-secret-not-real'};
function route(journal,generate,storage){return createVoiceStudioAudioHandler({env,enabled:true,profile,journal,pipeline:journal.pipeline,generate,storage,
 accounting:{claim:async()=>({recorded:true}),outcome:async()=>({recorded:true})},
 approvals:new Map([['generate',{key,application:'voice-studio',expiresAt:Date.now()+60000,ceilingMicrousd:100,upperBoundMicrousd:100}]]),
 recoveryApprovals:new Map([['recover',{key,application:'voice-studio',expiresAt:Date.now()+60000}]])});}
async function invoke(handler,operation='generate'){
 const res={setHeader(){},status(code){this.code=code;return this;},json(value){this.value=value;return this;},send(value){this.value=value;return this;}};
 const req={method:operation==='play'?'GET':'POST',headers:{'x-service-id':'voice-studio',authorization:`Bearer ${env.VOICE_STUDIO_AUDIO_SERVICE_SECRET}`},query:{asset_id:assetId},
 body:{application:'voice-studio',actor:'julie',activity:'l2-scripted-host',language:'it',text:HOST_TEXT,profile_version:1,operation,approval_id:operation}};
 await handler(req,res);return res;
}
for(const failure of ['download','storage'])test(`route ${failure} failure recovers through a fresh journal instance and replays without generation`,async()=>{
 const {db,state}=database();let posts=0,fail=true;const objects=new Map();
 const generate=createHeygenSpeech({credential:async()=>'synthetic-api-key',resolve:async()=>[{address:'8.8.8.8'}],request:async(url,options)=>{
 if(options.method==='POST'){posts++;return new Response(JSON.stringify({data:{audio_url:recovery.audioUrl,request_id:recovery.requestId,duration:5.46,engine:'elevenlabs'}}));}
 if(fail&&failure==='download')throw Error('simulated');return new Response(mp3,{headers:{'content-type':'audio/mpeg'}});}});
 const storage={preflight:async()=>{},write:async(k,b)=>{if(fail&&failure==='storage')throw Error('simulated');objects.set(k,b);},read:async k=>objects.get(k)};
 const reporting=async()=>({recorded:true});
 const initialJournal=make(db);
 const original=createVoiceStudioAudioHandler({env,enabled:true,profile,journal:initialJournal,pipeline:initialJournal.pipeline,generate,storage,
   accounting:{claim:async()=>({recorded:true}),outcome:reporting},
   approvals:new Map([['generate',{key,application:'voice-studio',expiresAt:Date.now()+60000,ceilingMicrousd:100,upperBoundMicrousd:100}]]),
   recoveryApprovals:new Map([['recover',{key,application:'voice-studio',expiresAt:Date.now()+60000}]])});
 assert.equal((await invoke(original)).code,503);assert.equal((await make(db).get(key)).status,'recoverable');
 assert.equal((await invoke(original)).code,409);fail=false;
 const restarted=route(make(db),generate,storage);assert.equal((await invoke(restarted,'recover')).value.ok,true);
 for(let i=0;i<3;i++)assert.equal((await invoke(restarted,'play')).value.toString(),mp3.toString());
 assert.equal((await invoke(restarted)).value.cache_hit,true);assert.equal(posts,1);
 assert.doesNotMatch(JSON.stringify(state.asset),/signature=|synthetic-provider-request/);
});

test('recovery claims are exclusive and stale owners cannot finish newer work',async()=>{
 const {db}=database(),first=make(db);await claim(first);await first.saveRecovery(key,recovery);
 const a=make(db),b=make(db);const results=await Promise.all([a.claimRecovery(key),b.claimRecovery(key)]);
 assert.equal(results.filter(Boolean).length,1);await assert.rejects(first.finish(key,{application:'voice-studio',status:'recoverable'}));
 assert.equal((await make(db).get(key)).status,'recovering');
});
test('journal construction requires reviewed profile and encryption material',()=>{
 const {db}=database();for(const options of [{encryptionKey:Buffer.alloc(16)}, {keyId:'bad key'}, {profile:{...profile,settings:{speed:2}}}, {profile:{...profile,approved:false}}])
 assert.throws(()=>createVoiceStudioJournal({db,encryptionKey,keyId:'synthetic-test-key-v1',profile,...options}),{message:'studio_journal_conflict_or_unavailable'});
});
