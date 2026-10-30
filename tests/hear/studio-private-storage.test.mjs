import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,Writable} from 'node:stream';
import {createHash} from 'node:crypto';
import {createVoiceStudioPrivateStorage} from '../../lib/voice-studio-private-storage.js';
import {createVoiceStudioJournal} from '../../lib/voice-studio-journal.js';
import {createVoiceStudioAudioHandler,cacheIdentity} from '../../routes/voice-studio-audio.js';
import {createHeygenSpeech,HOST_TEXT,TIZIANA_ID} from '../../lib/generateSpeech.heygen.js';
import {database} from './fixtures/studio-journal-db.mjs';
const profile={id:17,approved:true,provider:'heygen',actor:'julie',voice:'tiziana',language:'it',voiceId:TIZIANA_ID,engine:'elevenlabs',model:'eleven_multilingual_v2',version:1,settings:{speed:1}};
const key=cacheIdentity(HOST_TEXT,profile),assetId=`studio:${key}`,mp3=Buffer.from('ID3 synthetic private MP3');
const env={RENDER_SERVICE_NAME:'mss-voice-assets-qa',VOICE_STUDIO_AUDIO_SERVICE_SECRET:'synthetic-service-only-not-real-secret'};
function objects(){const map=new Map(),calls=[];let fail=false;return {map,calls,setFail:v=>{fail=v;},client:{async send(command){
 calls.push(command);const input=command.input;
 if(command.constructor.name==='HeadBucketCommand')return {};
 if(command.constructor.name==='PutObjectCommand'){if(fail)throw Error('storage raw secret');map.set(input.Key,Buffer.from(input.Body));return {};}
 if(command.constructor.name==='GetObjectCommand'){if(!map.has(input.Key))throw Error('missing');const bytes=map.get(input.Key);return {Body:Readable.from([bytes]),ContentLength:bytes.length};}
 throw Error('unexpected storage operation');}}};}
