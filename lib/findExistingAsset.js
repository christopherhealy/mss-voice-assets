import { pool } from "./db.js";

export async function findExistingAsset({ textItemId, voiceProfileId, textHash }) {
  const q = await pool.query(
    `
    select *
    from voice_assets
    where text_item_id = $1
      and voice_profile_id = $2
      and text_hash = $3
      and asset_status = 'ready'
      and audio_url is not null
    limit 1
    `,
    [textItemId, voiceProfileId, textHash]
  );

  return q.rowCount ? q.rows[0] : null;
}