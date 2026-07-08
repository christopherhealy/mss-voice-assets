import { pool } from "./db.js";

export async function resolveVoiceProfile(voiceProfileCode) {
  const key = String(voiceProfileCode || "").trim();

  if (!key) {
    throw new Error("missing_voice_profile");
  }

  const q = await pool.query(
    `
    select *
    from voice_profiles
    where is_active = true
      and (
        voice_code = $1
        or persona_code = $1
        or lower(display_name) = lower($1)
      )
    limit 1
    `,
    [key]
  );

  if (!q.rowCount) {
    throw new Error(`voice_profile_not_found: ${key}`);
  }

  return q.rows[0];
}