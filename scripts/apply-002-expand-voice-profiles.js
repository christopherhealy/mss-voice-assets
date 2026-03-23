#!/usr/bin/env node
import "dotenv/config";
import fs from "fs";
import path from "path";
import pg from "pg";
import { fileURLToPath } from "url";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sqlPath = path.join(rootDir, "sql", "002_expand_voice_profiles.sql");

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing");
  process.exit(1);
}

if (!fs.existsSync(sqlPath)) {
  console.error(`❌ SQL file not found: ${sqlPath}`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

async function main() {
  const sql = fs.readFileSync(sqlPath, "utf8");

  console.log("======================================");
  console.log("Apply 002 Expand Voice Profiles");
  console.log("SQL file:", sqlPath);
  console.log("======================================");

  await pool.query(sql);

  console.log("✅ Voice profiles expanded successfully");
}

main()
  .catch((err) => {
    console.error("❌ APPLY FAILED");
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });