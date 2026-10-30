import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createVoiceStudioLocalLearnerAudioHandler} from '../../routes/voice-studio-local-learner-audio.js';
import {VOICE_STUDIO_LOCAL_LEARNER_PROFILE as profile} from '../../lib/voice-studio-local-learner-profile.js';

const mp3=Buffer.from('ID3 synthetic Italian learner audio'),service='local-service-secret-for-offline-tests-0001',signer='local-script-attestation-secret-for-tests-0001';
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'voice-studio-learner-audio-'));
const env=(overrides={})=>({NODE_ENV:'development',VOICE_ASSETS_LOCAL_TIZIANA_LEARNER_ENABLED:'true',VOICE_STUDIO_LOCAL_AUDIO_SERVICE_SECRET:service,
 VOICE_STUDIO_LOCAL_SCRIPT_ATTESTATION_SECRET:signer,VOICE_ASSETS_LOCAL_RECOVERY_KEY:Buffer.alloc(32,6).toString('base64'),VOICE_ASSETS_LOCAL_RECOVERY_KEY_ID:'test-key-v1',...overrides});
const script=()=>({script_id:'script-test',application_id:'ingle',actor_name:'Julie',scene_id:'trip-to-italy',conversation_mode:'intention',source_language:'en',target_language:'it',source_practice_stage:'my-language',data_type:'prepared_rehearsal_script',demonstration:false,rehearsal_turn_group_version:'speaker-runs-v1',original_transcript_turn_ids:['h1','u1','u2'],turns:[
 {transcript_event_id:'h1',speaker:'host',source_turn_ids:['h1'],source_positions:[0],prepared_turn_ids:['h1'],original_text:'Where?',prepared_text:'Dove?',prepared_type:'translated_practice_material'},
 {transcript_event_id:'u1',speaker:'user',source_turn_ids:['u1','u2'],source_positions:[1,2],prepared_turn_ids:['u1','u2'],original_text:'I am going to Florence in September.',prepared_text:'Vado a Firenze a settembre.',prepared_type:'translated_practice_material'}]});
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
function signed(sc=script(),turnId='u1',action='hear-pro'){const payload={script:sc,turn_id:turnId};return {action,payload,signature:crypto.createHmac('sha256',signer).update(canonical({action,payload})).digest('hex')};}
function res(){return {headers:{},setHeader(k,v){this.headers[k]=v;return this;},status(code){this.code=code;return this;},json(value){this.value=value;return this;},send(value){this.value=value;return this;}};}
async function invoke(handler,body=signed(),options={}){const response=res();await handler({method:options.method||'POST',headers:{'x-service-id':options.serviceId||'voice-studio-local','x-voice-studio-action':body.action,authorization:`Bearer ${options.token||service}`},body},response);return response;}
function fixture(options={}){const directory=options.directory||dir();let calls=0,resolveRecovery=0;const generate=options.generate|| (async({text,profile:p,persistRecovery})=>{assert.equal(p,profile);assert.equal(text,'Vado a Firenze a settembre.');await persistRecovery({version:1,requestId:'mock-req',voiceId:p.voiceId,textHash:crypto.createHash('sha256').update(text).digest('hex'),engine:p.engine,requestedModel:p.model,audioUrl:'https://signed.invalid/mock',duration:3});if(options.failAfterRecovery)throw Error('mock download error');return {buffer:mp3};});const wrapped=async args=>{calls++;return generate(args);};wrapped.recover=async({text,...args})=>{resolveRecovery++;if(options.failRecovery)throw Error('mock recovery error');assert.equal(text,'Vado a Firenze a settembre.');return {buffer:mp3};};const handler=createVoiceStudioLocalLearnerAudioHandler({env:env(options.env),enabled:options.enabled??true,cacheDirectory:directory,credential:()=> 'mock-key-never-used-by-test',generate:wrapped});return {handler,directory,calls:()=>calls,recoveries:()=>resolveRecovery};}

