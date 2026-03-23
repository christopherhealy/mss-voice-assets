export function buildStorageKey({
  voiceCode,
  textType,
  textId,
  textHash,
}) {
  const safeTextId = String(textId || "").replace(/[^a-z0-9:_-]/gi, "_");
  return `${voiceCode}/${textType}/${safeTextId}/${textHash}.mp3`;
}