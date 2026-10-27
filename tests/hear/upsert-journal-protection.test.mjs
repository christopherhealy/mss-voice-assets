import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {upsertVoiceAsset,JOURNAL_PROTECTION_KEY as marker,VoiceAssetJournalConflictError} from '../../lib/upsertVoiceAsset.js';
const input={textItemId:1,voiceProfileId:2,textHash:'synthetic-hash',storageType:'permanent',
 assetStatus:'ready',storageKey:'synthetic-key',audioUrl:'opaque:synthetic',providerResponseJson:{request_id:'synthetic-request'},providerRequestId:'synthetic-request'};
// Simulates the atomic statement outcome, NOT PostgreSQL's engine/locking implementation.
function fixture(initial=null){let row=initial;const queries=[];return {queries,row:()=>row,
 db:{async query(sql,values){
 queries.push({sql,values});
 assert.match(sql,/select[\s\S]*where not \(\$10::jsonb \? \$19::text\)/i);
 assert.match(sql,/on conflict \(text_item_id, voice_profile_id, text_hash\)[\s\S]*where not \(voice_assets\.provider_response_json \? \$19::text\)/i);
 assert.equal(values[18],marker);
 const metadata=JSON.parse(values[9]);
 if(Object.hasOwn(metadata,marker)||(row&&Object.hasOwn(row.provider_response_json,marker)))return {rows:[],rowCount:0};
 row={id:row?.id||10,asset_status:values[8],storage_key:values[4],audio_url:values[5],provider_response_json:metadata,provider_request_id:values[17]};
 return {rows:[structuredClone(row)],rowCount:1};
 }}};}
const blocked=error=>{assert.equal(error.code,'VOICE_ASSET_JOURNAL_CONFLICT');assert.equal(error.status,409);assert.equal(error.message,'voice_asset_journal_conflict');return true;};
test('ordinary unprotected creation and update retain existing values and metadata replacement',async()=>{
 const f=fixture();const created=await upsertVoiceAsset(input,{db:f.db});assert.equal(created.id,10);assert.deepEqual(created.provider_response_json,input.providerResponseJson);
 const updated=await upsertVoiceAsset({...input,storageKey:'new-key',providerResponseJson:{replacement:true}},{db:f.db});
 assert.equal(updated.id,10);assert.equal(updated.storage_key,'new-key');assert.deepEqual(updated.provider_response_json,{replacement:true});
 assert.equal(f.queries[0].values.length,19);assert.equal(f.queries.length,2);
});
test('target-row protection rejects every ordinary overwrite, including attempted removal',async()=>{
 const original={id:10,asset_status:'uncertain',storage_key:'private-original',audio_url:null,
 provider_request_id:'original-id',provider_response_json:{[marker]:{version:1,encrypted:'synthetic-ciphertext'},other:'keep'}};
 const f=fixture(structuredClone(original));
 for(const providerResponseJson of [{},{replacement:true},{[marker]:false},{[marker]:null},{[marker]:{version:99}}]){
 await assert.rejects(upsertVoiceAsset({...input,providerResponseJson},{db:f.db}),blocked);
 assert.deepEqual(f.row(),original);}
});
test('marker presence is fail closed even with false, null or unknown version',async()=>{
 for(const value of [false,null,{},'unexpected',0,{version:99}]){
 const original={id:10,provider_response_json:{[marker]:value}},f=fixture(original);
 await assert.rejects(upsertVoiceAsset(input,{db:f.db}),blocked);assert.equal(f.row(),original);}
});
test('caller metadata cannot create a protected row or gain journal-writer privileges',async()=>{
 for(const value of [{version:1},false,null]){
 const f=fixture();await assert.rejects(upsertVoiceAsset({...input,providerResponseJson:{[marker]:value}},{db:f.db}),blocked);assert.equal(f.row(),null);}
});
test('serialized caller metadata cannot smuggle the reserved marker through toJSON',async()=>{
 const f=fixture();await assert.rejects(upsertVoiceAsset({...input,providerResponseJson:{toJSON:()=>({[marker]:false})}},{db:f.db}),blocked);assert.equal(f.row(),null);
});
test('concurrent ordinary attempts all reject the protected row',async()=>{
 const original={id:10,provider_response_json:{[marker]:{version:1}}},f=fixture(original);
 const results=await Promise.allSettled(Array.from({length:8},()=>upsertVoiceAsset(input,{db:f.db})));
 assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code==='VOICE_ASSET_JOURNAL_CONFLICT'));assert.equal(f.row(),original);
});
test('concurrent unprotected requests remain successful under the mocked atomic conflict contract',async()=>{
 const f=fixture();const results=await Promise.all(Array.from({length:8},()=>upsertVoiceAsset(input,{db:f.db})));
 assert.ok(results.every(r=>r.id===10));
});
test('protection requires one atomic SQL statement and never a SELECT-before-write',async()=>{
 const f=fixture({provider_response_json:{[marker]:true}});await assert.rejects(upsertVoiceAsset(input,{db:f.db}),blocked);
 assert.equal(f.queries.length,1);assert.doesNotMatch(f.queries[0].sql,/select[\s\S]*from voice_assets/i);
});
test('conflict diagnostics contain no asset or recovery metadata',()=>{
 const error=new VoiceAssetJournalConflictError();assert.equal(error.message,'voice_asset_journal_conflict');
 assert.doesNotMatch(JSON.stringify(error),/synthetic|ciphertext|https:|provider_response_json/);
});

