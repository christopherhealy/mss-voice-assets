import express from "express";
import { pool } from "../lib/db.js";
import { getOrCreateVoiceAsset } from "../lib/getOrCreateVoiceAsset.js";
import { registerPlayback } from "../lib/registerPlayback.js";
import { resolveVoiceProfile } from "../lib/resolveVoiceProfile.js";
import { streamElevenLabsSpeech } from "../lib/streamSpeech.elevenlabs.js";
import { normalizeText } from "../lib/normalizeText.js";
import { hashText } from "../lib/hashText.js";
import { getOrCreateTextItem } from "../lib/getOrCreateTextItem.js";
import { findExistingAsset } from "../lib/findExistingAsset.js";
import { upsertVoiceAsset } from "../lib/upsertVoiceAsset.js";
import { buildStorageKey } from "../lib/buildStorageKey.js";
import { uploadToR2 } from "../lib/uploadToR2.js";

const router = express.Router();

const DEFAULT_ACCENT = "ca";
const DEFAULT_GENDER_STYLE = "female";

const SUPPORTED_ACCENTS = new Set([
  "ca",
  "canadian",

  "us",
  "usa",
  "american",

  "uk",
  "british",

  "au",
  "australian",

  "in",
  "indian",
]);

const SUPPORTED_GENDER_STYLES = new Set(["female", "male"]);

// ----------------------------------------------------------
// Voice profile resolver
// Rule:
// explicit voice_profile_id > accent/gender match > Canadian fallback
// ----------------------------------------------------------
function normalizeAccent(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return SUPPORTED_ACCENTS.has(v) ? v : DEFAULT_ACCENT;
}

function normalizeGenderStyle(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return SUPPORTED_GENDER_STYLES.has(v) ? v : DEFAULT_GENDER_STYLE;
}

async function resolveVoiceProfileCode({ voiceProfileCode, accent, genderStyle }) {
  const explicit = String(voiceProfileCode || "").trim();
  if (explicit) return explicit;

  const safeAccent = normalizeAccent(accent);
  const safeGenderStyle = normalizeGenderStyle(genderStyle);

  // Production voice matrix.
  //
  // Production 4-accent × 2-gender matrix.
  // Alex supplies Canadian male; Christopher supplies American male.
  const map = {
    ca: {
      female: "emma",
      male: "alex",
    },
    canadian: {
      female: "emma",
      male: "alex",
    },

    us: {
      female: "jake",
      male: "christopher",
    },
    usa: {
      female: "jake",
      male: "christopher",
    },
    american: {
      female: "jake",
      male: "christopher",
    },

    uk: {
      female: "charlotte",
      male: "oliver",
    },
    british: {
      female: "charlotte",
      male: "oliver",
    },

    au: {
      female: "sophie",
      male: "steve",
    },
    australian: {
      female: "sophie",
      male: "steve",
    },
  };

  const resolved =
    map[safeAccent]?.[safeGenderStyle] ||
    map.ca?.[safeGenderStyle] ||
    "emma";

  console.log("VOICE_RESOLVE_PERSONA", {
    inputAccent: accent,
    safeAccent,
    inputGenderStyle: genderStyle,
    safeGenderStyle,
    resolved,
  });

  return resolved;
}

// ----------------------------------------------------------
// Stream once + persist once
//
// First request receives the live ElevenLabs stream immediately while
// the same bytes are buffered and written to R2. Any concurrent Hear
// request joins the same in-flight stream instead of starting a second
// provider request. Later requests redirect to the durable R2 asset.
// ----------------------------------------------------------
const streamPersistJobs = new Map();

function computeExpiresAt(storageType) {
  return storageType === "short_duration"
    ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    : null;
}

function estimateElevenLabsStreamCost(characterCount) {
  const rate = Number(
    process.env.ELEVENLABS_STREAM_COST_PER_1K_CHARS ||
    process.env.ELEVENLABS_TTS_COST_PER_1K_CHARS ||
    0,
  );

  if (!rate) return null;

  return Number(
    ((Number(characterCount || 0) / 1000) * rate).toFixed(8),
  );
}

