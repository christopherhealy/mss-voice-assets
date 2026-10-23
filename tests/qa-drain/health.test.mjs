import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createDrain} from '../../lib/qa-drain.js';

// Execute the existing health registration alone: no provider, pool or HTTP server.
const source=readFileSync(new URL('../../routes/conversation.routes.js',import.meta.url),'utf8');
const start=source.indexOf('router.get("/health"');
const end=source.indexOf('// Read-only Experience context',start);
assert.ok(start>=0&&end>start);
let conversationHealth;
vm.runInNewContext(source.slice(start,end),{router:{get(path,handler){assert.equal(path,'/health');conversationHealth=handler;}}});

async function fixture(service='mss-voice-assets-qa',freeze=false){
  const env={RENDER_SERVICE_NAME:service,INGLE_QA_DRAIN_ARMED:'true',INGLE_QA_DRAIN_BOOT_PHASE:freeze?'freeze':'drain',INGLE_VOICE_SERVICE_SECRET:'synthetic-only'};
  const state={version:1,service,instance:'fixture',admissions:false,workersPaused:freeze,freeze,expiresAt:2000};
  const drain=createDrain({env,instance:'fixture',now:()=>1000,read:()=>state});
  await drain.verify({query:async()=>({rows:[{name:'ingle_qa_db'}]})});
  return drain;
}
function request(drain,path,method='GET',authorization,handler=(_req,res)=>res.json({ok:true})){
  const req={path,method,headers:{...(authorization?{authorization}: {})}};
  const res=new EventEmitter();let calls=0;
  Object.assign(res,{code:200,setHeader(){},set(){return this;},status(code){this.code=code;return this;},json(body){this.body=body;this.emit('finish');return this;}});
  drain.middleware(req,res,()=>{calls++;handler(req,res);});
  return {code:res.code,body:res.body,calls};
}
test('root health remains accessible during drain',async()=>{
  assert.equal(request(await fixture(),'/health').code,200);
});
for(const method of ['GET','HEAD'])test(`existing Conversation health passes during drain: ${method}`,async()=>{
  const r=request(await fixture(),'/api/conversation/health',method,undefined,conversationHealth);
  assert.equal(r.code,200);assert.equal(r.calls,1);assert.equal(r.body.ok,true);assert.equal(r.body.module,'conversation');
});
for(const path of ['/api/conversation/live','/api/conversation/live/session','/api/ingles/experiences/live/authorize','/api/ingles/experiences/live/redeem','/api/ingles/fluently/live/redeem','/api/voice/stream-cache'])test(`new work remains blocked: ${path}`,async()=>{
  const r=request(await fixture(),path,'POST');assert.equal(r.code,503);assert.equal(r.calls,0);assert.equal(r.body.error,'qa_drain_unavailable');
});
test('health exemption is exact path and read-only, without a conversation prefix bypass',async()=>{
  const d=await fixture();
  for(const [path,method] of [['/api/conversation/health','POST'],['/api/conversation/health','PUT'],['/api/conversation/health','DELETE'],['/api/conversation/health','OPTIONS'],['/api/conversation/health/','GET'],['/api/conversation/health/session','GET'],['/api/conversation/healthz','GET'],['/api/conversation/context','GET']]){
    const r=request(d,path,method);assert.equal(r.code,503,`${method} ${path}`);assert.equal(r.calls,0);
  }
});
test('new exemption does not weaken final freeze',async()=>{
  const d=await fixture('mss-voice-assets-qa',true);
  assert.equal(request(d,'/api/conversation/health').code,503);
  assert.equal(request(d,'/health').code,200);
});
test('new exemption is Voice QA only',async()=>{
  assert.equal(request(await fixture('mss-ingle-qa'),'/api/conversation/health').code,503);
});
test('Production remains a transparent pass-through',async()=>{
  const d=createDrain({env:{RENDER_SERVICE_NAME:'mss-voice-assets-production',INGLE_QA_DRAIN_ARMED:'true',INGLE_QA_DRAIN_BOOT_PHASE:'freeze'},read:()=>assert.fail('Production read QA state')});
  assert.equal(request(d,'/api/conversation/health', 'GET',undefined,conversationHealth).code,200);
  assert.equal(request(d,'/api/conversation/live','POST').calls,1);
});
test('completion routes still reach downstream authentication without changing credentials',async()=>{
  const d=await fixture();let finalized=0;
  // Synthetic downstream contract: middleware must preserve and reach service auth.
  const protectedHandler=(req,res)=>{if(req.headers.authorization!=='Bearer synthetic-only')return res.status(401).json({error:'live_service_unauthorized'});finalized++;return res.json({ok:true});};
  for(const product of ['experiences','fluently'])for(const kind of ['started','closed']){
    const path=`/api/ingles/${product}/live/session-${kind}`;
    assert.equal(request(d,path,'POST',undefined,protectedHandler).code,401);
    assert.equal(request(d,path,'POST','Bearer wrong',protectedHandler).code,401);
    assert.equal(request(d,path,'POST','Bearer synthetic-only',protectedHandler).code,200);
    assert.equal(request(d,path+'/authorize','POST','Bearer synthetic-only',protectedHandler).code,503);
  }
  assert.equal(finalized,4);assert.equal(d.status().counts.completion,0);
});
test('operator status remains service-authenticated',async()=>{
  const d=await fixture();assert.equal(request(d,'/_qa/drain/status').code,404);
  assert.equal(request(d,'/_qa/drain/status','GET','Bearer synthetic-only').code,200);
});
