// QA operator controls. No Member/browser identity participates in this boundary.
import {readFileSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {Pool,Client} from 'pg';
export const STATE_FILE='/tmp/ingle-qa-drain-state.json';
const services=new Set(['mss-ingle-qa','mss-voice-assets-qa']);
export function createDrain({env=process.env,read=()=>{const fd=openSync(STATE_FILE,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||(s.mode&0o077)||s.uid!==process.getuid())throw Error();return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}},now=Date.now,instance=randomUUID()}={}){
 const counts={requests:0,providers:0,background:0,completion:0,supervisors:0,queries:0};
 const context=new AsyncLocalStorage();let verified=false,freezeLatched=false;
 const qaService=()=>services.has(env.RENDER_SERVICE_NAME);
 const enabled=()=>qaService()&&env.INGLE_QA_DRAIN_ARMED!==undefined&&env.INGLE_QA_DRAIN_ARMED!=='false';
 function state(){if(!enabled())return {admissions:true,workersPaused:false,freeze:false,valid:true};try{if(env.INGLE_QA_DRAIN_ARMED!=='true'||!['drain','freeze'].includes(env.INGLE_QA_DRAIN_BOOT_PHASE??'drain'))throw Error();const s=read();if(Object.keys(s).sort().join(',')!=='admissions,expiresAt,freeze,instance,service,version,workersPaused'||s.version!==1||s.service!==env.RENDER_SERVICE_NAME||s.instance!==instance||typeof s.admissions!=='boolean'||typeof s.workersPaused!=='boolean'||typeof s.freeze!=='boolean'||!Number.isSafeInteger(s.expiresAt)||s.expiresAt<=now()||s.expiresAt>now()+3600000)throw Error();if(s.freeze&&(!s.workersPaused||s.admissions||env.INGLE_QA_DRAIN_BOOT_PHASE!=='freeze'))throw Error();freezeLatched=s.freeze;return {...s,valid:true};}catch{return {admissions:false,workersPaused:true,freeze:freezeLatched||env.INGLE_QA_DRAIN_BOOT_PHASE==='freeze'||![undefined,'drain'].includes(env.INGLE_QA_DRAIN_BOOT_PHASE),valid:false};}}
 function error(){return Object.assign(Error('qa_drain_unavailable'),{code:'qa_drain_unavailable',status:503});}
 function admission(){if(enabled()&&(!verified||!state().admissions||state().freeze||(state().workersPaused&&!context.getStore())))throw error();}
 function worker(completion=false){if(!enabled())return true;const s=state();return verified&&!s.freeze&&(completion||(!s.workersPaused&&s.admissions));}
 function frozen(){return enabled()&&state().freeze;}
 function track(kind){counts[kind]++;let done=false;return()=>{if(!done){done=true;counts[kind]--;}};}
 async function task(kind,fn){if(!worker(kind==='completion'))return {paused:true};const done=track(kind);try{return await context.run({kind,admitted:true},fn);}finally{done();}}
 async function verify(db){if(!qaService())return;let timer;try{const result=context.run({bootstrap:true},()=>db.query('SELECT current_database() AS name'));const r=await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('qa_identity_timeout')),5000);})]);verified=r.rows[0]?.name==='ingle_qa_db';}catch{verified=false;}finally{clearTimeout(timer);}return verified;}
 function auth(req){const secret=env.INGLE_VOICE_SERVICE_SECRET;const got=String(req.headers.authorization||'');if(!secret)return false;const a=Buffer.from(got),b=Buffer.from('Bearer '+secret);return a.length===b.length&&timingSafeEqual(a,b);}
 function completionRoute(req){return req.method==='POST'&&/^\/api\/ingles\/(?:experiences|fluently)\/live\/session-(?:started|closed)$/.test(req.path);}
 function middleware(req,res,next){if(!qaService())return next();
  const path=req.path;
  if(path==='/_qa/drain/status'){
   res.setHeader('Cache-Control','no-store');if(req.method!=='GET'||!auth(req))return res.status(404).json({ok:false,error:'not_found'});
   return res.json({ok:true,instance,service:env.RENDER_SERVICE_NAME,enabled:enabled(),bootPhase:env.INGLE_QA_DRAIN_BOOT_PHASE??'drain',verified,state:state(),counts:{...counts}});
  }
  if(!enabled()||path==='/health')return next();
  const s=state();const callback=completionRoute(req)||(req.method==='POST'&&path==='/api/ingles/member/minutes/webhook');
  // Existing callback handlers still authenticate and validate grant/session association.
  if(s.freeze)return res.status(503).set('Cache-Control','no-store').json({ok:false,error:'qa_drain_unavailable'});
  if(env.RENDER_SERVICE_NAME==='mss-voice-assets-qa'&&['GET','HEAD'].includes(req.method)&&path==='/api/conversation/health')return next();
  const authRoute=(req.method==='GET'&&/^\/api\/ingles\/member\/(?:status|minutes\/balance|subscriptions\/status|feature-access)$/.test(path))||/^\/api\/ingles\/member\/(?:auth(?:\/|$)|signout$|handoff(?:\/|$))/.test(path)||/^\/auth\//.test(path);
  const persist=req.method==='POST'&&(/^\/api\/ingles\/experiences\/frames\/[1-9]\d*\/(?:turns|usage|pause)$/.test(path)||/^\/api\/ingles\/fluently\/scenes\/[0-9a-f-]+\/(?:events|complete)$/.test(path));
  const staticRead=req.method==='GET'&&!path.startsWith('/api/')&&!path.startsWith('/auth/');
  if(s.workersPaused&&path.startsWith('/api/voice/')&&req.method!=='GET')return res.status(503).set('Cache-Control','no-store').json({ok:false,error:'qa_background_paused'});
  if(!callback&&!authRoute&&!persist&&!staticRead&&(!verified||!s.admissions))return res.status(503).set('Cache-Control','no-store').json({ok:false,error:'qa_drain_unavailable'});
  const done=track(callback?'completion':'requests');res.once('finish',done);res.once('close',done);return context.run({callback,auth:authRoute,kind:'request'},next);
 }
 function guardedFetch(base){return async(input,options)=>{
  if(!enabled())return base(input,options);
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  const trustedCompletion=url.origin==='https://mss-ingle-qa.onrender.com'&&/^\/api\/ingles\/(?:experiences|fluently)\/live\/session-(?:started|closed)$/.test(url.pathname);
  const provider=(!context.getStore()?.auth&&!trustedCompletion)||/(^|\.)(openai\.com|elevenlabs\.io|heygen\.com)$/.test(url.hostname)||url.hostname==='mss-voice-assets-qa.onrender.com';
  if(provider)admission();
  const done=provider?track('providers'):()=>{};
  try{const response=await base(input,options);if(!provider||!response.body){done();return response;}
   const reader=response.body.getReader();return new Response(new ReadableStream({async pull(controller){try{const x=await reader.read();if(x.done){done();controller.close();}else controller.enqueue(x.value);}catch(e){done();controller.error(e);}},async cancel(reason){try{await reader.cancel(reason);}finally{done();}}}),{status:response.status,statusText:response.statusText,headers:response.headers});
  }catch(e){done();throw e;}
 };}
 function queryAllowed(sql){if(!enabled())return true;if(/^\s*ROLLBACK\b/i.test(String(sql?.text??sql)))return true;const ctx=context.getStore();if(ctx?.bootstrap&&String(sql?.text??sql)==='SELECT current_database() AS name')return true;if(frozen())return false;return !state().workersPaused||Boolean(ctx&&(ctx.bootstrap||ctx.callback||ctx.kind==='completion'||ctx.admitted||ctx.kind==='request'));}
 return {enabled,state,admission,worker,frozen,queryAllowed,track,task,verify,middleware,guardedFetch,status:()=>({instance,verified,state:state(),counts:{...counts}})};
}
export const qaDrain=createDrain();
// Install before imported SDK instances capture fetch. Production is a transparent pass-through.
if(globalThis.fetch)globalThis.fetch=qaDrain.guardedFetch(globalThis.fetch);
// Covers ordinary pool/client SQL from private callers and detached jobs in this process.
// Final freeze is operator-only and MUST follow zero in-flight/SQL verification.
for(const prototype of [Pool.prototype,Client.prototype]){const original=prototype.query;prototype.query=function(...args){if(!qaDrain.enabled())return original.apply(this,args);if(!qaDrain.queryAllowed(args[0]))throw Object.assign(Error('qa_drain_frozen'),{code:'qa_drain_frozen'});const done=qaDrain.track('queries');try{if(typeof args.at(-1)==='function'){const cb=args.at(-1);args[args.length-1]=(...v)=>{done();cb(...v);};return original.apply(this,args);}const result=original.apply(this,args);if(result?.then)return result.finally(done);done();return result;}catch(e){done();throw e;}};}
