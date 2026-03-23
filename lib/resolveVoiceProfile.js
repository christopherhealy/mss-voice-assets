import { pool } from "./db.js";

export async function resolveVoiceProfile(voiceProfileCode) {
  const q = await pool.query(
    `
    select *
    from voice_profiles
    where voice_code = $1
      and is_active = true
    limit 1
    `,
    [voiceProfileCode]
  );

  if (!q.rowCount) {
    throw new Error(`voice_profile_not_found: ${voiceProfileCode}`);
  }

  return q.rows[0];
}