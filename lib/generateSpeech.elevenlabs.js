function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function estimateCostUsd(characterCount) {
  const rate = Number(process.env.ELEVENLABS_TTS_COST_PER_1K_CHARS || 0);
  if (!rate) return null;
  return Number(((characterCount / 1000) * rate).toFixed(8));
}

export async function generateSpeech({ text, voiceProfile }) {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("missing_elevenlabs_api_key");
  }

  const inputText = normalizeText(text);
  if (!inputText) {
    throw new Error("empty_text_for_tts");
  }

  const voiceId = String(voiceProfile?.voice_code || "").trim();
  if (!voiceId) {
    throw new Error("missing_elevenlabs_voice_id");
  }

  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

  const startedAt = Date.now();
  const characterCount = inputText.length;
  const estimatedCostUsd = estimateCostUsd(characterCount);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: inputText,
        model_id: modelId,
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.8,
          style: 0.25,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`elevenlabs_tts_failed: ${res.status} ${body}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const generationMs = Date.now() - startedAt;

  return {
    buffer,
    mimeType: "audio/mpeg",

    generationProvider: "elevenlabs",
    generationModel: modelId,
    generationMs,
    characterCount,
    generationCostUsd: estimatedCostUsd,

    providerResponseJson: {
      provider: "elevenlabs",
      model: modelId,
      voice_id: voiceId,
      provider_voice_name: String(voiceProfile?.notes || ""),
      persona_code: String(voiceProfile?.persona_code || ""),
      persona_name: String(voiceProfile?.persona_name || ""),
      accent: String(voiceProfile?.accent || ""),
      locale: String(voiceProfile?.locale || ""),
      language: String(voiceProfile?.language || ""),
      region: String(voiceProfile?.region || ""),
      city: String(voiceProfile?.city || ""),
      input_length: characterCount,
      generation_ms: generationMs,
      estimated_cost_usd: estimatedCostUsd,
    },
  };
}