function setStreamCacheHeaders(res, {
  cacheHit,
  providerEvent,
  generationInitiator,
  modelId,
  voiceCode,
  characterCount,
  estimatedCostUsd,
  providerRequestId,
  voiceAssetId = null,
  textHash = null,
  deliverySource,
}) {
  res.setHeader("X-Voice-Provider", "elevenlabs");
  res.setHeader("X-Voice-Model", modelId || "");
  res.setHeader("X-Voice-Code", voiceCode || "");
  res.setHeader("X-Voice-Characters", String(characterCount || 0));
  res.setHeader("X-Voice-Cache-Hit", cacheHit ? "1" : "0");
  res.setHeader("X-Voice-Provider-Event", providerEvent ? "1" : "0");
  res.setHeader(
    "X-Voice-Generation-Initiator",
    String(generationInitiator || "hear"),
  );
  res.setHeader(
    "X-Voice-Delivery-Source",
    String(deliverySource || (cacheHit ? "cloudflare" : "provider")),
  );

  if (estimatedCostUsd != null) {
    res.setHeader(
      "X-Voice-Estimated-Cost-Usd",
      String(estimatedCostUsd),
    );
  }

  if (providerRequestId) {
    res.setHeader("X-Voice-Request-Id", providerRequestId);
  }

  if (voiceAssetId) {
    res.setHeader("X-Voice-Asset-Id", String(voiceAssetId));
  }

  if (textHash) {
    res.setHeader("X-Voice-Text-Hash", textHash);
  }
}

function attachStreamSubscriber(job, res, { providerEvent = false } = {}) {
  setStreamCacheHeaders(res, {
    cacheHit: false,
    providerEvent,
    generationInitiator: job.generationInitiator,
    modelId: job.modelId,
    voiceCode: job.voiceProfile?.persona_code || job.voiceId,
    characterCount: job.characterCount,
    estimatedCostUsd: providerEvent ? job.estimatedCostUsd : 0,
    providerRequestId: job.providerRequestId,
    textHash: job.textHash,
    deliverySource: "provider",
  });

  res.status(200);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("X-Content-Type-Options", "nosniff");

  // A late subscriber receives the beginning of the same provider stream
  // from our in-memory buffer, then follows live chunks as they arrive.
  for (const chunk of job.chunks) {
    res.write(chunk);
  }

  if (job.done) {
    res.end();
    return;
  }

  job.subscribers.add(res);

  res.on("close", () => {
    job.subscribers.delete(res);
  });
}

async function persistStreamJob(job) {
  const buffer = Buffer.concat(job.chunks);

  const storageKey = buildStorageKey({
    voiceCode: job.voiceProfile.voice_code,
    textType: job.textType,
    textId: job.textId,
    textHash: job.textHash,
  });

  const { publicUrl } = await uploadToR2({
    buffer,
    storageKey,
    contentType: "audio/mpeg",
  });

  const generationMs = Date.now() - job.startedAt;

  const asset = await upsertVoiceAsset({
    textItemId: job.textItem.id,
    voiceProfileId: job.voiceProfile.id,
    textHash: job.textHash,
    storageType: job.storageType,
    storageKey,
    audioUrl: publicUrl,
    mimeType: "audio/mpeg",
    assetStatus: "ready",
    expiresAt: computeExpiresAt(job.storageType),
    generationProvider: "elevenlabs",
    generationModel: job.modelId,
    personaCode: job.voiceProfile.persona_code || null,
    characterCount: job.characterCount,
    generationMs,
    generationCostUsd: job.estimatedCostUsd,
    providerRequestId: job.providerRequestId,
    providerResponseJson: {
      provider: "elevenlabs",
      model: job.modelId,
      voice_id: job.voiceId,
      persona_code: job.voiceProfile.persona_code || null,
      input_length: job.characterCount,
      generation_ms: generationMs,
      estimated_cost_usd: job.estimatedCostUsd,
      request_id: job.providerRequestId,
      generation_initiator: job.generationInitiator,
      stream_persist: true,
    },
  });

  job.asset = asset;
  job.publicUrl = publicUrl;

  console.log("VOICE_STREAM_PERSISTED", {
    jobKey: job.jobKey,
    voiceAssetId: asset?.id || null,
    textHash: job.textHash,
    providerRequestId: job.providerRequestId,
    bytes: buffer.length,
    publicUrl,
  });

  return asset;
}

