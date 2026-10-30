// QA-only HeyGen dependency assembly.
// Construction does not retrieve credentials or dispatch network requests.
import {createHeygenSpeech} from './generateSpeech.heygen.js';
import {createStudioHttpsTransport} from './voice-studio-https-transport.js';
import {qaDrain} from './qa-drain.js';
import {lookup} from 'node:dns/promises';

export function createVoiceStudioHeygenQa({credential} = {}) {
  if (typeof credential !== 'function') {
    throw new Error('studio_heygen_credential_required');
  }

  const transport = createStudioHttpsTransport();

  const guardedRequest = async (url, options) => {
    // Native https.request bypasses the global guarded-fetch wrapper.
    // Explicitly enforce QA admission before DNS or network activity.
    if (!qaDrain.enabled()) {
      throw new Error('studio_qa_drain_required');
    }
    qaDrain.admission();

    const done = qaDrain.track('providers');
    try {
      return await transport(url, options);
    } finally {
      done();
    }
  };

  return createHeygenSpeech({
    request: guardedRequest,
    credential,
    resolve: hostname => {
      if (!qaDrain.enabled()) {
      throw new Error('studio_qa_drain_required');
    }
    qaDrain.admission();
      return lookup(hostname, {all: true});
    },
    allowedAudioHosts: ['files.heygen.ai'],
  });
}
