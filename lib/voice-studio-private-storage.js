// Single-line private object storage. No startup wiring or credentials are created here.
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {S3Client,PutObjectCommand,GetObjectCommand,HeadBucketCommand} from '@aws-sdk/client-s3';

function getStudioR2Client(env=process.env) {
  const {
    R2_ACCOUNT_ID,
    VOICE_STUDIO_R2_ACCESS_KEY_ID,
    VOICE_STUDIO_R2_SECRET_ACCESS_KEY
  } = env;

  if (!R2_ACCOUNT_ID ||
      !VOICE_STUDIO_R2_ACCESS_KEY_ID ||
      !VOICE_STUDIO_R2_SECRET_ACCESS_KEY) {
    throw Error('studio_private_audio_unavailable');
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: VOICE_STUDIO_R2_ACCESS_KEY_ID,
      secretAccessKey: VOICE_STUDIO_R2_SECRET_ACCESS_KEY
    }
  });
}
const error=()=>Error('studio_private_audio_unavailable');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX=20*1024*1024;
const mp3=bytes=>Buffer.isBuffer(bytes)&&bytes.length>2&&bytes.length<=MAX&&
  (bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224);
export function createVoiceStudioPrivateStorage({client=null,bucket=process.env.VOICE_STUDIO_R2_BUCKET,publicBucket=process.env.R2_BUCKET,
  privateBucketReviewed=false,encryptionKey,keyId,assetId,env=process.env}={}) {
  if(privateBucketReviewed!==true||!bucket||bucket===publicBucket||!/^[-a-z0-9]{3,63}$/.test(bucket)||
    !Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32||!/^[-a-zA-Z0-9_]{1,64}$/.test(keyId||'')||
    !/^studio:[a-f0-9]{64}$/.test(assetId||'')||typeof client?.send!=='function'&&typeof (client=getStudioR2Client(env))?.send!=='function')throw error();
  const secret=Buffer.from(encryptionKey),objectKey=`private/voice-studio/julie/it/l2-scripted-host/${assetId.slice(7)}.enc`;
  const aad=Buffer.from(JSON.stringify(['voice-studio-private-audio',1,keyId,assetId]));
  function scope(id=assetId) {if(env.RENDER_SERVICE_NAME!=='mss-voice-assets-qa'||id!==assetId)throw error();}
  async function read(id,{sha256}={}) {
    try {
      scope(id);
      const response=await client.send(new GetObjectCommand({Bucket:bucket,Key:objectKey}));
      if(response.ContentLength>MAX*2||!response.Body?.[Symbol.asyncIterator])throw error();
      let length=0;const parts=[];
      for await(const chunk of response.Body){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>MAX*2)throw error();parts.push(bytes);}
      const envelope=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(envelope.version!==1||envelope.key_id!==keyId)throw error();
      const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(envelope.iv,'base64'));
      decipher.setAAD(aad);decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
      // Do not stream unauthenticated plaintext: verify GCM before exposing any MP3 bytes.
      const bytes=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);
      if(!mp3(bytes)||sha256!==undefined&&sha(bytes)!==sha256)throw error();return bytes;
    }catch{throw error();}
  }
  return {
    preflight:async()=>{try{scope();await client.send(new HeadBucketCommand({Bucket:bucket}));}catch{throw error();}},
    write:async(id,bytes)=>{try{
      scope(id);if(!mp3(bytes))throw error();
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(aad);
      const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
      const body=Buffer.from(JSON.stringify({version:1,key_id:keyId,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
      await client.send(new PutObjectCommand({Bucket:bucket,Key:objectKey,Body:body,
        ContentType:'application/octet-stream',CacheControl:'no-store'}));
    }catch{throw error();}},
    read,
    open:async(id,options)=>Readable.from([await read(id,options)])
  };
}
