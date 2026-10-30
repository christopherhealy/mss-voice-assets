import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceStudioHeygenQa} from '../../lib/voice-studio-heygen-qa.js';

test('QA HeyGen factory requires an explicit credential callback', () => {
  assert.throws(
    () => createVoiceStudioHeygenQa(),
    {message: 'studio_heygen_credential_required'},
  );
});

test('QA HeyGen factory construction does not retrieve credentials', () => {
  let credentialCalls = 0;

  const generate = createVoiceStudioHeygenQa({
    credential: async () => {
      credentialCalls++;
      throw new Error('Credentials must not be retrieved during construction');
    },
  });

  assert.equal(typeof generate, 'function');
  assert.equal(typeof generate.recover, 'function');
  assert.equal(credentialCalls, 0);
});

test('unarmed QA drain rejects recovery without provider access', async () => {
  const {spawnSync} = await import('node:child_process');

  const script = `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {createVoiceStudioHeygenQa} from './lib/voice-studio-heygen-qa.js';
    import {HOST_TEXT,TIZIANA_ID} from './lib/generateSpeech.heygen.js';

    let credentials = 0;
    const generate = createVoiceStudioHeygenQa({
      credential: async () => { credentials++; throw Error('unexpected'); }
    });

    const profile = {
      approved:true, provider:'heygen', language:'it',
      actor:'julie', voice:'tiziana', voiceId:TIZIANA_ID,
      engine:'elevenlabs', model:'eleven_multilingual_v2',
      settings:{speed:1}
    };

    const recovery = {
      version:1, voiceId:TIZIANA_ID,
      textHash:createHash('sha256').update(HOST_TEXT).digest('hex'),
      audioUrl:'https://files.heygen.ai/synthetic-test.mp3',
      requestId:'synthetic-test', duration:2,
      engine:'elevenlabs', requestedModel:'eleven_multilingual_v2'
    };

    await assert.rejects(
      generate.recover({text:HOST_TEXT,profile,recovery}),
      {message:'heygen_audio_unavailable_no_regeneration'}
    );
    assert.equal(credentials,0);
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      RENDER_SERVICE_NAME: 'mss-voice-assets-qa',
      INGLE_QA_DRAIN_ARMED: 'false',
    },
    timeout: 10000,
  });

  assert.equal(result.status, 0, result.stderr);
});
