// Dedicated protected-row writer. No default database, encryption key, or startup wiring.
import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {JOURNAL_PROTECTION_KEY as MARKER} from './upsertVoiceAsset.js';
import {cacheIdentity} from '../routes/voice-studio-audio.js';
import {HOST_TEXT,TIZIANA_ID} from './generateSpeech.heygen.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
const stop=()=>Error('studio_journal_conflict_or_unavailable');
const emptyAccounting=()=>({costStatus:'unknown',actualMicrousd:null,estimatedMicrousd:null,providerRequestId:null,usage:null});
export function createVoiceStudioJournal({db,encryptionKey,keyId,profile}={}) {
  profile=profile?structuredClone(profile):null;
  if(!db?.query||!Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32||!/^[-a-zA-Z0-9_]{1,64}$/.test(keyId||'')||
    !Number.isSafeInteger(profile?.id)||profile.id<1||profile.voiceId!==TIZIANA_ID||profile.provider!=='heygen'||
    profile.engine!=='elevenlabs'||profile.model!=='eleven_multilingual_v2'||profile.language!=='it'||
    profile.actor!=='julie'||profile.voice!=='tiziana'||profile.approved!==true||
    !Number.isSafeInteger(profile.version)||profile.version<1||profile.settings?.speed!==1||Object.keys(profile.settings).some(k=>k!=='speed'))throw stop();
  const secret=Buffer.from(encryptionKey),key=cacheIdentity(HOST_TEXT,profile),assetId=`studio:${key}`,textHash=sha(HOST_TEXT),owner=randomUUID();
  const aad=Buffer.from(JSON.stringify(['voice-studio',1,keyId,key,profile.id,textHash]));
  function seal(body) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(aad);
    const ciphertext=Buffer.concat([cipher.update(JSON.stringify(body),'utf8'),cipher.final()]);
    return {version:1,key_id:keyId,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  }
  function open(envelope) {
    if(envelope?.version!==1||envelope.key_id!==keyId)throw stop();
    const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(envelope.iv,'base64'));
    decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
    const body=JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]).toString());
    if(body.key!==key||body.application!=='voice-studio'||body.version!==1)throw stop();return body;
  }
  async function query(sql,args=[]) {try{return await db.query(sql,args);}catch{throw stop();}}
  async function verify(k) {
    if(k!==key)throw stop();
    const identity=(await query("/* studio:identity */ SELECT current_database() AS name")).rows[0];
    if(identity?.name!=='ingle_qa_db')throw stop();
    const approved=(await query("/* studio:profile */ SELECT id FROM voice_profiles WHERE id=$1 AND voice_code=$2 AND provider='heygen' AND language='it' AND is_active",[profile.id,TIZIANA_ID])).rows[0];
    if(Number(approved?.id)!==profile.id)throw stop();
  }
  async function textItem() {
    const args=[assetId,textHash,HOST_TEXT];
    const made=await query(`/* studio:insert-text */ INSERT INTO voice_text_items(text_id,text_hash,text_type,source_text,storage_type,metadata_json)
      VALUES($1,$2,'studio_synthetic_host',$3,'permanent','{"application":"voice-studio"}'::jsonb)
      ON CONFLICT(text_id,text_hash) DO NOTHING RETURNING *`,args);
    const row=made.rows[0]||(await query(`/* studio:read-text */ SELECT * FROM voice_text_items WHERE text_id=$1 AND text_hash=$2`,args.slice(0,2))).rows[0];
    if(!row||row.source_text!==HOST_TEXT||row.text_type!=='studio_synthetic_host')throw stop();return row;
  }
  async function read() {
    const row=(await query(`/* studio:read */ SELECT a.* FROM voice_assets a JOIN voice_text_items t ON t.id=a.text_item_id
      WHERE t.text_id=$1 AND t.text_hash=$2 AND a.voice_profile_id=$3 AND a.text_hash=$2`,[assetId,textHash,profile.id])).rows[0];
    if(!row)return null;
    const envelope=row.provider_response_json?.[MARKER],body=open(envelope);
    if(row.asset_status!==(body.state==='ready'?'ready':`studio_${body.state}`))throw stop();
    return {row,envelope,body};
  }
  async function transition(states,change,{takeover=false,fields={}}={}) {
    const old=await read();
    if(!old||!states.includes(old.body.state)||!takeover&&old.body.owner!==owner)throw stop();
    const body=change({...old.body});body.owner=owner;
    const envelope=seal(body),status=body.state==='ready'?'ready':`studio_${body.state}`;
    const result=await query(`/* studio:transition */ UPDATE voice_assets SET asset_status=$1,
      provider_response_json=jsonb_build_object($2::text,$3::jsonb),updated_at=now(),
      storage_key=COALESCE($7,storage_key),audio_url=COALESCE($8,audio_url),mime_type=COALESCE($9,mime_type),duration_ms=COALESCE($10,duration_ms)
      WHERE id=$4 AND asset_status=$5 AND provider_response_json->$2::text=$6::jsonb RETURNING *`,
      [status,MARKER,JSON.stringify(envelope),old.row.id,old.row.asset_status,JSON.stringify(old.envelope),
       fields.storageKey||null,fields.audioUrl||null,fields.mimeType||null,fields.durationMs??null]);
    if(result.rows.length!==1)throw stop();return {row:result.rows[0],body};
  }
  function accounting(previous,next) {
    if(!next)return previous;
    const merged={...previous,...next,providerRequestId:next.providerRequestId||previous.providerRequestId};
    if(previous.costStatus==='actual'&&next.costStatus!=='actual')return {...merged,costStatus:'actual',actualMicrousd:previous.actualMicrousd};
    if(previous.costStatus==='estimated'&&next.costStatus==='unknown')return {...merged,costStatus:'estimated',estimatedMicrousd:previous.estimatedMicrousd};
    return merged;
  }
  async function guarded(fn) {try{return await fn();}catch{throw stop();}}
  const journal={
    get:k=>guarded(async()=>{await verify(k);const data=await read();if(!data)return null;
      if(data.body.state==='ready'&&(data.row.storage_key!==assetId||data.row.audio_url!==assetId||data.row.mime_type!=='audio/mpeg'||!data.body.bytesHash))throw stop();
      return {application:'voice-studio',status:data.body.state,accounting:data.body.accounting,asset_id:assetId,audioSha256:data.body.bytesHash,
        ...(data.body.recovery?{recovery:data.body.recovery}:{})};}),
    claim:(k,record)=>guarded(async()=>{
      await verify(k);if(record?.application!=='voice-studio'||record.status!=='dispatching')throw stop();
      const text=await textItem();
      const body={version:1,key,application:'voice-studio',owner,state:'pending',accounting:emptyAccounting()};
      const result=await query(`/* studio:claim */ INSERT INTO voice_assets(text_item_id,voice_profile_id,text_hash,storage_type,asset_status,provider_response_json,generation_provider,generation_model)
        VALUES($1,$2,$3,'permanent','studio_pending',jsonb_build_object($4::text,$5::jsonb),'heygen','eleven_multilingual_v2')
        ON CONFLICT(text_item_id,voice_profile_id,text_hash) DO NOTHING RETURNING *`,[text.id,profile.id,textHash,MARKER,JSON.stringify(seal(body))]);
      if(!result.rows.length)return false;
      // Persist the attempted marker BEFORE provider dispatch. Lost acknowledgement never permits retry.
      await transition(['pending'],b=>({...b,state:'dispatching'}));return true;
    }),
    saveRecovery:(k,recovery)=>guarded(async()=>{
      await verify(k);
      if(recovery?.voiceId!==TIZIANA_ID||recovery.textHash!==textHash||typeof recovery.audioUrl!=='string'||
        !recovery.requestId||recovery.engine!=='elevenlabs'||recovery.requestedModel!==profile.model)throw stop();
      await transition(['dispatching'],b=>({...b,state:'generated',recovery,
        accounting:{...b.accounting,providerRequestId:recovery.requestId}}));
    }),
    claimRecovery:k=>guarded(async()=>{await verify(k);const old=await read();
      if(!old||!['generated','downloaded','stored','recoverable'].includes(old.body.state)||!old.body.recovery)return false;
      try {await transition([old.body.state],b=>({...b,state:'recovering'}),{takeover:true});return true;}catch{return false;}
    }),
    markDownloaded:(k,buffer)=>guarded(async()=>{await verify(k);
      if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20*1024*1024)throw stop();
      await transition(['generated','recovering'],b=>{
        const bytesHash=sha(buffer);if(b.bytesHash&&b.bytesHash!==bytesHash)throw stop();
        return {...b,state:'downloaded',bytesHash,byteLength:buffer.length};});
    }),
    markStored:k=>guarded(async()=>{await verify(k);await transition(['downloaded'],b=>({...b,state:'stored'}));}),
    finish:(k,record)=>guarded(async()=>{await verify(k);
      if(record?.application!=='voice-studio')throw stop();
      if(record.status==='ready')await transition(['stored'],b=>({...b,state:'ready',accounting:accounting(b.accounting,record.accounting)}),
        {fields:{storageKey:assetId,audioUrl:assetId,mimeType:'audio/mpeg'}});
      else if(['uncertain','recoverable'].includes(record.status))await transition(['dispatching','generated','downloaded','stored','recovering'],b=>
        ({...b,state:b.recovery?'recoverable':'uncertain',accounting:accounting(b.accounting,record.accounting)}));
      else throw stop();
    })
  };
  // Inject these operations ONLY into the disabled Studio route's shared generation pipeline.
  journal.pipeline={
    getOrCreateTextItem:args=>guarded(async()=>{await verify(key);if(args.textId!==assetId||args.textHash!==textHash||args.sourceText!==HOST_TEXT)throw stop();return textItem();}),
    findExistingAsset:args=>guarded(async()=>{await verify(key);const data=await read();
      if(!data||args.textItemId!==data.row.text_item_id||args.voiceProfileId!==profile.id||args.textHash!==textHash)throw stop();
      // Normal cache reuse is handled by journal.get; a recovery never bypasses guarded transitions.
      return null;}),
    upsertVoiceAsset:args=>guarded(async()=>{await verify(key);
      if(args.textHash!==textHash||args.voiceProfileId!==profile.id||args.storageKey!==assetId||args.audioUrl!==assetId||args.mimeType!=='audio/mpeg')throw stop();
      const old=await read();if(args.textItemId!==old?.row.text_item_id)throw stop();
      return (await transition(['stored'],b=>b,{fields:{storageKey:assetId,audioUrl:assetId,mimeType:'audio/mpeg',durationMs:args.durationMs}})).row;
    })
  };
  return journal;
}
