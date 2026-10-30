// Voice Studio QA playback-only boundary.
// Never exposes POST generation or recovery operations.
import {createVoiceStudioAudioHandler} from '../routes/voice-studio-audio.js';

export function createVoiceStudioPlaybackQa(options = {}) {
  const playback = createVoiceStudioAudioHandler({
    ...options,
    approvals: new Map(),
    recoveryApprovals: new Map(),
    pipeline: null,
    generate: null,
  });

  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET') {
      return res.status(405).json({
        ok: false,
        error: 'method_not_allowed',
      });
    }

    return playback(req, res);
  };
}
