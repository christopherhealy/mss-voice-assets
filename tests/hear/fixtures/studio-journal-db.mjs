import assert from 'node:assert/strict';
import {JOURNAL_PROTECTION_KEY as marker} from '../../../lib/upsertVoiceAsset.js';
export function database(){
 const state={text:null,asset:null,queries:[],before:null,after:null};
 const db={async query(sql,v=[]){
 const tag=sql.match(/studio:([a-z-]+)/)?.[1];state.queries.push({tag,sql,v});
 if(state.before)state.before(tag);
 let rows=[];
 if(tag==='identity')rows=[{name:'ingle_qa_db'}];
 else if(tag==='profile')rows=[{id:17}];
 else if(tag==='insert-text'){if(!state.text){state.text={id:11,text_id:v[0],text_hash:v[1],source_text:v[2],text_type:'studio_synthetic_host'};rows=[state.text];}}
 else if(tag==='read-text')rows=state.text?[state.text]:[];
 else if(tag==='read')rows=state.asset?[state.asset]:[];
 else if(tag==='claim'){
 assert.match(sql,/ON CONFLICT\(text_item_id,voice_profile_id,text_hash\) DO NOTHING RETURNING/i);
 if(!state.asset){state.asset={id:23,text_item_id:v[0],voice_profile_id:v[1],text_hash:v[2],asset_status:'studio_pending',provider_response_json:{[v[3]]:JSON.parse(v[4])}};rows=[state.asset];}}
 else if(tag==='transition'){
 assert.match(sql,/WHERE id=\$4 AND asset_status=\$5 AND provider_response_json->\$2::text=\$6::jsonb RETURNING/i);
 const a=state.asset;
 if(a?.id===v[3]&&a.asset_status===v[4]&&JSON.stringify(a.provider_response_json[v[1]])===JSON.stringify(JSON.parse(v[5]))){
 a.asset_status=v[0];a.provider_response_json={[v[1]]:JSON.parse(v[2])};
 for(const [field,index]of [['storage_key',6],['audio_url',7],['mime_type',8],['duration_ms',9]])if(v[index]!==null)a[field]=v[index];rows=[a];}}
 else if(sql.includes('insert into voice_assets')){
 assert.match(sql,/where not \(voice_assets.provider_response_json \? \$19::text\)/i);
 if(!Object.hasOwn(state.asset?.provider_response_json||{},v[18]))throw Error('unexpected ordinary write');
 }else throw Error('Unexpected SQL');
 const result={rows:structuredClone(rows),rowCount:rows.length};if(state.after)state.after(tag);return result;
 }};return {db,state};
}
