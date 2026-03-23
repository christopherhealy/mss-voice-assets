import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function saveLocalAudio({ buffer, storageKey }) {
  const baseDir = path.join(__dirname, "..", "public", "mock-audio");
  const fullPath = path.join(baseDir, storageKey);

  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, buffer);

  return {
    storageKey,
    publicUrl: `/mock-audio/${storageKey}`,
  };
}