async function pumpStreamJob(job) {
  try {
    const reader = job.upstream.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!value) continue;

      const chunk = Buffer.from(value);
      job.chunks.push(chunk);

      for (const subscriber of [...job.subscribers]) {
        if (subscriber.destroyed || subscriber.writableEnded) {
          job.subscribers.delete(subscriber);
          continue;
        }

        subscriber.write(chunk);
      }
    }

    job.done = true;

    for (const subscriber of [...job.subscribers]) {
      if (!subscriber.destroyed && !subscriber.writableEnded) {
        subscriber.end();
      }
    }

    job.subscribers.clear();

    job.persistPromise = persistStreamJob(job);
    await job.persistPromise;
  } catch (err) {
    job.done = true;
    job.error = err;

    console.error("VOICE_STREAM_PERSIST_FAILED", {
      jobKey: job.jobKey,
      message: err?.message || String(err),
    });

    for (const subscriber of [...job.subscribers]) {
      if (!subscriber.headersSent) {
        subscriber.status(500);
      }
      if (!subscriber.writableEnded) {
        subscriber.end();
      }
    }

    job.subscribers.clear();
  } finally {
    // Keep the completed job briefly so an immediately-following request
    // can wait for R2 persistence instead of starting another generation.
    setTimeout(() => {
      if (streamPersistJobs.get(job.jobKey) === job) {
        streamPersistJobs.delete(job.jobKey);
      }
    }, 15000).unref?.();
  }
}

// ----------------------------------------------------------
// Profiles
// ----------------------------------------------------------
router.get("/profiles", async (req, res) => {
  try {
    const q = await pool.query(
      `
      select
        id,
        provider,
        voice_code as voice_profile_id,
        display_name,
        accent,
        locale,
        gender_style,
        speed_default,
        language,
        region,
        style_prompt,
        is_default,
        is_active,
        persona_code,
        persona_name,
        city,
        notes
      from voice_profiles
      where is_active = true
      order by
        language asc,
        region asc,
        display_name asc
      `
    );

    return res.json({
      ok: true,
      profiles: q.rows || [],
    });
  } catch (err) {
    console.error("GET /api/voice/profiles failed:", err);
    return res.status(500).json({
      ok: false,
      error: "profiles_load_failed",
      message: err.message,
    });
  }
});

router.post("/stream", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const requestedVoiceProfileCode = String(req.body?.voice_profile_id || "").trim();

    const voiceProfileCode = await resolveVoiceProfileCode({
      voiceProfileCode: requestedVoiceProfileCode,
      accent: req.body?.accent,
      genderStyle: req.body?.gender_style || req.body?.kind || DEFAULT_GENDER_STYLE,
    });

    const voiceProfile = await resolveVoiceProfile(voiceProfileCode);

    // streamElevenLabsSpeech owns provider-level telemetry headers
    // (provider/model/voice/characters/cost/request id). The calling
    // Ingle proxy can combine those authoritative provider measurements
    // with its own frame/gate/turn context without coupling VoiceAssets
    // to the Ingle database.
    await streamElevenLabsSpeech({
      res,
      text: req.body?.text,
      voiceProfile,
    });
  } catch (err) {
    console.error("POST /api/voice/stream failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: "stream_failed",
        message: err.message,
      });
    }
  }
});

