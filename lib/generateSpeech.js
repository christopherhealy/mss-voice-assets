const VOICE_PROVIDER = String(process.env.VOICE_PROVIDER || "openai")
  .trim()
  .toLowerCase();

console.log("VOICE_PROVIDER =", VOICE_PROVIDER);

export async function generateSpeech(args) {
  if (VOICE_PROVIDER === "elevenlabs") {
    const { generateSpeech } = await import("./generateSpeech.elevenlabs.js");
    return generateSpeech(args);
  }

  const { generateSpeech } = await import("./generateSpeech.openai.js");
  return generateSpeech(args);
}
