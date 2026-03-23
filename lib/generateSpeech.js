import OpenAI from "openai";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("missing_openai_api_key");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function resolveOpenAIVoice(voiceProfile) {
  const code = String(voiceProfile?.voice_code || "").trim().toLowerCase();

  const voiceMap = {
    female_canadian_01: "alloy",
    male_canadian_01: "echo",

    female_us_01: "shimmer",
    male_us_01: "onyx",

    female_uk_01: "sage",
    male_uk_01: "fable",

    female_au_01: "nova",

    female_es_spain_01: "alloy",
    female_es_mexico_01: "shimmer",
    female_es_argentina_01: "sage",

    female_fr_paris_01: "nova",
    female_fr_quebec_01: "shimmer",

    female_it_rome_01: "alloy",
    female_it_tuscany_01: "sage",
  };

  return voiceMap[code] || "alloy";
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeInstructions(stylePrompt) {
  const s = String(stylePrompt || "").replace(/\s+/g, " ").trim();
  return s || undefined;
}

export async function generateSpeech({ text, voiceProfile }) {
  const inputText = normalizeText(text);
  if (!inputText) {
    throw new Error("empty_text_for_tts");
  }

  const voice = resolveOpenAIVoice(voiceProfile);
  const instructions = normalizeInstructions(voiceProfile?.style_prompt);

  const response = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    input: inputText,
    instructions,
    response_format: "mp3",
    speed: 1.0,
  });

  const buffer = Buffer.from(await response.arrayBuffer());

  return {
    buffer,
    mimeType: "audio/mpeg",
    providerResponseJson: {
      provider: "openai",
      model: "gpt-4o-mini-tts",
      voice,
      voice_code: String(voiceProfile?.voice_code || ""),
      instructions,
      input_length: inputText.length,
    },
  };
}