import { normalizeText } from "./normalizeText.js";
import { hashText } from "./hashText.js";
import { resolveVoiceProfile } from "./resolveVoiceProfile.js";
import { getOrCreateTextItem } from "./getOrCreateTextItem.js";
import { findExistingAsset } from "./findExistingAsset.js";
import { upsertVoiceAsset } from "./upsertVoiceAsset.js";
import { generateSpeech } from "./generateSpeech.js";
import { buildStorageKey } from "./buildStorageKey.js";
import { uploadToR2 } from "./uploadToR2.js";

function computeExpiresAt(storageType) {
  if (storageType === "short_duration") {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

export async function getOrCreateVoiceAsset({
  textId,
  textType,
  text,
  storageType,
  voiceProfileCode,
  metadata = {},
}) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    throw new Error("empty_text");
  }

  const normalizedTextId = String(textId || "").trim();
  if (!normalizedTextId) {
    throw new Error("missing_text_id");
  }

  const normalizedTextType = String(textType || "").trim().toLowerCase();
  if (!normalizedTextType) {
    throw new Error("missing_text_type");
  }

  const normalizedStorageType = String(storageType || "").trim().toLowerCase();
  if (!normalizedStorageType) {
    throw new Error("missing_storage_type");
  }

  const textHash = hashText(normalizedText);
  const voiceProfile = await resolveVoiceProfile(voiceProfileCode);

  const textItem = await getOrCreateTextItem({
    textId: normalizedTextId,
    textType: normalizedTextType,
    sourceText: normalizedText,
    textHash,
    storageType: normalizedStorageType,
    metadataJson: metadata,
  });

  const existing = await findExistingAsset({
    textItemId: textItem.id,
    voiceProfileId: voiceProfile.id,
    textHash,
  });

  if (existing && existing.asset_status === "ready" && existing.audio_url) {
    return {
      ok: true,
      cacheHit: true,
      textItem,
      voiceProfile,
      asset: existing,
      textHash,
    };
  }

  const { buffer, mimeType } = await generateSpeech({
    text: normalizedText,
    voiceProfile,
  });

  const storageKey = buildStorageKey({
    voiceCode: voiceProfile.voice_code,
    textType: normalizedTextType,
    textId: normalizedTextId,
    textHash,
  });

  const { publicUrl } = await uploadToR2({
    buffer,
    storageKey,
    contentType: mimeType || "audio/mpeg",
  });

  const asset = await upsertVoiceAsset({
    textItemId: textItem.id,
    voiceProfileId: voiceProfile.id,
    textHash,
    storageType: normalizedStorageType,
    storageKey,
    audioUrl: publicUrl,
    mimeType: mimeType || "audio/mpeg",
    assetStatus: "ready",
    expiresAt: computeExpiresAt(normalizedStorageType),
  });

  return {
    ok: true,
    cacheHit: false,
    textItem,
    voiceProfile,
    asset,
    textHash,
  };
}