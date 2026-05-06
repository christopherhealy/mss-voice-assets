import { pool } from "./db.js";

export async function getOrCreateTextItem({
  textId,
  textType,
  sourceText,
  textHash,
  storageType,
  metadataJson = {},
}) {
  const q = await pool.query(
    `
    insert into voice_text_items (
      text_id,
      text_type,
      source_text,
      text_hash,
      storage_type,
      metadata_json
    )
    values ($1, $2, $3, $4, $5, $6::jsonb)
    on conflict (text_id, text_hash)
    do update set
      text_type = excluded.text_type,
      source_text = excluded.source_text,
      storage_type = excluded.storage_type,
      metadata_json = voice_text_items.metadata_json || excluded.metadata_json,
      updated_at = now()
    returning *
    `,
    [
      textId,
      textType,
      sourceText,
      textHash,
      storageType,
      JSON.stringify(metadataJson || {}),
    ],
  );

  return q.rows[0];
}