// Private QA-only Scene audio adapter. Generic voice routes never receive this key.
import {timingSafeEqual} from 'node:crypto';
import {pool} from '../lib/db.js';
import {getOrCreateVoiceAsset} from '../lib/getOrCreateVoiceAsset.js';
import {generateSpeech} from '../lib/generateSpeech.elevenlabs.js';
import {hashText} from '../lib/hashText.js';
const voices=new Set(['ZX5x7KzQ9elPznG4bv3T','gRvYX74pTqIZPvUtIqog']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createFluentlyAudioHandler({db=pool,render=getOrCreateVoiceAsset,generate=generateSpeech,env=process.env}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const fail=(status,error)=>res.status(status).json({ok:false,error});
  if(env.RENDER_SERVICE_NAME!=='mss-voice-assets-qa')return fail(404,'not_found');
  const secret=env.INGLE_VOICE_SERVICE_SECRET||'',supplied=String(req.headers.authorization||'').replace(/^Bearer /,'');
  if(!secret||Buffer.byteLength(secret)!==Buffer.byteLength(supplied)||!timingSafeEqual(Buffer.from(secret),Buffer.from(supplied)))return fail(401,'service_authorization_required');
  if(!['GET','POST'].includes(req.method))return fail(405,'method_not_allowed');
  try{
   if((await db.query('SELECT current_database() name')).rows[0]?.name!=='ingle_qa_db')return fail(503,'qa_database_required');
   const ready=!!env.FLUENTLY_HEAR_ELEVENLABS_API_KEY&&env.R2_BUCKET==='ingle-audio-qa'&&['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_PUBLIC_BASE_URL'].every(k=>!!env[k]);
   if(req.method==='GET')return res.json({ok:true,ready,database:'ingle_qa_db',provider:'elevenlabs',model:'eleven_multilingual_v2',storage_bucket:ready?'ingle-audio-qa':null});
   if(!ready)return fail(503,'hear_configuration_required');
   const b=req.body||{},m=b.metadata||{},text=String(b.text||'').replace(/\s+/g,' ').trim();
   if(b.text_type!=='fluently_scene_turn'||b.storage_type!=='permanent'||!voices.has(b.voice_profile_id)||!uuid.test(m.scene_id||'')||!Number.isSafeInteger(m.revision)||m.revision<1||!/^[a-f0-9]{64}$/.test(m.plan_id||'')||!text||text.length>10000)return fail(400,'hear_request_invalid');
   const profile=(await db.query("SELECT id FROM voice_profiles WHERE voice_code=$1 AND provider='elevenlabs' AND language='it' AND is_active",[b.voice_profile_id])).rows[0];
   const hash=hashText(text);
   if(!profile||b.text_id!==`fluently:qa:hear:it:${profile.id}:${hash}`)return fail(400,'hear_identity_invalid');
   const speaker=b.voice_profile_id==='ZX5x7KzQ9elPznG4bv3T'?'Giulia':'You';
   const out=await render({textId:b.text_id,textType:'fluently_scene_turn',text,storageType:'permanent',voiceProfileCode:b.voice_profile_id,metadata:{product:'fluently',environment:'qa',...m},
    storageKeyOverride:`qa/fluently/hear/${m.scene_id}/r${m.revision}/it/${speaker}/${b.voice_profile_id}/${hash}.mp3`,
    generateSpeechImpl:args=>generate({...args,apiKey:env.FLUENTLY_HEAR_ELEVENLABS_API_KEY,modelId:'eleven_multilingual_v2'})});
   return res.json({ok:true,cache_hit:out.cacheHit,voice_asset_id:out.asset.id,voice_profile_id:out.voiceProfile.voice_code,text_hash:out.textHash,asset_status:out.asset.asset_status,audio_url:out.asset.audio_url,generation_provider:out.asset.generation_provider,generation_model:out.asset.generation_model});
  }catch{return fail(502,'hear_render_unconfirmed');}
 };
}
