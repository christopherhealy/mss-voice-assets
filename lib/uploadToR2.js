import "dotenv/config";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const {
  R2_ACCOUNT_ID,
  R2_BUCKET,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_PUBLIC_BASE_URL,
} = process.env;

function joinUrl(base, key) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(key || "").replace(/^\/+/, "")}`;
}

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export async function uploadToR2({ buffer, storageKey, contentType = "audio/mpeg" }) {
  if (!R2_ACCOUNT_ID) throw new Error("missing_r2_account_id");
  if (!R2_BUCKET) throw new Error("missing_r2_bucket");
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("missing_r2_credentials");
  }
  if (!R2_PUBLIC_BASE_URL) {
    throw new Error("missing_r2_public_base_url");
  }

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: storageKey,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return {
    storageKey,
    publicUrl: joinUrl(R2_PUBLIC_BASE_URL, storageKey),
  };
}