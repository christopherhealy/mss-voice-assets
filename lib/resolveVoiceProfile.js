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

const DEFAULT_LOCALE_BY_LANGUAGE = Object.freeze({
  en: "en-CA",
  es: "es-MX",
  fr: "fr-FR",
  it: "it-IT",
  ko: "ko-KR",
});

function normalizePracticeLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  return ({ english:"en", spanish:"es", french:"fr", italian:"it", korean:"ko" })[raw] || raw;
}

export async function resolveDefaultVoiceProfile({
  practiceLanguage,
  genderStyle = "female",
  locale = null,
} = {}) {
  const language = normalizePracticeLanguage(practiceLanguage);
  const gender = String(genderStyle || "female").trim().toLowerCase();
  const resolvedLocale = String(locale || "").trim() || DEFAULT_LOCALE_BY_LANGUAGE[language] || null;

  if (!language) throw new Error("missing_practice_language");
  if (!["female", "male"].includes(gender)) throw new Error(`unsupported_gender_style: ${gender}`);
  if (!resolvedLocale) throw new Error(`unsupported_practice_language: ${language}`);

  let q = await pool.query(`
    select *
    from voice_profiles
    where provider = 'elevenlabs'
      and is_active = true
      and language = $1
      and locale = $2
      and gender_style = $3
    order by is_default desc, id asc
    limit 1
  `, [language, resolvedLocale, gender]);

  if (!q.rowCount && !(language === "en" && resolvedLocale === "en-CA")) {
    q = await pool.query(`
      select *
      from voice_profiles
      where provider = 'elevenlabs'
        and is_active = true
        and language = 'en'
        and locale = 'en-CA'
        and gender_style = $1
      order by is_default desc, id asc
      limit 1
    `, [gender]);
  }

  if (!q.rowCount) {
    throw new Error(`default_voice_profile_not_found: ${language}/${resolvedLocale}/${gender}`);
  }

  return q.rows[0];
}
