import crypto from "crypto";

export function hashText(text) {
  return crypto
    .createHash("sha256")
    .update(String(text || ""), "utf8")
    .digest("hex");
}