const settings={bucket:'synthetic-studio-private',publicBucket:'synthetic-public',privateBucketReviewed:true,encryptionKey:Buffer.alloc(32,9),keyId:'synthetic-storage-key-v1',assetId,env};
const storageFor=o=>createVoiceStudioPrivateStorage({...settings,client:o.client});
test('private upload uses application namespace, encrypted bytes and no public URL',async()=>{
 const o=objects(),storage=storageFor(o);await storage.preflight();assert.equal(await storage.write(assetId,mp3),undefined);
 const put=o.calls.find(c=>c.constructor.name==='PutObjectCommand').input;
 assert.match(put.Key,/^private\/voice-studio\/julie\/it\/l2-scripted-host\/[a-f0-9]{64}\.enc$/);
 assert.equal(put.Bucket,settings.bucket);assert.equal(put.ContentType,'application/octet-stream');assert.equal(put.ACL,undefined);
 assert.ok(!put.Body.includes(mp3));assert.doesNotMatch(put.Body.toString(),/https:|signature=|ID3 synthetic/);
 assert.deepEqual(await storage.read(assetId),mp3);
 const restarted=storageFor(o);const stream=await restarted.open(assetId,{sha256:createHash('sha256').update(mp3).digest('hex')});
 const chunks=[];for await(const chunk of stream)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),mp3);
});
test('unreviewed/public bucket, missing key and production use fail closed',async()=>{
 const o=objects();for(const options of [{privateBucketReviewed:false},{bucket:settings.publicBucket},{encryptionKey:undefined}])assert.throws(()=>createVoiceStudioPrivateStorage({...settings,client:o.client,...options}));
 const production=createVoiceStudioPrivateStorage({...settings,client:o.client,env:{RENDER_SERVICE_NAME:'production'}});
 await assert.rejects(production.preflight());await assert.rejects(production.write(assetId,mp3));assert.equal(o.calls.length,0);
});
test('cross-application/asset keys and invalid audio cannot be stored or retrieved',async()=>{
 const o=objects(),storage=storageFor(o);for(const id of ['fluently:'+key,'studio:'+'0'.repeat(64),'../private']){
 await assert.rejects(storage.write(id,mp3));await assert.rejects(storage.read(id));}
 await assert.rejects(storage.write(assetId,Buffer.from('html')));assert.equal(o.calls.length,0);
});
test('tampered ciphertext, wrong key and mismatched journal audio hash never expose MP3',async()=>{
 const o=objects(),storage=storageFor(o);await storage.write(assetId,mp3);
 await assert.rejects(storage.open(assetId,{sha256:'0'.repeat(64)}));
 const wrong=createVoiceStudioPrivateStorage({...settings,client:o.client,encryptionKey:Buffer.alloc(32,10)});await assert.rejects(wrong.open(assetId));
 const objectKey=[...o.map.keys()][0],envelope=JSON.parse(o.map.get(objectKey));envelope.tag=Buffer.alloc(16).toString('base64');o.map.set(objectKey,Buffer.from(JSON.stringify(envelope)));
 await assert.rejects(storage.open(assetId));
});
class Response extends Writable {
 constructor(){super();this.headers={};this.chunks=[];}
 _write(chunk,encoding,done){this.chunks.push(Buffer.from(chunk));done();}
 setHeader(k,v){this.headers[k]=v;}
 status(code){this.code=code;return this;}
 json(value){this.value=value;this.end();return this;}
 send(value){this.end(value);return this;}
}
async function invoke(handler,{operation='generate',headers={},id=assetId}={}){
 const res=new Response();await handler({method:operation==='play'?'GET':'POST',
 headers:{'x-service-id':'voice-studio',authorization:`Bearer ${env.VOICE_STUDIO_AUDIO_SERVICE_SECRET}`,...headers},query:{asset_id:id},
 body:{application:'voice-studio',actor:'julie',activity:'l2-scripted-host',language:'it',text:HOST_TEXT,profile_version:1,operation,approval_id:operation}},res);return res;
}
function integration(){
 const {db,state}=database(),o=objects();let posts=0,downloadFails=false;
 const generate=createHeygenSpeech({credential:async()=>'synthetic-heygen-key',resolve:async()=>[{address:'8.8.8.8'}],request:async(url,options)=>{
 if(options.method==='POST'){posts++;return new ResponseGlobal(JSON.stringify({data:{audio_url:'https://files.heygen.ai/test.mp3?signature=synthetic',request_id:'private-request-id',engine:'elevenlabs',duration:5.46}}));}
 if(downloadFails)throw Error('download failed');return new ResponseGlobal(mp3,{headers:{'content-type':'audio/mpeg'}});}});
 const make=(playbackOnly=false)=>{const journal=createVoiceStudioJournal({db,encryptionKey:Buffer.alloc(32,7),keyId:'synthetic-journal-key',profile});
 return createVoiceStudioAudioHandler({env,enabled:true,profile,journal,storage:storageFor(o),
 ...(playbackOnly?{}:{generate,pipeline:journal.pipeline}),
 approvals:new Map([['generate',{key,application:'voice-studio',expiresAt:Date.now()+60000,ceilingMicrousd:100,upperBoundMicrousd:100}]]),
 recoveryApprovals:new Map([['recover',{key,application:'voice-studio',expiresAt:Date.now()+60000}]])});};
 return {o,state,make,posts:()=>posts,failDownload:v=>{downloadFails=v;}};
}
const ResponseGlobal=globalThis.Response;
test('authenticated completed playback streams cached audio without generation dependencies',async()=>{
 const f=integration();assert.equal((await invoke(f.make())).value.ok,true);
 const playback=f.make(true);
 for(let i=0;i<3;i++){const res=await invoke(playback,{operation:'play'});assert.deepEqual(Buffer.concat(res.chunks),mp3);assert.equal(res.headers['Content-Type'],'audio/mpeg');assert.equal(res.headers['Cache-Control'],'no-store');}
 assert.equal(f.posts(),1);assert.doesNotMatch(JSON.stringify(f.state.asset),/signature=|private-request-id/);
});
test('missing authentication, wrong application and nonapproved profiles reject before object reads',async()=>{
 const f=integration();await invoke(f.make());const before=f.o.calls.length;
 for(const headers of [{authorization:''},{'x-service-id':'fluently'},{authorization:'Bearer wrong'}])assert.equal((await invoke(f.make(true),{operation:'play',headers})).code,401);
 const noProfile=createVoiceStudioAudioHandler({env,enabled:true,profile:{...profile,approved:false}});assert.equal((await invoke(noProfile,{operation:'play'})).code,403);
 assert.equal(f.o.calls.length,before);
});
test('incomplete or cross-context journal records never reach private storage',async()=>{
 const f=integration();const before=f.o.calls.length;assert.equal((await invoke(f.make(true),{operation:'play'})).code,404);
 assert.equal((await invoke(f.make(true),{operation:'play',id:'fluently:'+key})).code,400);assert.equal(f.o.calls.length,before);
});
for(const failure of ['upload','download'])test(`${failure} failure preserves encrypted recovery; restart finishes private storage without new generation`,async()=>{
 const f=integration();if(failure==='upload')f.o.setFail(true);else f.failDownload(true);
 assert.equal((await invoke(f.make())).code,503);assert.equal(f.state.asset.asset_status,'studio_recoverable');
 assert.equal((await invoke(f.make(true),{operation:'play'})).code,404);
 f.o.setFail(false);f.failDownload(false);const recovered=await invoke(f.make(),{operation:'recover'});assert.equal(recovered.value.ok,true);
 const played=await invoke(f.make(true),{operation:'play'});assert.deepEqual(Buffer.concat(played.chunks),mp3);assert.equal(f.posts(),1);assert.equal(f.state.asset.asset_status,'ready');
 assert.equal(recovered.value.accounting.providerRequestId,'private-request-id');
 assert.doesNotMatch(JSON.stringify(recovered.value),/signature=|audioUrl|synthetic-heygen-key/);
});
test('object corruption produces a redacted failure before any audio is streamed',async()=>{
 const f=integration();await invoke(f.make());const objectKey=[...f.o.map.keys()][0];f.o.map.set(objectKey,Buffer.from('corrupted object'));
 const res=await invoke(f.make(true),{operation:'play'});assert.equal(res.code,503);assert.equal(res.chunks.length,0);assert.equal(f.posts(),1);
});

test('completed journal with missing object reference fails closed before storage access',async()=>{
 const f=integration();await invoke(f.make());f.state.asset.audio_url='https://public.invalid/audio.mp3';const before=f.o.calls.length;
 const res=await invoke(f.make(true),{operation:'play'});assert.equal(res.code,503);assert.equal(f.o.calls.length,before);assert.equal(res.chunks.length,0);
});
