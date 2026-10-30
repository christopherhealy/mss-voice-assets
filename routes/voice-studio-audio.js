// Prototype only: no live dependencies, approved profile or generation grants are installed.
import {createHash, timingSafeEqual} from 'node:crypto';
import {HOST_TEXT} from '../lib/generateSpeech.heygen.js';
import {pipeline as pipeAudio} from 'node:stream/promises';
export const SYNTHETIC_TEXT = HOST_TEXT;
export const CANDIDATE = Object.freeze({application:'voice-studio', actor:'julie', activity:'l2-scripted-host', language:'it', provider:'heygen', voice:'tiziana', approved:false});
const hash = value => createHash('sha256').update(value).digest('hex');
export function cacheIdentity(text, profile) {
  return hash(JSON.stringify({version:1, ...CANDIDATE, approved:undefined, textHash:hash(text),
    voiceId:profile.voiceId, engine:profile.engine, model:profile.model,
    profileVersion:profile.version, settings:profile.settings}));
}
const money = n => Number.isSafeInteger(n) && n >= 0;
// All dependencies and grants are operator-owned, never request-owned.
// journal.claim(key) MUST atomically insert a durable dispatch marker; false means never retry.
export function createVoiceStudioAudioHandler({env=process.env, enabled=false, profile=null,
  approvals=new Map(), recoveryApprovals=new Map(), journal, storage, pipeline, generate, render, now=Date.now}={}) {
  const pending=new Map();
  const sharedRender = render || (async args => (await import('../lib/getOrCreateVoiceAsset.js')).getOrCreateVoiceAsset(args));
  return async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    const fail=(status,error)=>res.status(status).json({ok:false,error});
    if(env.RENDER_SERVICE_NAME!=='mss-voice-assets-qa')return fail(404,'not_found');
    const secret=env.VOICE_STUDIO_AUDIO_SERVICE_SECRET;
    const supplied=String(req.headers.authorization||'');
    if(req.headers['x-service-id']!=='voice-studio'||typeof secret!=='string'||secret.length<32||secret===env.INGLE_VOICE_SERVICE_SECRET||
      !supplied.startsWith('Bearer ')||Buffer.byteLength(supplied.slice(7))!==Buffer.byteLength(secret)||
      !timingSafeEqual(Buffer.from(supplied.slice(7)),Buffer.from(secret)))return fail(401,'service_authorization_required');
    if(enabled!==true)return fail(503,'studio_audio_disabled');
    if(profile?.approved!==true||profile.provider!=='heygen'||profile.language!=='it'||profile.actor!=='julie'||
      profile.voice!=='tiziana'||!profile.voiceId||!profile.engine||!profile.model||!profile.version||!profile.settings)
      return fail(403,'approved_profile_required');
    if(!journal||!storage)return fail(503,'private_infrastructure_required');
    const b=req.body||{};
    try {
      if(req.method==='GET') {
        const key=req.query?.asset_id;
        if(typeof key!=='string'||!/^studio:[a-f0-9]{64}$/.test(key))return fail(400,'asset_invalid');
        const record=await journal.get(key.slice(7));
        if(record?.application!=='voice-studio'||record.status!=='ready')return fail(404,'not_found');
        if(record.asset_id!==undefined&&record.asset_id!==key)return fail(404,'not_found');
        res.setHeader('Content-Type','audio/mpeg');res.setHeader('X-Content-Type-Options','nosniff');
        if(typeof storage.open==='function') {
          const audio=await storage.open(key,{sha256:record.audioSha256});
          try {await pipeAudio(audio,res);}catch{res.destroy();}return;
        }
        const audio=await storage.read(key);
        if(record.audioSha256!==undefined&&hash(audio)!==record.audioSha256)throw Error('private_audio_integrity_failed');
        return res.send(audio);
      }
      if(req.method!=='POST')return fail(405,'method_not_allowed');
      if(!journal||!storage||!pipeline||!generate||
        !['getOrCreateTextItem','findExistingAsset','upsertVoiceAsset'].every(k=>typeof pipeline[k]==='function'))return fail(503,'private_infrastructure_required');
      if(typeof generate.recover==='function'&&typeof journal.saveRecovery!=='function')return fail(503,'protected_recovery_required');

      if(b.application!=='voice-studio'||b.actor!=='julie'||b.activity!=='l2-scripted-host'||
        b.language!=='it'||b.text!==SYNTHETIC_TEXT||b.profile_version!==profile.version)
        return fail(400,'prototype_scope_invalid');
      const key=cacheIdentity(b.text,profile), assetId=`studio:${key}`;
      const ready=await journal.get(key);
      const response=record=>res.json({ok:true,asset_id:assetId,retrieval_path:`/api/voice/studio-audio?asset_id=${assetId}`,
        cache_hit:record.reused,accounting:record.accounting});
      if(ready?.status==='ready')return response({...ready,reused:true});
      if(pending.has(key))return response({...await pending.get(key),reused:true});
      const recovering=b.operation==='recover';
      if(b.operation!==undefined&&!['generate','recover'].includes(b.operation))return fail(400,'operation_invalid');
      if(ready&&!recovering)return fail(409,'dispatch_unconfirmed_no_retry');
      if(recovering&&(!ready?.recovery||ready.application!=='voice-studio'||!['generated','downloaded','stored','recoverable'].includes(ready.status)||
        typeof generate.recover!=='function'||typeof journal.claimRecovery!=='function'))return fail(409,'recovery_unavailable');
      const approval=(recovering?recoveryApprovals:approvals).get(b.approval_id);
      if(!approval||approval.key!==key||approval.application!=='voice-studio'||!Number.isSafeInteger(approval.expiresAt)||approval.expiresAt<=now()||
        (!recovering&&(!money(approval.ceilingMicrousd)||!money(approval.upperBoundMicrousd)||approval.upperBoundMicrousd>approval.ceilingMicrousd)))
        return fail(403,'generation_approval_required');
      const work=(async()=>{
        await storage.preflight(); // No dispatch marker or charge on preflight failure.
        if(!(recovering?await journal.claimRecovery(key):await journal.claim(key,{application:'voice-studio',status:'dispatching',approvalId:b.approval_id})))
          throw Error('dispatch_unconfirmed_no_retry');
        let recovery=recovering?ready.recovery:null;
        let accounting=ready?.accounting||{costStatus:'unknown',actualMicrousd:null,estimatedMicrousd:null,providerRequestId:null,usage:null};
        try {
          await sharedRender({textId:assetId,textType:'studio_synthetic_host',text:b.text,storageType:'permanent',
            voiceProfileCode:profile.voiceId,storageKeyOverride:assetId,preserveExactText:true,
            pipeline:{...pipeline,resolveVoiceProfile:async()=>({...profile,voice_code:profile.voiceId}),
              uploadToR2:async({buffer,storageKey})=>{await storage.write(storageKey,buffer);await journal.markStored?.(key);return {publicUrl:assetId};}},
            generateSpeechImpl:async()=>{
              const speech=recovering?await generate.recover({text:b.text,profile,recovery}):await generate({text:b.text,profile,maxCostMicrousd:approval.ceilingMicrousd,
                persistRecovery:async metadata=>{
                  if(typeof journal.saveRecovery!=='function')throw Error('protected_recovery_required');
                  await journal.saveRecovery(key,metadata);
                  recovery=metadata;accounting={...accounting,providerRequestId:metadata.requestId};
                }});
              await journal.markDownloaded?.(key,speech.buffer);
              const actual=speech.actualCostMicrousd, estimated=speech.estimatedCostMicrousd;
              accounting=recovering&&!money(actual)&&!money(estimated)?accounting:{costStatus:money(actual)?'actual':money(estimated)?'estimated':'unknown',
                actualMicrousd:money(actual)?actual:null,estimatedMicrousd:money(estimated)?estimated:null,
                providerRequestId:speech.providerRequestId||null,usage:speech.usage||null};
              if(!recovering&&money(actual)&&actual>approval.ceilingMicrousd)throw Error('provider_ceiling_exceeded');
              return {...speech,generationProvider:'heygen',generationModel:profile.model,
                generationCostUsd:money(accounting.actualMicrousd)?accounting.actualMicrousd/1e6:null,
                providerResponseJson:{...speech.providerResponseJson,request_id:accounting.providerRequestId,accounting}};
            }});
          const record={application:'voice-studio',status:'ready',accounting,reused:false};
          await journal.finish(key,record);return record;
        } catch {
          await journal.finish(key,{application:'voice-studio',status:recovery?'recoverable':'uncertain',accounting,...(recovery?{recovery}:{})});
          throw Error('dispatch_unconfirmed_no_retry');
        }
      })();
      pending.set(key,work);
      try{return response(await work);}finally{pending.delete(key);}
    }catch{return fail(503,'audio_unavailable_or_dispatch_unconfirmed');}
  };
}
