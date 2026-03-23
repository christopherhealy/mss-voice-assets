#!/usr/bin/env node
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

const profiles = [
  {
    provider: "openai",
    voice_code: "female_canadian_01",
    display_name: "English — Canada (Female)",
    accent: "canadian",
    locale: "en-CA",
    gender_style: "female",
    speed_default: "normal",
    language: "english",
    region: "canada",
    style_prompt: "Speak in a clear, neutral Canadian English accent suitable for language learners.",
    is_default: true
  },
  {
    provider: "openai",
    voice_code: "male_canadian_01",
    display_name: "English — Canada (Male)",
    accent: "canadian",
    locale: "en-CA",
    gender_style: "male",
    speed_default: "normal",
    language: "english",
    region: "canada",
    style_prompt: "Speak in a clear, neutral Canadian English accent suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_us_01",
    display_name: "English — US Neutral (Female)",
    accent: "american",
    locale: "en-US",
    gender_style: "female",
    speed_default: "normal",
    language: "english",
    region: "usa",
    style_prompt: "Speak in a clear, neutral American English accent suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "male_us_01",
    display_name: "English — US Neutral (Male)",
    accent: "american",
    locale: "en-US",
    gender_style: "male",
    speed_default: "normal",
    language: "english",
    region: "usa",
    style_prompt: "Speak in a clear, neutral American English accent suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_uk_01",
    display_name: "English — UK Neutral (Female)",
    accent: "british",
    locale: "en-GB",
    gender_style: "female",
    speed_default: "normal",
    language: "english",
    region: "uk",
    style_prompt: "Speak in a clear, neutral British English accent suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "male_uk_01",
    display_name: "English — UK Neutral (Male)",
    accent: "british",
    locale: "en-GB",
    gender_style: "male",
    speed_default: "normal",
    language: "english",
    region: "uk",
    style_prompt: "Speak in a clear, neutral British English accent suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_au_01",
    display_name: "English — Australia",
    accent: "australian",
    locale: "en-AU",
    gender_style: "female",
    speed_default: "normal",
    language: "english",
    region: "australia",
    style_prompt: "Speak in a clear Australian English accent suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_es_spain_01",
    display_name: "Spanish — Spain",
    accent: "spain",
    locale: "es-ES",
    gender_style: "female",
    speed_default: "normal",
    language: "spanish",
    region: "spain",
    style_prompt: "Speak in clear Spain Spanish with natural rhythm suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_es_mexico_01",
    display_name: "Spanish — Mexico",
    accent: "mexico",
    locale: "es-MX",
    gender_style: "female",
    speed_default: "normal",
    language: "spanish",
    region: "mexico",
    style_prompt: "Speak in clear Mexican Spanish with natural rhythm suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_es_argentina_01",
    display_name: "Spanish — Argentina",
    accent: "argentina",
    locale: "es-AR",
    gender_style: "female",
    speed_default: "normal",
    language: "spanish",
    region: "argentina",
    style_prompt: "Speak in clear Argentine Spanish with natural rhythm suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_fr_paris_01",
    display_name: "French — Paris",
    accent: "paris",
    locale: "fr-FR",
    gender_style: "female",
    speed_default: "normal",
    language: "french",
    region: "france",
    style_prompt: "Speak in clear Parisian French suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_fr_quebec_01",
    display_name: "French — Québec",
    accent: "quebec",
    locale: "fr-CA",
    gender_style: "female",
    speed_default: "normal",
    language: "french",
    region: "quebec",
    style_prompt: "Speak in clear Québec French suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_it_rome_01",
    display_name: "Italian — Rome",
    accent: "rome",
    locale: "it-IT",
    gender_style: "female",
    speed_default: "normal",
    language: "italian",
    region: "rome",
    style_prompt: "Speak in clear standard Italian with a Roman flavor suitable for language learners.",
    is_default: false
  },
  {
    provider: "openai",
    voice_code: "female_it_tuscany_01",
    display_name: "Italian — Tuscany",
    accent: "tuscany",
    locale: "it-IT",
    gender_style: "female",
    speed_default: "normal",
    language: "italian",
    region: "tuscany",
    style_prompt: "Speak in clear standard Italian with a Tuscan flavor suitable for language learners.",
    is_default: false
  }
];

async function upsertProfile(p) {
  const q = await pool.query(
    `
    insert into voice_profiles (
      provider,
      voice_code,
      display_name,
      accent,
      locale,
      gender_style,
      speed_default,
      is_active,
      language,
      region,
      style_prompt,
      is_default
    )
    values (
      $1,$2,$3,$4,$5,$6,$7,true,$8,$9,$10,$11
    )
    on conflict (provider, voice_code)
    do update set
      display_name = excluded.display_name,
      accent = excluded.accent,
      locale = excluded.locale,
      gender_style = excluded.gender_style,
      speed_default = excluded.speed_default,
      language = excluded.language,
      region = excluded.region,
      style_prompt = excluded.style_prompt,
      is_default = excluded.is_default,
      is_active = true,
      updated_at = now()
    returning id, voice_code, display_name, language, region
    `,
    [
      p.provider,
      p.voice_code,
      p.display_name,
      p.accent,
      p.locale,
      p.gender_style,
      p.speed_default,
      p.language,
      p.region,
      p.style_prompt,
      p.is_default
    ]
  );

  return q.rows[0];
}

async function main() {
  console.log("======================================");
  console.log("Seed Voice Profiles v1");
  console.log("======================================");

  const results = [];
  for (const profile of profiles) {
    const row = await upsertProfile(profile);
    results.push(row);
    console.log(`✅ ${row.voice_code} → ${row.display_name}`);
  }

  console.log("======================================");
  console.log(`Done. Seeded/updated ${results.length} profiles.`);
}

main()
  .catch((err) => {
    console.error("❌ SEED FAILED");
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });