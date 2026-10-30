# Voice Studio Local Tiziana Learner Audio

This adapter is a separate local-development process. It is not mounted by `server.js`, does not use PostgreSQL/R2, and is never enabled on Render. The original fixed-line `/api/voice/studio-audio` route and its unapproved Host candidate are unchanged.

The owner-approved local profile is limited to Julie's Italian `l2-scripted-learner` turns using HeyGen voice `ebbc053d046742c582f273f1334c58d8`, engine `elevenlabs`, model `eleven_multilingual_v2`, speed 1. Requests require a server-to-server bearer identity, an HMAC attestation over the complete server-resolved grouped script and selected turn, and an explicit Hear Pro or Play Pro Conversation action. The browser sends IDs only.

Audio and state are stored outside the repository in `~/.voiceassets/cache/voice-studio-tiziana-learner-v1/`, with mode 0700 directories and 0600 files. Audio writes use an atomic rename and include a SHA-256 check. A ready entry is reused after restart. Recovery metadata containing HeyGen's signed URL is AES-256-GCM encrypted using the configured local recovery key. A dispatch marker with no recovery metadata is never retried; a saved recovery record permits download-only recovery on a later explicit action. Provider errors and signed URLs are redacted.

## Local setup

Use ignored local environment files only. Never put these values in Git, browser configuration, shell arguments or logs.

VoiceAssets process:

```text
NODE_ENV=development
VOICE_ASSETS_LOCAL_TIZIANA_LEARNER_ENABLED=true
VOICE_STUDIO_LOCAL_AUDIO_SERVICE_SECRET=<same private random value as Actor's Studio>
VOICE_STUDIO_LOCAL_SCRIPT_ATTESTATION_SECRET=<separate private random value shared with Actor's Studio>
VOICE_ASSETS_LOCAL_RECOVERY_KEY=<base64 encoding of 32 random bytes>
VOICE_ASSETS_LOCAL_RECOVERY_KEY_ID=local-v1
HEYGEN_API_KEY=<server-side credential with voice speech-generation permission>
```

Actor's Studio process:

```text
NODE_ENV=development
VOICE_STUDIO_DEV_TIZIANA_LEARNER_AUDIO_ENABLED=true
VOICE_STUDIO_LOCAL_AUDIO_SERVICE_SECRET=<same private random value as VoiceAssets>
VOICE_STUDIO_LOCAL_SCRIPT_ATTESTATION_SECRET=<same private random value as VoiceAssets>
```

Keep both feature flags false until the operator has separately approved a live paid pronunciation test. The adapter refuses startup when its feature flag is off and refuses service outside `NODE_ENV=development` or when `RENDER_SERVICE_NAME` is set. Do not run the VoiceAssets `server.js` for this feature: it is the existing QA application and performs its own QA startup checks.

Start the standalone VoiceAssets local adapter from this repository with:

```sh
node scripts/voice-studio-local-learner-audio.js
```

It binds only to `127.0.0.1:3120`. Actor's Studio remains at `http://127.0.0.1:3117` via `npm run dev`.
