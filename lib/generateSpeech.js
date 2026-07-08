import { generateSpeech as generateOpenAISpeech } from "./generateSpeech.openai.js";
import { generateSpeech as generateElevenLabsSpeech } from "./generateSpeech.elevenlabs.js";

const VOICE_PROVIDER = String(process.env.VOICE_PROVIDER || "openai")
  .trim()
  .toLowerCase();

console.log("VOICE_PROVIDER =", VOICE_PROVIDER);

export async function generateSpeech(args) {
  if (VOICE_PROVIDER === "elevenlabs") {
    return generateElevenLabsSpeech(args);
  }

  return generateOpenAISpeech(args);
}