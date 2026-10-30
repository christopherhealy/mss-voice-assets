// QA-only playback dependency assembly.
// No credential retrieval, database query, R2 request, or HeyGen generation
// occurs during construction. Not connected to server.js.
import {createVoiceStudioJournal} from './voice-studio-journal.js';
import {createVoiceStudioPrivateStorage} from './voice-studio-private-storage.js';
import {createVoiceStudioPlaybackQa} from './voice-studio-playback-qa.js';
import {cacheIdentity} from '../routes/voice-studio-audio.js';
import {HOST_TEXT} from './generateSpeech.heygen.js';

export function createVoiceStudioPlaybackRuntimeQa({
  env,
  db,
  profile,
  journalEncryptionKey,
  journalKeyId,
  audioEncryptionKey,
  audioKeyId,
  privateBucketReviewed = false,
} = {}) {
  if (env?.RENDER_SERVICE_NAME !== 'mss-voice-assets-qa') {
    throw Error('studio_playback_qa_unavailable');
  }

  const journal = createVoiceStudioJournal({
    db,
    profile,
    encryptionKey: journalEncryptionKey,
    keyId: journalKeyId,
  });

  const assetId = `studio:${cacheIdentity(HOST_TEXT, profile)}`;

  const storage = createVoiceStudioPrivateStorage({
    env,
    bucket: env.VOICE_STUDIO_R2_BUCKET,
    publicBucket: env.R2_BUCKET,
    privateBucketReviewed,
    encryptionKey: audioEncryptionKey,
    keyId: audioKeyId,
    assetId,
  });

  return createVoiceStudioPlaybackQa({
    env,
    enabled: true,
    profile,
    journal,
    storage,
  });
}
