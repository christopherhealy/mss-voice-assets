import OpenAI from "openai";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("missing_openai_api_key");
}

const OPENAI_TTS_MODEL =
  process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";

const OPENAI_TTS_COST_PER_1K_CHARS =
  Number(process.env.OPENAI_TTS_COST_PER_1K_CHARS || 0);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function resolveOpenAIVoice(voiceProfile) {
  const code = String(voiceProfile?.voice_code || "").trim().toLowerCase();

const voiceMap = {
  emma_toronto_01: "coral",
  jake_seattle_01: "onyx",
  oliver_london_01: "fable",
  sophie_melbourne_01: "nova",
};

  return voiceMap[code] || "alloy";
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeInstructions(value) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s || undefined;
}

function estimateCostUsd(characterCount) {
  if (!OPENAI_TTS_COST_PER_1K_CHARS) return null;
  return Number(
    ((characterCount / 1000) * OPENAI_TTS_COST_PER_1K_CHARS).toFixed(8)
  );
}

export async function generateSpeech({ text, voiceProfile }) {
  const inputText = normalizeText(text);

  if (!inputText) {
    throw new Error("empty_text_for_tts");
  }

  const startedAt = Date.now();
  const characterCount = inputText.length;
  const estimatedCostUsd = estimateCostUsd(characterCount);

  const voice = resolveOpenAIVoice(voiceProfile);

  // Source of truth: DB style_prompt.
  // Do not append additional code-level accent instructions here.
  const instructions = normalizeInstructions(voiceProfile?.style_prompt);

  const response = await client.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice,
    input: inputText,
    instructions,
    response_format: "mp3",
    speed: 1.0,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  const generationMs = Date.now() - startedAt;

  return {
    buffer,
    mimeType: "audio/mpeg",

    generationProvider: "openai",
    generationModel: OPENAI_TTS_MODEL,
    generationMs,
    characterCount,
    generationCostUsd: estimatedCostUsd,

    providerResponseJson: {
      provider: "openai",
      model: OPENAI_TTS_MODEL,
      voice,
      voice_code: String(voiceProfile?.voice_code || ""),
      persona_code: String(voiceProfile?.persona_code || ""),
      persona_name: String(voiceProfile?.persona_name || ""),
      accent: String(voiceProfile?.accent || ""),
      locale: String(voiceProfile?.locale || ""),
      language: String(voiceProfile?.language || ""),
      region: String(voiceProfile?.region || ""),
      instructions,
      input_length: characterCount,
      generation_ms: generationMs,
      estimated_cost_usd: estimatedCostUsd,
    },
  };
}