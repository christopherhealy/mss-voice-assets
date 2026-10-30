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
  approvals=new Map(), recoveryApprovals=new Map(), journal, storage, pipeline, generate, accounting, render, now=Date.now}={}) {
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
      if(b.operation!==undefined&&!['generate','recover','accounting-retry'].includes(b.operation))return fail(400,'operation_invalid');
      const registrationPending=ready?.status==='pending'&&['pending','confirmed'].includes(ready.accountingDelivery?.claim);
      if(b.operation==='accounting-retry') {
        const persisted=ready?.accountingDelivery?.pendingOutcome||(()=>{
          const usage=ready?.accounting?.usage||{};
          if(!['completed','provider_http_failure','dispatch_outcome_uncertain','provider_response_uncertain'].includes(usage.dispatch_status))return null;
          return {dispatch_status:usage.dispatch_status,provider_request_id:usage.provider_request_id||null,
            duration_seconds:usage.duration_seconds??null,engine:usage.engine||null,http_status:usage.http_status??null,
            output_audio_bytes:usage.output_audio_bytes??null};
        })()||(ready?.recovery?{dispatch_status:'completed',provider_request_id:ready.recovery.requestId,
          duration_seconds:ready.recovery.duration,engine:ready.recovery.engine,output_audio_bytes:null}:null);
        if(!ready||ready.accountingDelivery?.outcome==='confirmed'||!persisted||
          typeof accounting?.outcome!=='function'||typeof journal.accountingDelivery!=='function')return fail(409,'accounting_retry_unavailable');
        await journal.accountingDelivery(key,'outcome','pending',persisted);
        await accounting.outcome({generation_key:key,input_characters:b.text.length,...persisted});
        await journal.accountingDelivery(key,'outcome','confirmed');
        return res.json({ok:true,accounting_retry:true});
      }
      if(ready&&!recovering&&!registrationPending)return fail(409,'dispatch_unconfirmed_no_retry');
      if(recovering&&(!ready?.recovery||ready.application!=='voice-studio'||!['generated','downloaded','stored','recoverable'].includes(ready.status)||
        typeof generate.recover!=='function'||typeof journal.claimRecovery!=='function'))return fail(409,'recovery_unavailable');
      if(!recovering&&(!accounting||typeof accounting.claim!=='function'||typeof accounting.outcome!=='function'||
        typeof journal.accountingDelivery!=='function'||typeof journal.markDispatching!=='function'))return fail(503,'accounting_unavailable');
      const approval=(recovering?recoveryApprovals:approvals).get(b.approval_id);
      if(!approval||approval.key!==key||approval.application!=='voice-studio'||!Number.isSafeInteger(approval.expiresAt)||approval.expiresAt<=now()||
        (!recovering&&(!money(approval.ceilingMicrousd)||!money(approval.upperBoundMicrousd)||approval.upperBoundMicrousd>approval.ceilingMicrousd)))
        return fail(403,'generation_approval_required');
      const work=(async()=>{
        await storage.preflight(); // No dispatch marker or charge on preflight failure.
        if(recovering) {
          // A recovery operation may redeliver only an already-persisted ledger outcome.
          if(ready.accountingDelivery?.outcome!=='confirmed'&&
            (ready.accountingDelivery?.pendingOutcome||ready.recovery||ready.accounting?.usage?.dispatch_status)) {
            const retry=ready.accountingDelivery?.pendingOutcome||
              (ready.accounting?.usage?.dispatch_status?{dispatch_status:ready.accounting.usage.dispatch_status,
                provider_request_id:ready.accounting.usage.provider_request_id||null,duration_seconds:ready.accounting.usage.duration_seconds??null,
                engine:ready.accounting.usage.engine||null,http_status:ready.accounting.usage.http_status??null,
                output_audio_bytes:ready.accounting.usage.output_audio_bytes??null}:null)||
              (ready.recovery?{dispatch_status:'completed',provider_request_id:ready.recovery.requestId,
                duration_seconds:ready.recovery.duration,engine:ready.recovery.engine,output_audio_bytes:null}:null);
            if(retry) {
              await journal.accountingDelivery(key,'outcome','pending',retry);
              await accounting.outcome({generation_key:key,input_characters:b.text.length,...retry});
              await journal.accountingDelivery(key,'outcome','confirmed');
            }
          }
          if(!(await journal.claimRecovery(key)))throw Error('recovery_unavailable');
        } else {
          if(!registrationPending&&!(await journal.claim(key,{application:'voice-studio',status:'pending',approvalId:b.approval_id})))
            throw Error('dispatch_unconfirmed_no_retry');
          // The ledger event is created idempotently before the durable dispatch marker and before provider I/O.
          const attribution={};
          for(const [target,source] of Object.entries({scene_id:'sceneId',conversation_id:'conversationId',script_id:'scriptId',turn_id:'turnId',session_id:'sessionId'})) {
            const value=approval[source]??approval[target];
            if(typeof value==='string'&&value.length<=128&&/^[A-Za-z0-9._:-]+$/.test(value))attribution[target]=value;
          }
          const claimResult=await accounting.claim({generation_key:key,input_characters:b.text.length,
            ...(Object.keys(attribution).length?{attribution}:{})});
          if(claimResult?.recorded!==true&&claimResult?.existing!==true)throw Error('accounting_unconfirmed');
          await journal.accountingDelivery(key,'claim','confirmed');
          await journal.markDispatching(key);
        }
        let recovery=recovering?ready.recovery:null;
        let accountingRecord={...(ready?.accounting||{}),costStatus:'UNRATED',actualMicrousd:null,estimatedMicrousd:null,
          providerRequestId:ready?.accounting?.providerRequestId||null,usage:ready?.accounting?.usage||{}};
        let outcomeStarted=false,lastOutcome=null;
        const reportOutcome=async outcome=>{
          outcomeStarted=true;lastOutcome=outcome;
          accountingRecord={...accountingRecord,costStatus:'UNRATED',actualMicrousd:null,estimatedMicrousd:null,
            providerRequestId:outcome.provider_request_id||accountingRecord.providerRequestId,
            usage:{...(accountingRecord.usage||{}),engine:outcome.engine||null,duration_seconds:outcome.duration_seconds??null,
              provider_request_id:outcome.provider_request_id||null,dispatch_status:outcome.dispatch_status,
              http_status:outcome.http_status??null,output_audio_bytes:outcome.output_audio_bytes??null}};
          await journal.accountingDelivery(key,'outcome','pending',outcome);
          await accounting.outcome({generation_key:key,input_characters:b.text.length,...outcome});
          await journal.accountingDelivery(key,'outcome','confirmed');
        };
        try {
          await sharedRender({textId:assetId,textType:'studio_synthetic_host',text:b.text,storageType:'permanent',
            voiceProfileCode:profile.voiceId,storageKeyOverride:assetId,preserveExactText:true,
            pipeline:{...pipeline,resolveVoiceProfile:async()=>({...profile,voice_code:profile.voiceId}),
              uploadToR2:async({buffer,storageKey})=>{await storage.write(storageKey,buffer);await journal.markStored?.(key);return {publicUrl:assetId};}},
            generateSpeechImpl:async()=>{
              const speech=recovering?await generate.recover({text:b.text,profile,recovery}):await generate({text:b.text,profile,maxCostMicrousd:approval.ceilingMicrousd,
                reportOutcome,
                persistRecovery:async metadata=>{
                  if(typeof journal.saveRecovery!=='function')throw Error('protected_recovery_required');
                  await journal.saveRecovery(key,metadata);
                  recovery=metadata;accountingRecord={...accountingRecord,providerRequestId:metadata.requestId};
                }});
              if(!recovering)await reportOutcome({dispatch_status:'completed',provider_request_id:speech.providerRequestId||null,
                duration_seconds:speech.durationSeconds||null,engine:speech.engine||speech.providerResponseJson?.engine||null,
                output_audio_bytes:speech.buffer?.length||null});
              await journal.markDownloaded?.(key,speech.buffer);
              accountingRecord={...accountingRecord,costStatus:'UNRATED',actualMicrousd:null,estimatedMicrousd:null,
                providerRequestId:speech.providerRequestId||accountingRecord.providerRequestId,
                usage:{...(accountingRecord.usage||{}),engine:speech.engine||speech.providerResponseJson?.engine||null,duration_seconds:speech.durationSeconds||null,
                  provider_request_id:speech.providerRequestId||null,output_audio_bytes:speech.buffer?.length||null}};
              return {...speech,generationProvider:'heygen',generationModel:profile.model,
                generationCostUsd:null,
                providerResponseJson:{...speech.providerResponseJson,request_id:accountingRecord.providerRequestId,accounting:accountingRecord}};
            }});
          const record={application:'voice-studio',status:'ready',accounting:accountingRecord,reused:false};
          await journal.finish(key,record);return record;
        } catch {
          if(!recovering&&!outcomeStarted) {
            // Covers failures after the durable dispatch marker but before the adapter returns an outcome.
            try {await reportOutcome({dispatch_status:'dispatch_outcome_uncertain'});}catch{}
          } else if(!recovering&&lastOutcome) {
            // Retry only accounting delivery once; the provider dispatch is never repeated.
            try {
              await journal.accountingDelivery(key,'outcome','pending',lastOutcome);
              await accounting.outcome({generation_key:key,input_characters:b.text.length,...lastOutcome});
              await journal.accountingDelivery(key,'outcome','confirmed');
            } catch {}
          }
          await journal.finish(key,{application:'voice-studio',status:recovery?'recoverable':'uncertain',accounting:accountingRecord,...(recovery?{recovery}:{})});
          throw Error('dispatch_unconfirmed_no_retry');
        }
      })();
      pending.set(key,work);
      try{return response(await work);}finally{pending.delete(key);}
    }catch{return fail(503,'audio_unavailable_or_dispatch_unconfirmed');}
  };
}
