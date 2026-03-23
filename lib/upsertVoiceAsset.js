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
      expires_at
    )
    values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11
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
      JSON.stringify(providerResponseJson),
      expiresAt,
    ]
  );

  return q.rows[0];
}