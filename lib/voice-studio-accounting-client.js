// Local-only, authenticated callback to Voice Studio's existing AI usage ledger.
// This client never receives provider credentials or audio recovery metadata.
const PATH='/api/internal/voiceassets/heygen-accounting';
const fail=()=>Error('voice_studio_accounting_unavailable');

function callbackUrl(value) {
  let url;
  try { url=new URL(value); } catch { throw fail(); }
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||
    url.pathname!==PATH||url.port!=='3117')throw fail();
  return url.href;
}

async function responseJson(response) {
  if(!response||response.status<200||response.status>=300||response.redirected)throw fail();
  const length=Number(response.headers?.get?.('content-length')||0);
  if(length>2048)throw fail();
  let text;
  try { text=await response.text(); } catch { throw fail(); }
  if(typeof text!=='string'||Buffer.byteLength(text)>2048)throw fail();
  try { return JSON.parse(text); } catch { throw fail(); }
}

export function createVoiceStudioAccountingClient({env=process.env,fetchImpl=globalThis.fetch}={}) {
  if(env.NODE_ENV!=='development'||env.RENDER_SERVICE_NAME||typeof fetchImpl!=='function')throw fail();
  const url=callbackUrl(env.VOICE_STUDIO_ACCOUNTING_CALLBACK_URL);
  const secret=env.VOICE_STUDIO_LOCAL_AUDIO_SERVICE_SECRET;
  // Sharing the dedicated Voice Studio local secret with the callback receiver is allowed;
  // the Ingle shared service secret is specifically rejected.
  if(typeof secret!=='string'||secret.length<32||secret===env.INGLE_VOICE_SERVICE_SECRET)throw fail();
  async function send(body) {
    let response;
    try { response=await fetchImpl(url,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',
      headers:{Authorization:`Bearer ${secret}`,'X-Service-ID':'voice-assets-qa','Content-Type':'application/json',Accept:'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(5000)}); } catch { throw fail(); }
    return responseJson(response);
  }
  return Object.freeze({
    async claim({generation_key,input_characters,attribution}) {
      const result=await send({phase:'claim',generation_key,input_characters,...(attribution?{attribution}:{})});
      if(result.ok!==true||result.recorded!==true&&!(result.recorded===false&&result.existing===true))throw fail();
      return {recorded:result.recorded===true,existing:result.existing===true};
    },
    async outcome({generation_key,input_characters,...outcome}) {
      const result=await send({phase:'outcome',generation_key,input_characters,...outcome});
      if(result.ok!==true||result.recorded!==true)throw fail();
      return {recorded:true};
    }
  });
}

export const voiceStudioAccountingPath=PATH;
