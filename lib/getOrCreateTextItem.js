import { pool } from "./db.js";


export async function getOrCreateTextItem({
  textId,
  textType,
  sourceText,
  textHash,
  storageType,
  metadataJson = {},
}) {
  const existing = await pool.query(
    `
    select *
    from voice_text_items
    where text_id = $1
      and text_hash = $2
    limit 1
    `,
    [textId, textHash]
  );

  if (existing.rowCount) return existing.rows[0];

  const ins = await pool.query(
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
    returning *
    `,
    [
      textId,
      textType,
      sourceText,
      textHash,
      storageType,
      JSON.stringify(metadataJson),
    ]
  );

  return ins.rows[0];
}