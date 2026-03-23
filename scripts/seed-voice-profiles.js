#!/usr/bin/env node
import "dotenv/config";
console.log("DATABASE_URL =", process.env.DATABASE_URL);
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

async function main() {
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
      is_active
    )
    values (
      'openai',
      'female_canadian_01',
      'Female Canadian 01',
      'canadian',
      'en-CA',
      'female',
      'normal',
      true
    )
    on conflict (provider, voice_code)
    do update set
      display_name = excluded.display_name,
      accent = excluded.accent,
      locale = excluded.locale,
      gender_style = excluded.gender_style,
      speed_default = excluded.speed_default,
      is_active = excluded.is_active,
      updated_at = now()
    returning *;
    `
  );

  console.log("✅ Voice profile seeded");
  console.log(q.rows[0]);
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