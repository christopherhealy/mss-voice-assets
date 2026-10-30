import 'dotenv/config';
import express from 'express';
import {createVoiceStudioLocalLearnerAudioHandler} from '../routes/voice-studio-local-learner-audio.js';

if(process.env.NODE_ENV!=='development'||process.env.RENDER_SERVICE_NAME||process.env.VOICE_ASSETS_LOCAL_TIZIANA_LEARNER_ENABLED!=='true'){
  throw Error('local_voice_studio_audio_disabled');
}
const handler=createVoiceStudioLocalLearnerAudioHandler({enabled:true});
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'192kb'}));
app.all('/api/voice/studio-local-learner-audio',handler);
app.use((_error,_req,res,_next)=>res.status(400).json({ok:false,error:'invalid_request'}));
const server=app.listen(3120,'127.0.0.1',()=>process.stdout.write('VoiceAssets local Tiziana Learner adapter listening on 127.0.0.1:3120\n'));
const close=()=>server.close(()=>process.exit(0));process.once('SIGINT',close);process.once('SIGTERM',close);
