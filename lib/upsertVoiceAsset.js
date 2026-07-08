import { pool } from "./db.js";

export async function upsertVoiceAsset({
  textItemId,
  voiceProfileId,
  textHash,
  storageType,
  assetStatus = "pending",
  storageKey = null,
  audioUrl = null,
  mimeType = "audio/mpeg",
  durationMs = null,
  providerResponseJson = {},
  expiresAt = null,

  generationProvider = null,
  generationModel = null,
  personaCode = null,
  characterCount = null,
  generationMs = null,
  generationCostUsd = null,
  providerRequestId = null,
}) {
  const q = await pool.query(
    `
    insert into voice_assets (
      text_item_id,
      voice_profile_id,
      text_hash,
      storage_type,
      storage_key,
      audio_url,
      mime_type,
      duration_ms,
      asset_status,
      provider_response_json,
      expires_at,
      generation_provider,
      generation_model,
      persona_code,
      character_count,
      generation_ms,
      generation_cost_usd,
      provider_request_id
    )
    values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
      $12, $13, $14, $15, $16, $17, $18
    )
    on conflict (text_item_id, voice_profile_id, text_hash)
    do update set
      storage_type = excluded.storage_type,
      storage_key = excluded.storage_key,
      audio_url = excluded.audio_url,
      mime_type = excluded.mime_type,
      duration_ms = excluded.duration_ms,
      asset_status = excluded.asset_status,
      provider_response_json = excluded.provider_response_json,
      expires_at = excluded.expires_at,
      generation_provider = excluded.generation_provider,
      generation_model = excluded.generation_model,
      persona_code = excluded.persona_code,
      character_count = excluded.character_count,
      generation_ms = excluded.generation_ms,
      generation_cost_usd = excluded.generation_cost_usd,
      provider_request_id = excluded.provider_request_id,
      updated_at = now()
    returning *
    `,
    [
      textItemId,
      voiceProfileId,
      textHash,
      storageType,
      storageKey,
      audioUrl,
      mimeType,
      durationMs,
      assetStatus,
      JSON.stringify(providerResponseJson || {}),
      expiresAt,

      generationProvider,
      generationModel,
      personaCode,
      characterCount,
      generationMs,
      generationCostUsd,
      providerRequestId,
    ]
  );

  return q.rows[0];
}