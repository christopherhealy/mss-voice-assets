// Run ONLY in the target QA instance's authenticated operator Shell.
import {writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
const services=new Set(['mss-ingle-qa','mss-voice-assets-qa']);
const service=process.env.RENDER_SERVICE_NAME,mode=process.argv[2];
if(process.env.INGLE_QA_DRAIN_ARMED!=='true'||!services.has(service)||!['drain','pause','freeze','resume-workers','resume','renew'].includes(mode))throw Error('explicit_qa_service_and_mode_required');
const port=Number(process.env.PORT);if(!Number.isSafeInteger(port)||port<1||port>65535||!process.env.INGLE_VOICE_SERVICE_SECRET)throw Error('operator_status_configuration_required');
const response=await fetch(`http://127.0.0.1:${port}/_qa/drain/status`,{headers:{Authorization:'Bearer '+process.env.INGLE_VOICE_SERVICE_SECRET},signal:AbortSignal.timeout(5000)});
if(!response.ok)throw Error('local_status_unavailable');const status=await response.json();if(!status.ok||status.enabled!==true||status.service!==service||!status.verified)throw Error('qa_identity_unverified');
const next={version:1,service,instance:status.instance,admissions:status.state.admissions,workersPaused:status.state.workersPaused,freeze:status.state.freeze,expiresAt:Date.now()+3600000};
if(mode==='drain')next.admissions=false;
if(mode==='pause')next.workersPaused=true;
if(mode==='resume-workers'){next.freeze=false;next.workersPaused=false;next.admissions=false;}
if(mode==='resume'){if(next.freeze||next.workersPaused)throw Error('resume_workers_first');next.admissions=true;}
if(mode==='renew'&&!status.state.valid)throw Error('cannot_renew_uncertain_state');
if(mode==='freeze'){
 if(process.env.INGLE_QA_DRAIN_BOOT_PHASE!=='freeze'||status.bootPhase!=='freeze')throw Error('durable_freeze_boot_phase_required');
 if(next.admissions||!next.workersPaused||Object.values(status.counts).some(n=>n!==0))throw Error('local_work_not_drained');
 const u=new URL(process.env.DATABASE_URL||'');if(!/^dpg-db74c5rncjis73ffmhcg-a(?:\.|$)/.test(u.hostname)||u.pathname!=='/ingle_qa_db'||decodeURIComponent(u.username)!=='ingle_qa_db_user')throw Error('wrong_qa_database');
 const pool=new Pool({host:'dpg-db74c5rncjis73ffmhcg-a.oregon-postgres.render.com',port:5432,database:'ingle_qa_db',user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),ssl:{rejectUnauthorized:true},sslnegotiation:'postgres',max:1,options:'-c default_transaction_read_only=on -c statement_timeout=10000',connectionTimeoutMillis:10000});
 try{
 const identity=(await pool.query('SELECT current_database() AS name')).rows[0];if(identity.name!=='ingle_qa_db')throw Error('wrong_qa_database');
 const result=(await pool.query(`SELECT
 (SELECT count(*) FROM ingle_live_grants WHERE finalized_at IS NULL AND (consumed_at IS NOT NULL OR expires_at>now()))+
 (SELECT count(*) FROM ingle_live_lifecycle_events WHERE event_type='session_closed' AND (processing_status IN ('pending','retry','processing') OR (processing_status='manual_review' AND NOT EXISTS (SELECT 1 FROM ingle_live_grants g WHERE g.grant_uid=ingle_live_lifecycle_events.grant_uid AND g.finalized_at IS NOT NULL))))+
 (SELECT count(*) FROM ingle_live_lifecycle_events e WHERE NOT EXISTS (SELECT 1 FROM ingle_live_grants g WHERE g.grant_uid=e.grant_uid) AND e.processing_status<>'completed')+
 (SELECT count(*) FROM ingle_vox_retry_queue WHERE status='processing')+
 (SELECT count(*) FROM fluently_scene_adaptation_jobs WHERE status IN ('calling','uncertain'))+
 (SELECT count(*) FROM ingle_character_generations WHERE generation_status='generating')+
 (SELECT count(*) FROM ingle_gallery_video_jobs WHERE status IN ('generating','processing','calling','submitted')) AS obligations`)).rows[0];if(Number(result.obligations)!==0)throw Error('database_work_not_drained');
 }finally{await pool.end();}
 next.freeze=true;
}
// The default file is instance-local and private, never a browser-provided path.
const file='/tmp/ingle-qa-drain-state.json',temp=file+'.'+randomUUID();
await writeFile(temp,JSON.stringify(next)+'\n',{mode:0o600,flag:'wx'});await rename(temp,file);
const ackResponse=await fetch(`http://127.0.0.1:${port}/_qa/drain/status`,{headers:{Authorization:'Bearer '+process.env.INGLE_VOICE_SERVICE_SECRET},signal:AbortSignal.timeout(5000)});
if(!ackResponse.ok)throw Error('state_acknowledgement_unavailable');const ack=await ackResponse.json();
if(ack.instance!==status.instance||!ack.state.valid||['admissions','workersPaused','freeze'].some(k=>ack.state[k]!==next[k])||(mode==='freeze'&&Object.values(ack.counts).some(n=>n!==0)))throw Error('state_acknowledgement_mismatch');
console.log(JSON.stringify({ok:true,service,instance:status.instance,mode,expiresAt:next.expiresAt}));
