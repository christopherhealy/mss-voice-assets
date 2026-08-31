import express from "express";
import { pool } from "../lib/db.js";
import { getOrCreateVoiceAsset } from "../lib/getOrCreateVoiceAsset.js";
import { registerPlayback } from "../lib/registerPlayback.js";
import { resolveVoiceProfile } from "../lib/resolveVoiceProfile.js";
import { streamElevenLabsSpeech } from "../lib/streamSpeech.elevenlabs.js";

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
