import express from "express";
import { pool } from "../lib/db.js";
import { getOrCreateVoiceAsset } from "../lib/getOrCreateVoiceAsset.js";
import { registerPlayback } from "../lib/registerPlayback.js";
import { resolveVoiceProfile, resolveDefaultVoiceProfile } from "../lib/resolveVoiceProfile.js";
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
// Unified runtime resolver
// explicit voice > practice-language default > legacy accent/gender
// ----------------------------------------------------------
async function resolveRuntimeVoiceProfile({
  voiceProfileCode,
  practiceLanguage,
  locale,
  accent,
  genderStyle,
}) {
  const explicit = String(voiceProfileCode || "").trim();
  if (explicit) {
    return { voiceProfile: await resolveVoiceProfile(explicit), resolution: "explicit" };
  }

  if (String(practiceLanguage || "").trim()) {
    return {
      voiceProfile: await resolveDefaultVoiceProfile({
        practiceLanguage,
        genderStyle,
        locale,
      }),
      resolution: "practice_language",
    };
  }

  const legacyCode = await resolveVoiceProfileCode({
    voiceProfileCode: "",
    accent,
    genderStyle,
  });

  return {
    voiceProfile: await resolveVoiceProfile(legacyCode),
    resolution: "legacy_accent",
  };
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
// Voice Curator V1 — read-only ElevenLabs discovery
// ----------------------------------------------------------
function curatorApiKey() {
  const key = String(process.env.ELEVENLABS_API_KEY || "").trim();
  if (!key) throw new Error("missing_elevenlabs_api_key");
  return key;
}

async function curatorGet(url) {
  const r = await fetch(url, {
    headers: { "xi-api-key": curatorApiKey(), Accept: "application/json" },
  });
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!r.ok) throw new Error(`elevenlabs_api_failed: ${r.status} ${data?.detail?.message || data?.message || raw}`);
  return data;
}

router.get("/curator/account", async (req, res) => {
  try {
    const s = await curatorGet("https://api.elevenlabs.io/v1/user/subscription");
    const used = Number(s.character_count || 0);
    const limit = Number(s.character_limit || 0);
    return res.json({
      ok: true,
      account: {
        tier: s.tier || null,
        status: s.status || null,
        character_count: used,
        character_limit: limit,
        remaining: limit ? Math.max(0, limit - used) : null,
        next_character_count_reset_unix: s.next_character_count_reset_unix || null,
      },
    });
  } catch (err) {
    console.error("GET /api/voice/curator/account failed:", err);
    return res.status(502).json({ ok: false, error: "curator_account_failed", message: err.message });
  }
});