// Exercise existing route catches without HTTP sockets, provider calls or DB access.
mock.module('../../lib/getOrCreateVoiceAsset.js',{namedExports:{getOrCreateVoiceAsset:async()=>{throw new VoiceAssetJournalConflictError();}}});
mock.module('../../lib/resolveVoiceProfile.js',{namedExports:{resolveVoiceProfile:async()=>({id:2,voice_code:'synthetic-voice'}),resolveDefaultVoiceProfile:async()=>({id:2,voice_code:'synthetic-voice'})}});
const router=(await import('../../routes/voice.routes.js')).default;
const {createFluentlyAudioHandler}=await import('../../routes/fluently-audio.js');
function response(){return {setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};}
test('generic render safely catches the conflict using its existing redacted-message response',async()=>{
 const handler=router.stack.find(layer=>layer.route?.path==='/render').route.stack.at(-1).handle;
 const res=response(),logs=[];const log=mock.method(console,'error',(...args)=>logs.push(args));
 try {await handler({body:{text_id:'synthetic',text_type:'test',text:'Synthetic text',storage_type:'permanent',voice_profile_id:'synthetic-voice'}},res);}
 finally{log.mock.restore();}
 assert.equal(res.code,500);assert.equal(res.data.error,'render_failed');assert.equal(res.data.message,'voice_asset_journal_conflict');
 assert.doesNotMatch(JSON.stringify(logs),/ciphertext|signedUrl|password/);
});
test('Fluently route keeps its existing generic unconfirmed response on conflict',async()=>{
 const res=response();const handler=createFluentlyAudioHandler({
 env:{RENDER_SERVICE_NAME:'mss-voice-assets-qa',INGLE_VOICE_SERVICE_SECRET:'synthetic',FLUENTLY_HEAR_ELEVENLABS_API_KEY:'mock',R2_BUCKET:'ingle-audio-qa',R2_ACCOUNT_ID:'mock',R2_ACCESS_KEY_ID:'mock',R2_SECRET_ACCESS_KEY:'mock',R2_PUBLIC_BASE_URL:'https://mock.invalid'},
 checkStorage:async()=>{},db:{query:async sql=>({rows:sql.includes('current_database')?[{name:'ingle_qa_db'}]:[{id:1}]})},
 render:async()=>{throw new VoiceAssetJournalConflictError();}});
 const {hashText}=await import('../../lib/hashText.js');
 await handler({method:'POST',headers:{authorization:'Bearer synthetic'},body:{text:'Salve.',text_id:'fluently:qa:hear:it:1:'+hashText('Salve.'),text_type:'fluently_scene_turn',storage_type:'permanent',voice_profile_id:'ZX5x7KzQ9elPznG4bv3T',metadata:{scene_id:'6a29b8e9-a54e-48dc-8fb4-fcd45f77e5bf',revision:1,plan_id:'a'.repeat(64)}}},res);
 assert.equal(res.code,502);assert.deepEqual(res.data,{ok:false,error:'hear_render_unconfirmed'});
});