// ----------------------------------------------------------
// Stream + persist
// ----------------------------------------------------------
router.post("/stream-cache", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error("missing_elevenlabs_api_key");
    }

    const textId = String(req.body?.text_id || "").trim();
    const textType = String(req.body?.text_type || "").trim().toLowerCase();
    const storageType = String(req.body?.storage_type || "cache").trim().toLowerCase();
    const text = normalizeText(req.body?.text);
    const generationInitiator =
      String(req.body?.generation_initiator || "hear")
        .trim()
        .toLowerCase() === "prewarm"
        ? "prewarm"
        : "hear";

    if (!textId) {
      return res.status(400).json({ ok: false, error: "missing_text_id" });
    }
    if (!textType) {
      return res.status(400).json({ ok: false, error: "missing_text_type" });
    }
    if (!text) {
      return res.status(400).json({ ok: false, error: "missing_text" });
    }

    const requestedVoiceProfileCode = String(req.body?.voice_profile_id || "").trim();
    const accent = req.body?.accent;
    const genderStyle = req.body?.gender_style || req.body?.kind || DEFAULT_GENDER_STYLE;

    const voiceProfileCode = await resolveVoiceProfileCode({
      voiceProfileCode: requestedVoiceProfileCode,
      accent,
      genderStyle,
    });

    const voiceProfile = await resolveVoiceProfile(voiceProfileCode);
    const textHash = hashText(text);

    const textItem = await getOrCreateTextItem({
      textId,
      textType,
      sourceText: text,
      textHash,
      storageType,
      metadataJson: {
        ...(req.body?.metadata || {}),
        generation_initiator: generationInitiator,
        stream_persist: true,
      },
    });

    const existing = await findExistingAsset({
      textItemId: textItem.id,
      voiceProfileId: voiceProfile.id,
      textHash,
    });

    if (existing?.asset_status === "ready" && existing?.audio_url) {
      setStreamCacheHeaders(res, {
        cacheHit: true,
        providerEvent: false,
        generationInitiator,
        modelId: existing.generation_model,
        voiceCode: voiceProfile.persona_code || voiceProfile.voice_code,
        characterCount: existing.character_count || text.length,
        estimatedCostUsd: 0,
        providerRequestId: null,
        voiceAssetId: existing.id,
        textHash,
        deliverySource: "cloudflare",
      });

      res.setHeader("Location", existing.audio_url);
      return res.status(303).end();
    }

    const jobKey = `${textItem.id}:${voiceProfile.id}:${textHash}`;
    let job = streamPersistJobs.get(jobKey) || null;

    if (job) {
      if (job.done && job.persistPromise) {
        await job.persistPromise.catch(() => null);

        if (job.publicUrl) {
          setStreamCacheHeaders(res, {
            cacheHit: true,
            providerEvent: false,
            generationInitiator: job.generationInitiator,
            modelId: job.modelId,
            voiceCode: voiceProfile.persona_code || voiceProfile.voice_code,
            characterCount: job.characterCount,
            estimatedCostUsd: 0,
            providerRequestId: null,
            voiceAssetId: job.asset?.id || null,
            textHash,
            deliverySource: "cloudflare",
          });

          res.setHeader("Location", job.publicUrl);
          return res.status(303).end();
        }
      }

      console.log("VOICE_STREAM_JOIN", {
        jobKey,
        generationInitiator: job.generationInitiator,
        joiningRole: generationInitiator,
        bufferedChunks: job.chunks.length,
      });

      attachStreamSubscriber(job, res, {
        providerEvent: false,
      });
      return;
    }

    const voiceId = String(voiceProfile?.voice_code || "").trim();
    if (!voiceId) {
      throw new Error("missing_elevenlabs_voice_id");
    }

    const modelId =
      process.env.ELEVENLABS_STREAM_MODEL_ID ||
      process.env.ELEVENLABS_MODEL_ID ||
      "eleven_flash_v2_5";

    const characterCount = text.length;
    const estimatedCostUsd = estimateElevenLabsStreamCost(characterCount);
    const startedAt = Date.now();

    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.8,
            style: 0.25,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      throw new Error(`elevenlabs_stream_failed: ${upstream.status} ${body}`);
    }

    const providerRequestId =
      String(
        upstream.headers.get("request-id") ||
        upstream.headers.get("x-request-id") ||
        upstream.headers.get("x-elevenlabs-request-id") ||
        `stream-cache-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ).trim();

    job = {
      jobKey,
      textId,
      textType,
      textHash,
      textItem,
      storageType,
      voiceProfile,
      voiceId,
      modelId,
      characterCount,
      estimatedCostUsd,
      providerRequestId,
      generationInitiator,
      startedAt,
      upstream,
      chunks: [],
      subscribers: new Set(),
      done: false,
      persistPromise: null,
      publicUrl: null,
      asset: null,
      error: null,
    };

    streamPersistJobs.set(jobKey, job);

    console.log("VOICE_STREAM_CREATE", {
      jobKey,
      generationInitiator,
      modelId,
      characterCount,
      estimatedCostUsd,
      providerRequestId,
    });

    attachStreamSubscriber(job, res, {
      providerEvent: true,
    });

    void pumpStreamJob(job);
  } catch (err) {
    console.error("POST /api/voice/stream-cache failed:", err);

    if (!res.headersSent) {
      return res.status(500).json({
        ok: false,
        error: "stream_cache_failed",
        message: err.message,
      });
    }

    if (!res.writableEnded) {
      res.end();
    }
  }
});

// ----------------------------------------------------------
// Playback
// ----------------------------------------------------------
router.post("/playback", express.json({ limit: "256kb" }), async (req, res) => {
  try {
    const voiceAssetId = Number(req.body?.voice_asset_id || 0);
    const userRef = req.body?.user_ref || null;
    const sessionRef = req.body?.session_ref || null;
    const context = req.body?.context || {};

    if (!voiceAssetId) {
      return res.status(400).json({ ok: false, error: "missing_voice_asset_id" });
    }

    const out = await registerPlayback({
      voiceAssetId,
      userRef,
      sessionRef,
      context,
    });

    return res.json({
      ok: true,
      voice_asset_id: out.id,
      playback_count: out.playback_count,
      first_played_at: out.first_played_at,
      last_played_at: out.last_played_at,
    });
  } catch (err) {
    console.error("POST /api/voice/playback failed:", err);
    return res.status(500).json({
      ok: false,
      error: "playback_failed",
      message: err.message,
    });
  }
});

// ----------------------------------------------------------
// Render
// Supports:
// 1. Explicit voice_profile_id
// 2. Accent/gender resolver
// ----------------------------------------------------------
router.post("/render", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const textId = String(req.body?.text_id || "").trim();
    const textType = String(req.body?.text_type || "")
      .trim()
      .toLowerCase();
    const text = String(req.body?.text || "");
    const storageType = String(req.body?.storage_type || "")
      .trim()
      .toLowerCase();

    const requestedVoiceProfileCode = String(req.body?.voice_profile_id || "").trim();
    const accent = req.body?.accent;
    const genderStyle = req.body?.gender_style || req.body?.kind || DEFAULT_GENDER_STYLE;

    const metadata = req.body?.metadata || {};

    if (!textId) {
      return res.status(400).json({ ok: false, error: "missing_text_id" });
    }

    if (!textType) {
      return res.status(400).json({ ok: false, error: "missing_text_type" });
    }

    if (!text) {
      return res.status(400).json({ ok: false, error: "missing_text" });
    }

    if (!storageType) {
      return res.status(400).json({ ok: false, error: "missing_storage_type" });
    }

    const voiceProfileCode = await resolveVoiceProfileCode({
      voiceProfileCode: requestedVoiceProfileCode,
      accent,
      genderStyle,
    });

    if (!voiceProfileCode) {
      return res.status(400).json({
        ok: false,
        error: "voice_profile_resolution_failed",
      });
    }

    const out = await getOrCreateVoiceAsset({
      textId,
      textType,
      text,
      storageType,
      voiceProfileCode,
      metadata: {
        ...metadata,
        accent_requested: accent || null,
        gender_style_requested: genderStyle || null,
        voice_profile_requested: requestedVoiceProfileCode || null,
        voice_profile_resolved: voiceProfileCode,
      },
    });

    return res.json({
      ok: true,
      cache_hit: out.cacheHit,

      voice_asset_id: out.asset.id,
      text_item_id: out.textItem.id,

      voice_profile_id: out.voiceProfile.voice_code,
      accent_requested: accent || null,
      gender_style_requested: genderStyle || null,
      voice_profile_resolved: voiceProfileCode,

      text_hash: out.textHash,
      asset_status: out.asset.asset_status,
      expires_at: out.asset.expires_at,

      // Durable object identity / delivery.
      storage_key: out.asset.storage_key || null,
      audio_key: out.asset.storage_key || null,
      audio_url: out.asset.audio_url,

      // Generation provenance. On a cache hit these describe the
      // original generation; callers must use cache_hit to decide
      // whether provider usage occurred on THIS request.
      generation_provider:
        out.asset.generation_provider || null,

      generation_model:
        out.asset.generation_model || null,

      character_count:
        Number(out.asset.character_count || 0),

      generation_ms:
        out.asset.generation_ms == null
          ? null
          : Number(out.asset.generation_ms),

      generation_cost_usd:
        out.asset.generation_cost_usd == null
          ? null
          : Number(out.asset.generation_cost_usd),

      provider_request_id:
        out.asset.provider_request_id || null,
    });
  } catch (err) {
    console.error("POST /api/voice/render failed:", err);
    return res.status(500).json({
      ok: false,
      error: "render_failed",
      message: err.message,
    });
  }
});

export default router;