router.get("/curator/search", async (req, res) => {
  try {
    const language = String(req.query.language || "").trim().toLowerCase();
    const locale = String(req.query.locale || "").trim();
    const accent = String(req.query.accent || "").trim().toLowerCase();
    const gender = String(req.query.gender || "").trim().toLowerCase();
    const pageSize = Math.min(20, Math.max(1, parseInt(req.query.page_size || "5", 10) || 5));

    if (!language) return res.status(400).json({ ok: false, error: "missing_language" });

    // Discovery is intentionally broad. Locale/accent are qualification
    // criteria below, not ElevenLabs server-side filters. This prevents
    // valid multilingual performers from being filtered out before we can
    // inspect their verified_languages metadata.
    const discoveryPageSize = Math.max(30, pageSize);
    const qs = new URLSearchParams({
      language,
      page_size: String(discoveryPageSize),
      sort: "trending",
    });
    if (gender) qs.set("gender", gender);

    const data = await curatorGet(`https://api.elevenlabs.io/v1/shared-voices?${qs}`);
    const voices = (Array.isArray(data.voices) ? data.voices : []).map(v => ({
      public_owner_id: v.public_owner_id || null,
      voice_id: v.voice_id || null,
      name: v.name || null,
      accent: v.accent || null,
      gender: v.gender || null,
      age: v.age || null,
      descriptive: v.descriptive || null,
      use_case: v.use_case || null,
      category: v.category || null,
      language: v.language || null,
      description: v.description || null,
      preview_url: v.preview_url || null,
      verified_languages: Array.isArray(v.verified_languages) ? v.verified_languages : [],
    }));

    const voiceCodes = voices.map(v => v.voice_id).filter(Boolean);
    let approvedByCode = new Map();

    if (voiceCodes.length) {
      const approved = await pool.query(
        `
          select
            id,
            voice_code,
            display_name,
            is_default,
            is_active,
            language,
            locale,
            accent,
            gender_style
          from voice_profiles
          where provider = 'elevenlabs'
            and voice_code = any($1::text[])
        `,
        [voiceCodes],
      );

      approvedByCode = new Map(
        approved.rows.map(row => [String(row.voice_code), row]),
      );
    }

    const decoratedVoices = voices.map(v => {
      const verified = Array.isArray(v.verified_languages) ? v.verified_languages : [];
      const localeMatches = locale
        ? verified.filter(item => String(item?.locale || "").toLowerCase() === locale.toLowerCase())
        : [];

      const primaryLanguageMatch =
        String(v.language || "").toLowerCase() === language;

      const verifiedLocaleMatch =
        !locale || localeMatches.length > 0;

      return {
        ...v,
        approved: approvedByCode.has(String(v.voice_id)),
        registry: approvedByCode.get(String(v.voice_id)) || null,
        match: {
          verified_locale_match: verifiedLocaleMatch,
          primary_language_match: primaryLanguageMatch,
          locale_verified: localeMatches.length > 0,
          requested_language: language,
          requested_locale: locale || null,
          primary_language: v.language || null,
          verified_locale_matches: localeMatches,
        },
      };
    });

    const verifiedMatches = decoratedVoices.filter(
      v => v.match?.verified_locale_match === true,
    );
    const otherMatches = decoratedVoices.filter(
      v => v.match?.verified_locale_match !== true,
    );

    // Show verified locale matches first. Fill any remaining slots with
    // previewable non-matches so the curator can see what was discovered,
    // while approval remains disabled for those entries.
    const rankedVoices = [...verifiedMatches, ...otherMatches].slice(0, pageSize);

    return res.json({
      ok: true,
      query: {
        language,
        locale: locale || null,
        accent: accent || null,
        gender: gender || null,
        requested_page_size: pageSize,
        discovery_page_size: discoveryPageSize,
      },
      total_count: Number(data.total_count || decoratedVoices.length),
      verified_match_count: verifiedMatches.length,
      discovered_count: decoratedVoices.length,
      has_more: Boolean(data.has_more),
      voices: rankedVoices,
    });
  } catch (err) {
    console.error("GET /api/voice/curator/search failed:", err);
    return res.status(502).json({ ok: false, error: "curator_search_failed", message: err.message });
  }
});

