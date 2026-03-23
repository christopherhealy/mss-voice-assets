import express from "express";
import { pool } from "../lib/db.js";
import { getOrCreateVoiceAsset } from "../lib/getOrCreateVoiceAsset.js";
import { registerPlayback } from "../lib/registerPlayback.js";

const router = express.Router();
//profiles
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
        is_active
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
//playback
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
//render
router.post("/render", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const textId = String(req.body?.text_id || "").trim();
    const textType = String(req.body?.text_type || "").trim().toLowerCase();
    const text = String(req.body?.text || "");
    const storageType = String(req.body?.storage_type || "").trim().toLowerCase();
    const voiceProfileCode = String(req.body?.voice_profile_id || "").trim();
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
    if (!voiceProfileCode) {
      return res.status(400).json({ ok: false, error: "missing_voice_profile_id" });
    }

    const out = await getOrCreateVoiceAsset({
      textId,
      textType,
      text,
      storageType,
      voiceProfileCode,
      metadata,
    });

    return res.json({
      ok: true,
      cache_hit: out.cacheHit,
      voice_asset_id: out.asset.id,
      text_item_id: out.textItem.id,
      voice_profile_id: out.voiceProfile.voice_code,
      text_hash: out.textHash,
      asset_status: out.asset.asset_status,
      expires_at: out.asset.expires_at,
      audio_url: out.asset.audio_url
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