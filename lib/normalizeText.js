export function normalizeText(input) {
  return String(input || "")
    .replace(/\s+/g, " ")
    .trim();
}