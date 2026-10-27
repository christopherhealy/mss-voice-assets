// Opt-in: ONLY a newly created disposable Unix-socket PostgreSQL cluster.
import test from 'node:test';
import assert from 'node:assert/strict';
import {lstatSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createVoiceStudioJournal} from '../../lib/voice-studio-journal.js';
import {upsertVoiceAsset} from '../../lib/upsertVoiceAsset.js';
import {HOST_TEXT,TIZIANA_ID} from '../../lib/generateSpeech.heygen.js';
import {cacheIdentity} from '../../routes/voice-studio-audio.js';
const socket=process.env.VOICE_STUDIO_JOURNAL_TEST_SOCKET;
test('isolated PostgreSQL journal SQL, conflict locking and cross-process recovery',{skip:!socket},async()=>{
 assert.match(socket,/^\/private\/tmp\/voiceassets-journal-pg264\.[A-Za-z0-9_-]+$/);
 const stat=lstatSync(socket);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(stat.uid,process.getuid());assert.equal(stat.mode&0o077,0);assert.equal(realpathSync(socket),socket);
 const config={host:socket,port:56364,database:'ingle_qa_db',user:'studio_test',connectionTimeoutMillis:5000,options:'-c statement_timeout=5000 -c lock_timeout=3000'};
 const pool=new pg.Pool(config);let a,b;
 const profile={id:17,approved:true,provider:'heygen',actor:'julie',voice:'tiziana',language:'it',voiceId:TIZIANA_ID,engine:'elevenlabs',model:'eleven_multilingual_v2',version:1,settings:{speed:1}};
 const key=cacheIdentity(HOST_TEXT,profile),encryptionKey=Buffer.alloc(32,7),keyId='synthetic-test-key-v1';
 const journal=db=>createVoiceStudioJournal({db,encryptionKey,keyId,profile});
 const claim=j=>j.claim(key,{application:'voice-studio',status:'dispatching'});
 try {
  // Synthetic fixture schema only, inside an expendable database. Not an application migration.
  await pool.query(`CREATE TABLE voice_profiles(id bigint PRIMARY KEY,voice_code text,provider text,language text,is_active boolean);
    INSERT INTO voice_profiles VALUES(17,'${TIZIANA_ID}','heygen','it',true);
    CREATE TABLE voice_text_items(id bigserial PRIMARY KEY,text_id text NOT NULL,text_hash text NOT NULL,text_type text NOT NULL,source_text text NOT NULL,storage_type text NOT NULL,metadata_json jsonb NOT NULL DEFAULT '{}',UNIQUE(text_id,text_hash));
    CREATE TABLE voice_assets(id bigserial PRIMARY KEY,text_item_id bigint NOT NULL REFERENCES voice_text_items(id) ON DELETE CASCADE,voice_profile_id bigint NOT NULL REFERENCES voice_profiles(id),text_hash text NOT NULL,storage_type text NOT NULL,asset_status text NOT NULL DEFAULT 'pending',provider_response_json jsonb NOT NULL DEFAULT '{}',storage_key text,audio_url text,mime_type text,duration_ms integer,expires_at timestamptz,generation_provider text,generation_model text,persona_code text,character_count integer,generation_ms integer,generation_cost_usd numeric(12,8),provider_request_id text,updated_at timestamptz DEFAULT now(),UNIQUE(text_item_id,voice_profile_id,text_hash));`);
  a=await pool.connect();b=await pool.connect();await a.query('BEGIN');await b.query('BEGIN');
  assert.equal(await claim(journal(a)),true);
  let settled=false;const competing=claim(journal(b)).finally(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(settled,false,'competing identity waits on unique conflict');
  await a.query('ROLLBACK');assert.equal(await competing,true);await b.query('ROLLBACK');
  assert.equal(Number((await pool.query('SELECT count(*) n FROM voice_assets')).rows[0].n),0);
  // Actual ordinary INSERT SELECT is executable, preserves unprotected updates, rejects protected rows.
  await a.query('BEGIN');
  const j=journal(a);await claim(j);const record=(await a.query('SELECT * FROM voice_assets')).rows[0];
  await assert.rejects(upsertVoiceAsset({textItemId:record.text_item_id,voiceProfileId:17,textHash:record.text_hash,storageType:'permanent',providerResponseJson:{}},{db:a}),{code:'VOICE_ASSET_JOURNAL_CONFLICT'});
  await assert.rejects(upsertVoiceAsset({textItemId:record.text_item_id,voiceProfileId:17,textHash:'new',storageType:'permanent',providerResponseJson:{_voice_studio_journal_v1:false}},{db:a}),{code:'VOICE_ASSET_JOURNAL_CONFLICT'});
  const ordinary={textItemId:record.text_item_id,voiceProfileId:17,textHash:'ordinary',storageType:'permanent',assetStatus:'ready',storageKey:'first'};
  const one=await upsertVoiceAsset(ordinary,{db:a});const two=await upsertVoiceAsset({...ordinary,storageKey:'second'},{db:a});assert.equal(one.id,two.id);assert.equal(two.storage_key,'second');
  await a.query('ROLLBACK');
  a.release();a=null;b.release();b=null;
  // Commit synthetic evidence only in disposable cluster to verify survival across a real process boundary.
  const first=journal(pool);assert.equal(await claim(first),true);
  await first.saveRecovery(key,{version:1,voiceId:TIZIANA_ID,textHash:(await pool.query('SELECT text_hash FROM voice_assets')).rows[0].text_hash,audioUrl:'https://files.heygen.ai/audio/mock.mp3?signature=synthetic',requestId:'test-request',duration:5.46,engine:'elevenlabs',requestedModel:profile.model});
  const child=`import pg from ${JSON.stringify(new URL('../../node_modules/pg/esm/index.mjs',import.meta.url).href)};
    import {createVoiceStudioJournal} from ${JSON.stringify(new URL('../../lib/voice-studio-journal.js',import.meta.url).href)};
    const pool=new pg.Pool(${JSON.stringify(config)});
    try{const j=createVoiceStudioJournal({db:pool,encryptionKey:Buffer.alloc(32,7),keyId:${JSON.stringify(keyId)},profile:${JSON.stringify(profile)}});
    const old=await j.get(${JSON.stringify(key)});if(old.status!=='generated'||old.recovery.requestId!=='test-request')throw Error();
    if(await j.claim(${JSON.stringify(key)},{application:'voice-studio',status:'dispatching'}))throw Error();
    if(!await j.claimRecovery(${JSON.stringify(key)}))throw Error();
    await j.markDownloaded(${JSON.stringify(key)},Buffer.from('ID3 synthetic'));await j.markStored(${JSON.stringify(key)});
    console.log('restart recovery passed');}finally{await pool.end();}`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',child],{encoding:'utf8',env:{PATH:process.env.PATH,DOTENV_CONFIG_PATH:'/dev/null'},timeout:15000,stdio:['ignore','pipe','pipe']});
  assert.match(output,/restart recovery passed/);
  assert.equal((await journal(pool).get(key)).status,'stored');
  const json=JSON.stringify((await pool.query('SELECT provider_response_json FROM voice_assets')).rows);
  assert.doesNotMatch(json,/signature=|test-request|https:/);
 }finally{if(a){await a.query('ROLLBACK').catch(()=>{});a.release();}if(b){await b.query('ROLLBACK').catch(()=>{});b.release();}await pool.end();}
});