router.post("/curator/approve", express.json({ limit: "256kb" }), async (req, res) => {
  const client = await pool.connect();

  try {
    const language = String(req.body?.language || "").trim().toLowerCase();
    const locale = String(req.body?.locale || "").trim();
    const accent = String(req.body?.accent || "").trim().toLowerCase();
    const gender = String(req.body?.gender || "").trim().toLowerCase();
    const region = String(req.body?.region || "").trim() || null;
    const voices = Array.isArray(req.body?.voices) ? req.body.voices : [];

    if (!language || !locale || !gender) {
      return res.status(400).json({ ok: false, error: "missing_voice_category" });
    }
    if (!voices.length) {
      return res.status(400).json({ ok: false, error: "no_voices_selected" });
    }

    const defaults = voices.filter(v => v?.is_default === true);
    if (defaults.length > 1) {
      return res.status(400).json({ ok: false, error: "multiple_defaults_selected" });
    }

    await client.query("BEGIN");

    if (defaults.length === 1) {
      await client.query(
        `
          update voice_profiles
          set is_default = false, updated_at = now()
          where provider = 'elevenlabs'
            and language = $1
            and locale = $2
            and gender_style = $3
        `,
        [language, locale, gender],
      );
    }

    const saved = [];

    for (const voice of voices) {
      const voiceCode = String(voice?.voice_id || "").trim();
      const displayName = String(voice?.name || "").trim();

      if (!voiceCode || !displayName) {
        throw new Error("invalid_selected_voice");
      }

      const metadata = {
        public_owner_id: voice?.public_owner_id || null,
        verified_languages: Array.isArray(voice?.verified_languages)
          ? voice.verified_languages
          : [],
        age: voice?.age || null,
        use_case: voice?.use_case || null,
        category: voice?.category || null,
        descriptive: voice?.descriptive || null,
        description: voice?.description || null,
        preview_url: voice?.preview_url || null,
        curated_at: new Date().toISOString(),
      };

      const q = await client.query(
        `
          insert into voice_profiles (
            provider,
            voice_code,
            display_name,
            accent,
            locale,
            gender_style,
            is_active,
            notes,
            language,
            region,
            is_default,
            provider_metadata_json,
            updated_at
          )
          values (
            'elevenlabs', $1, $2, $3, $4, $5, true, $6,
            $7, $8, $9, $10::jsonb, now()
          )
          on conflict (provider, voice_code)
          do update set
            display_name = excluded.display_name,
            accent = excluded.accent,
            locale = excluded.locale,
            gender_style = excluded.gender_style,
            is_active = true,
            notes = excluded.notes,
            language = excluded.language,
            region = excluded.region,
            is_default = excluded.is_default,
            provider_metadata_json = excluded.provider_metadata_json,
            updated_at = now()
          returning
            id, provider, voice_code, display_name, accent, locale,
            gender_style, language, region, is_default, is_active
        `,
        [
          voiceCode,
          displayName,
          accent || voice?.accent || null,
          locale,
          gender,
          voice?.description || null,
          language,
          region,
          voice?.is_default === true,
          JSON.stringify(metadata),
        ],
      );

      saved.push(q.rows[0]);
    }

    await client.query("COMMIT");

    return res.json({ ok: true, saved_count: saved.length, profiles: saved });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /api/voice/curator/approve failed:", err);
    return res.status(500).json({
      ok: false,
      error: "curator_approve_failed",
      message: err.message,
    });
  } finally {
    client.release();
  }
});

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

    const { voiceProfile } = await resolveRuntimeVoiceProfile({
      voiceProfileCode: requestedVoiceProfileCode,
      practiceLanguage: req.body?.practice_language,
      locale: req.body?.locale,
      accent: req.body?.accent,
      genderStyle: req.body?.gender_style || req.body?.kind || DEFAULT_GENDER_STYLE,
    });

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

    const { voiceProfile } = await resolveRuntimeVoiceProfile({
      voiceProfileCode: requestedVoiceProfileCode,
      practiceLanguage: req.body?.practice_language,
      locale: req.body?.locale,
      accent,
      genderStyle,
    });
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

    const { voiceProfile: resolvedVoiceProfile, resolution: voiceResolution } =
      await resolveRuntimeVoiceProfile({
        voiceProfileCode: requestedVoiceProfileCode,
        practiceLanguage: req.body?.practice_language,
        locale: req.body?.locale,
        accent,
        genderStyle,
      });

    const voiceProfileCode = resolvedVoiceProfile.voice_code;

    const out = await getOrCreateVoiceAsset({
      textId,
      textType,
      text,
      storageType,
      voiceProfileCode,
      metadata: {
        ...metadata,
        practice_language_requested: req.body?.practice_language || null,
        locale_requested: req.body?.locale || null,
        accent_requested: accent || null,
        gender_style_requested: genderStyle || null,
        voice_profile_requested: requestedVoiceProfileCode || null,
        voice_profile_resolved: voiceProfileCode,
        voice_resolution: voiceResolution,
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
      voice_resolution: voiceResolution,
      practice_language_requested: req.body?.practice_language || null,
      locale_requested: req.body?.locale || null,

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