test('approved local profile is scoped to Tiziana Italian Learner turns and strict engine/model',()=>{
 assert.deepEqual({approved:profile.approved,activity:profile.activity,language:profile.language,voice:profile.voiceId,engine:profile.engine,model:profile.model,environment:profile.environment},
 {approved:true,activity:'l2-scripted-learner',language:'it',voice:'ebbc053d046742c582f273f1334c58d8',engine:'elevenlabs',model:'eleven_multilingual_v2',environment:'local-development'});
});
test('valid signed merged Learner turn generates once and persistent cache survives a new handler',async()=>{
 const f=fixture(),first=await invoke(f.handler);assert.equal(first.code,200);assert.deepEqual(first.value,mp3);assert.equal(f.calls(),1);assert.equal(first.headers['Content-Type'],'audio/mpeg');
 const state=JSON.parse(fs.readFileSync(path.join(f.directory,fs.readdirSync(f.directory).find(x=>x.endsWith('.json'))),'utf8'));assert.equal(state.status,'ready');assert.equal(state.turn_id,'u1');assert.equal(state.voice_id,profile.voiceId);assert.equal(state.provider_request_id,'mock-req');assert.equal(state.duration_seconds,3);assert.equal(state.delivery_source,'provider_response_download');assert.equal(state.cost_status,'unknown');
 const restarted=fixture({directory:f.directory});const next=await invoke(restarted.handler);assert.equal(next.code,200);assert.deepEqual(next.value,mp3);assert.equal(restarted.calls(),0);assert.equal(fs.statSync(f.directory).mode&0o777,0o700);
});
test('tampered signature, text, ID, speaker and application are rejected before provider dispatch',async()=>{
 const f=fixture();const invalid=[];let b=signed();b.payload.script.turns[1].prepared_text='changed';invalid.push(b);b=signed(script(),'h1');invalid.push(b);b=signed();b.signature='0'.repeat(64);invalid.push(b);b=signed();b.payload.script.application_id='storysisters';invalid.push(b);b=signed();b.payload.script.actor_name='Someone else';invalid.push(b);
 for(const item of invalid)assert.notEqual((await invoke(f.handler,item)).code,200);assert.equal(f.calls(),0);
});
test('missing authentication, non-local environment and QA runtime fail closed',async()=>{
 const f=fixture();assert.equal((await invoke(f.handler,signed(),{token:'bad'})).code,401);assert.equal((await invoke(f.handler,signed(),{serviceId:'wrong'})).code,401);
 const qa=fixture({env:{NODE_ENV:'production',RENDER_SERVICE_NAME:'mss-voice-assets-qa'}});assert.equal((await invoke(qa.handler)).code,404);assert.equal(qa.calls(),0);
 const disabled=fixture({env:{VOICE_ASSETS_LOCAL_TIZIANA_LEARNER_ENABLED:'false'}});assert.equal((await invoke(disabled.handler)).code,404);assert.equal(disabled.calls(),0);
});
test('simultaneous identical requests coalesce and no duplicate generation occurs',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);const f=fixture({generate:async({text,profile:p,persistRecovery})=>{assert.equal(text,'Vado a Firenze a settembre.');await persistRecovery({version:1,requestId:'mock',voiceId:p.voiceId,textHash:crypto.createHash('sha256').update(text).digest('hex'),engine:p.engine,requestedModel:p.model,audioUrl:'https://signed.invalid/mock',duration:2});await gate;return {buffer:mp3};}});
 const a=invoke(f.handler),b=invoke(f.handler);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls(),1);release();const [ra,rb]=await Promise.all([a,b]);assert.equal(ra.code,200);assert.equal(rb.code,200);assert.deepEqual(ra.value,rb.value);assert.equal(f.calls(),1);
});
test('uncertain dispatch is not regenerated; stored recovery is download-only after restart',async()=>{
 const f=fixture({failAfterRecovery:true});assert.equal((await invoke(f.handler)).code,503);assert.equal(f.calls(),1);const restarted=fixture({directory:f.directory});const recovered=await invoke(restarted.handler);assert.equal(recovered.code,200);assert.equal(restarted.calls(),0);assert.equal(restarted.recoveries(),1);const state=JSON.parse(fs.readFileSync(path.join(f.directory,fs.readdirSync(f.directory).find(x=>x.endsWith('.json'))),'utf8'));assert.equal(state.provider_request_id,'mock-req');assert.equal(state.duration_seconds,3);assert.equal(state.delivery_source,'recovery_download');assert.equal(state.cost_status,'unknown');
});
test('dispatch with no recovery metadata remains blocked after handler restart',async()=>{
 const directory=dir();let calls=0;const generate=async()=>{calls++;throw Error('ambiguous dispatch');};
 const make=()=>createVoiceStudioLocalLearnerAudioHandler({env:env(),enabled:true,cacheDirectory:directory,credential:()=> 'mock-key-never-used-by-test',generate});assert.equal((await invoke(make())).code,503);assert.equal((await invoke(make())).code,409);assert.equal(calls,1);
});
test('missing provider credential is rejected before creating a dispatch marker',async()=>{
 const directory=dir();let calls=0;const handler=createVoiceStudioLocalLearnerAudioHandler({env:env(),enabled:true,cacheDirectory:directory,credential:()=>null,generate:async()=>{calls++;return {buffer:mp3};}});
 assert.equal((await invoke(handler)).code,503);assert.equal(calls,0);assert.deepEqual(fs.readdirSync(directory),[]);
});
test('prohibited methods and malformed requests cannot reach generation',async()=>{const f=fixture();assert.equal((await invoke(f.handler,signed(),{method:'GET'})).code,405);const b=signed();b.payload.script.turns[1].prepared_text='x'.repeat(8001);assert.notEqual((await invoke(f.handler,b)).code,200);assert.equal(f.calls(),0);});
