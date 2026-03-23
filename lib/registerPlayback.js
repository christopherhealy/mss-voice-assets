import { pool } from "./db.js";

export async function registerPlayback({
  voiceAssetId,
  userRef = null,
  sessionRef = null,
  context = {},
}) {
  await pool.query(
    `
    insert into voice_playback_events (
      voice_asset_id,
      user_ref,
      session_ref,
      context_json
    )
    values ($1, $2, $3, $4::jsonb)
    `,
    [voiceAssetId, userRef, sessionRef, JSON.stringify(context)]
  );

  const q = await pool.query(
    `
    update voice_assets
    set
      playback_count = playback_count + 1,
      first_played_at = coalesce(first_played_at, now()),
      last_played_at = now(),
      updated_at = now()
    where id = $1
    returning id, playback_count, first_played_at, last_played_at
    `,
    [voiceAssetId]
  );

  return q.rows[0];
}