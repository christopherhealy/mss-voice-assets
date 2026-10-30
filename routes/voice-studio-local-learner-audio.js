// Standalone, local-development-only adapter for explicitly requested Tiziana Learner turns.
// It is not imported by the normal VoiceAssets QA/production server entry point.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHeygenSpeech} from '../lib/generateSpeech.heygen.js';
import {TIZIANA_ID} from '../lib/generateSpeech.heygen.js';
import {VOICE_STUDIO_LOCAL_LEARNER_PROFILE as PROFILE} from '../lib/voice-studio-local-learner-profile.js';

const MAX_AUDIO=20*1024*1024,MAX_TEXT=8000,VERSION='voice-studio-tiziana-learner-v1';
const fail=(status,code)=>Object.assign(Error(code),{status,code});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value);
const within=(parent,child)=>{const rel=path.relative(parent,child);return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));};
function privateDirectory(requested){
  try{
    const dir=path.resolve(requested||path.join(os.homedir(),'.voiceassets','cache',VERSION));
    if(within(path.resolve(process.cwd()),dir))throw fail(503,'private_cache_unavailable');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
    if(fs.lstatSync(dir).isSymbolicLink())throw fail(503,'private_cache_unavailable');
    const real=fs.realpathSync(dir),st=fs.statSync(real);
    if(!st.isDirectory()||(st.mode&0o077)!==0||within(path.resolve(process.cwd()),real))throw fail(503,'private_cache_unavailable');
    return real;
  }catch(error){if(error.status)throw error;throw fail(503,'private_cache_unavailable');}
}
function atomicWrite(dir,name,bytes){
  const destination=path.join(dir,name),temporary=path.join(dir,`.${name}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);let fd;
  try{fd=fs.openSync(temporary,'wx',0o600);fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,destination);const st=fs.lstatSync(destination);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw fail(503,'private_cache_unavailable');}
  catch(error){if(error.status)throw error;throw fail(503,'private_cache_unavailable');}
  finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}try{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}catch{}}
}
function readState(dir,key){
  const file=path.join(dir,`${key}.json`);
  try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.size>256*1024)throw fail(503,'private_cache_invalid');return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;if(error.status)throw error;throw fail(503,'private_cache_invalid');}
}
function writeState(dir,key,state){atomicWrite(dir,`${key}.json`,Buffer.from(JSON.stringify(state)));}
function mp3(bytes){return Buffer.isBuffer(bytes)&&bytes.length>=3&&bytes.length<=MAX_AUDIO&&(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224);}
function encryptRecovery(value,key,keyId,cacheKey){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),aad=Buffer.from(JSON.stringify([VERSION,keyId,cacheKey]));cipher.setAAD(aad);
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return {version:1,key_id:keyId,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:data.toString('base64')};
}
function decryptRecovery(envelope,key,keyId,cacheKey){
  if(envelope?.version!==1||envelope.key_id!==keyId)throw fail(409,'recovery_unavailable');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAAD(Buffer.from(JSON.stringify([VERSION,keyId,cacheKey])));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString('utf8'));
}
function verifyScript(script,turnId){
  if(!script||typeof script!=='object'||Array.isArray(script)||script.data_type!=='prepared_rehearsal_script'||script.demonstration!==false||
    typeof script.script_id!=='string'||!script.script_id||script.script_id.length>128||script.application_id!=='ingle'&&script.application_id!=='fluently'||
    typeof script.scene_id!=='string'||!script.scene_id||script.actor_name!=='Julie'||!['intention','action','experience'].includes(script.conversation_mode)||script.source_practice_stage!=='my-language'||script.target_language!=='it'||
    !['en','es','fr','it','ko'].includes(script.source_language)||script.source_language==='it'||!Array.isArray(script.turns)||!script.turns.length||script.turns.length>60||
    script.rehearsal_turn_group_version!=='speaker-runs-v1'||!Array.isArray(script.original_transcript_turn_ids)||!script.original_transcript_turn_ids.length||script.original_transcript_turn_ids.length>60)throw fail(400,'prepared_script_invalid');
  let total=0,lastPosition=-1;const seen=new Set(),allSourceIds=[],allPreparedIds=[];
  for(let i=0;i<script.turns.length;i++){
    const t=script.turns[i];if(!t||typeof t.transcript_event_id!=='string'||!t.transcript_event_id||t.transcript_event_id.length>128||seen.has(t.transcript_event_id)||
      !['host','user'].includes(t.speaker)||typeof t.prepared_text!=='string'||!t.prepared_text.trim()||t.prepared_text.length>MAX_TEXT||
      t.prepared_type!=='translated_practice_material'||typeof t.original_text!=='string'||!t.original_text.trim()||!Array.isArray(t.source_turn_ids)||!t.source_turn_ids.length||
      !Array.isArray(t.source_positions)||t.source_positions.length!==t.source_turn_ids.length||!Array.isArray(t.prepared_turn_ids)||!t.prepared_turn_ids.length||
      t.prepared_turn_ids.some(id=>typeof id!=='string'||!id)||t.prepared_turn_ids[0]!==t.transcript_event_id||t.source_positions.some((n,j)=>!Number.isSafeInteger(n)||n<=lastPosition||j&&n<=t.source_positions[j-1]))throw fail(400,'prepared_script_invalid');
    seen.add(t.transcript_event_id);for(const id of t.source_turn_ids){if(typeof id!=='string'||!id||allSourceIds.includes(id))throw fail(400,'prepared_script_invalid');allSourceIds.push(id);}lastPosition=t.source_positions.at(-1);
    allPreparedIds.push(...t.prepared_turn_ids);total+=t.prepared_text.length;if(total>40000)throw fail(413,'prepared_script_too_large');
  }
  if(JSON.stringify(allPreparedIds)!==JSON.stringify(script.original_transcript_turn_ids))throw fail(400,'prepared_script_invalid');
  const turn=script.turns.find(t=>t.transcript_event_id===turnId);if(!turn||turn.speaker!=='user')throw fail(404,'learner_turn_unavailable');
  return turn;
}
function constantEqual(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&x.length>0&&crypto.timingSafeEqual(x,y);}
function keyFor(script,turn){return sha(JSON.stringify([VERSION,script.application_id,script.script_id,turn.transcript_event_id,turn.prepared_text,PROFILE.application,PROFILE.actor,PROFILE.activity,PROFILE.language,PROFILE.provider,PROFILE.voiceId,PROFILE.engine,PROFILE.model,PROFILE.version,PROFILE.settings]));}

export function createVoiceStudioLocalLearnerAudioHandler({env=process.env,enabled=false,request=globalThis.fetch,credential=()=>env.HEYGEN_API_KEY,generate=null,cacheDirectory,now=Date.now}={}){
  const pending=new Map(),profile=PROFILE;
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const sendError=(status,code)=>res.status(status).json({ok:false,error:code});
    if(env.NODE_ENV!=='development'||env.RENDER_SERVICE_NAME||enabled!==true||env.VOICE_ASSETS_LOCAL_TIZIANA_LEARNER_ENABLED!=='true')return sendError(404,'not_found');
    if(req.method!=='POST')return sendError(405,'post_required');
    const serviceSecret=env.VOICE_STUDIO_LOCAL_AUDIO_SERVICE_SECRET,signingSecret=env.VOICE_STUDIO_LOCAL_SCRIPT_ATTESTATION_SECRET;
    const auth=String(req.headers.authorization||'');if(typeof serviceSecret!=='string'||serviceSecret.length<32||serviceSecret===env.INGLE_VOICE_SERVICE_SECRET||
      req.headers['x-service-id']!=='voice-studio-local'||!auth.startsWith('Bearer ')||!constantEqual(auth.slice(7),serviceSecret))return sendError(401,'service_authorization_required');
    if(profile.approved!==true||profile.environment!=='local-development'||profile.provider!=='heygen'||profile.voiceId!==TIZIANA_ID||profile.engine!=='elevenlabs'||profile.model!=='eleven_multilingual_v2')return sendError(403,'profile_unavailable');
    if(typeof signingSecret!=='string'||signingSecret.length<32)return sendError(503,'local_attestation_unavailable');
    let signed,providerCredential=null;
    try{
      const body=req.body;if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='action,payload,signature'||!['hear-pro','play-pro-conversation'].includes(body.action)||req.headers['x-voice-studio-action']!==body.action)return sendError(400,'explicit_action_required');
      const expected=crypto.createHmac('sha256',signingSecret).update(canonical({action:body.action,payload:body.payload})).digest('hex');if(!constantEqual(body.signature,expected))return sendError(403,'script_signature_invalid');
      const p=body.payload;if(!p||Array.isArray(p)||Object.keys(p).sort().join(',')!=='script,turn_id'||typeof p.turn_id!=='string')return sendError(400,'prepared_script_invalid');
      const turn=verifyScript(p.script,p.turn_id);signed={action:body.action,script:p.script,turn};
    }catch(error){return sendError(error.status||400,error.code||'prepared_script_invalid');}
    const {script,turn}=signed,key=keyFor(script,turn),dir=(()=>{try{return privateDirectory(cacheDirectory);}catch{return null;}})();if(!dir)return sendError(503,'private_cache_unavailable');
    const audioFile=path.join(dir,`${key}.mp3`);
    const deliver=bytes=>{const digest=sha(bytes);res.setHeader('X-Voice-Asset-Key',key);res.setHeader('Content-Type','audio/mpeg');res.setHeader('Content-Length',String(bytes.length));res.setHeader('X-Audio-SHA256',digest);return res.status(200).send(bytes);};
    async function cached(){
      const state=readState(dir,key);if(state?.status!=='ready')return null;
      if(state.cache_key!==key||state.script_id!==script.script_id||state.turn_id!==turn.transcript_event_id||state.text_hash!==sha(turn.prepared_text)||state.profile_version!==profile.version)throw fail(503,'private_cache_invalid');
      const st=fs.lstatSync(audioFile);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.size>MAX_AUDIO)throw fail(503,'private_cache_invalid');
      const bytes=fs.readFileSync(audioFile);if(!mp3(bytes)||sha(bytes)!==state.audio_sha256)throw fail(503,'private_cache_invalid');return bytes;
    }
    try{const bytes=await cached();if(bytes)return deliver(bytes);}catch(error){return sendError(error.status||503,error.code||'private_cache_invalid');}
    if(pending.has(key)){const shared=await pending.get(key);return shared.ok?deliver(shared.bytes):sendError(shared.status,shared.code);}
    let complete;const shared=new Promise(resolve=>{complete=resolve;});pending.set(key,shared);
    try{
      let state;try{state=readState(dir,key);}catch(error){throw fail(503,error.code||'private_cache_invalid');}
      if(state&&state.status!=='generated')throw fail(409,'generation_outcome_uncertain_no_retry');
      if(state&&(state.cache_key!==key||state.script_id!==script.script_id||state.turn_id!==turn.transcript_event_id))throw fail(409,'recovery_unavailable');
      const recoveryKeyRaw=env.VOICE_ASSETS_LOCAL_RECOVERY_KEY||'';let recoveryKey;
      try{recoveryKey=Buffer.from(recoveryKeyRaw,'base64');if(recoveryKey.length!==32||recoveryKey.toString('base64')!==recoveryKeyRaw)throw Error();}catch{throw fail(503,'recovery_key_unavailable');}
      const keyId=env.VOICE_ASSETS_LOCAL_RECOVERY_KEY_ID;if(typeof keyId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(keyId))throw fail(503,'recovery_key_unavailable');
      let recovery=null;
      if(state){try{recovery=decryptRecovery(state.recovery,recoveryKey,keyId,key);}catch{throw fail(409,'recovery_unavailable');}}
      else{
        try{providerCredential=await credential();}catch{throw fail(503,'provider_credential_unavailable');}
        if(typeof providerCredential!=='string'||!providerCredential||/[\r\n\0]/.test(providerCredential))throw fail(503,'provider_credential_unavailable');
        try{const file=path.join(dir,`${key}.json`),fd=fs.openSync(file,'wx',0o600);try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,JSON.stringify({version:1,status:'dispatching',cache_key:key,script_id:script.script_id,turn_id:turn.transcript_event_id,text_hash:sha(turn.prepared_text),profile_version:profile.version,started_at:new Date(now()).toISOString()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
        catch(error){if(error.code==='EEXIST')throw fail(409,'generation_outcome_uncertain_no_retry');throw fail(503,'private_cache_unavailable');}
      }
      const downloadOnlyRecovery=Boolean(state);
      let didPersistRecovery=false;
      const generatorForRequest=generate||createHeygenSpeech({request,credential:()=>providerCredential,validateText:(text,p)=>p===profile&&p.activity==='l2-scripted-learner'&&typeof text==='string'&&!!text.trim()&&text.length<=MAX_TEXT});
      const speech=recovery?await generatorForRequest.recover({text:turn.prepared_text,profile,recovery}):await generatorForRequest({text:turn.prepared_text,profile,persistRecovery:async metadata=>{
        if(didPersistRecovery)throw Error('recovery_already_persisted');const encrypted=encryptRecovery(metadata,recoveryKey,keyId,key);
        writeState(dir,key,{version:1,status:'generated',cache_key:key,script_id:script.script_id,turn_id:turn.transcript_event_id,text_hash:sha(turn.prepared_text),profile_version:profile.version,recovery:encrypted});recovery=metadata;didPersistRecovery=true;
      }});
      const bytes=Buffer.from(speech.buffer);if(!mp3(bytes))throw Error('audio_invalid');
      atomicWrite(dir,`${key}.mp3`,bytes);writeState(dir,key,{version:1,status:'ready',cache_key:key,script_id:script.script_id,turn_id:turn.transcript_event_id,text_hash:sha(turn.prepared_text),profile_version:profile.version,audio_sha256:sha(bytes),audio_size:bytes.length,provider:'heygen',voice_id:profile.voiceId,engine:profile.engine,model:profile.model,provider_request_id:typeof speech.providerRequestId==='string'?speech.providerRequestId:typeof recovery?.requestId==='string'?recovery.requestId:null,duration_seconds:Number.isFinite(speech.durationSeconds)?speech.durationSeconds:Number.isFinite(recovery?.duration)?recovery.duration:null,generation_ms:Number.isFinite(speech.generationMs)?speech.generationMs:null,input_characters:Array.from(turn.prepared_text).length,delivery_source:downloadOnlyRecovery?'recovery_download':'provider_response_download',cost_status:'unknown',completed_at:new Date(now()).toISOString()});complete({ok:true,bytes});return deliver(bytes);
    }catch(error){const status=error.status||503,code=error.code||'audio_unavailable';complete({ok:false,status,code});return sendError(status,code);}
    finally{pending.delete(key);providerCredential=null;}
  };
}
