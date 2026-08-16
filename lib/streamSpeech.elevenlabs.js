function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function estimateCostUsd(characterCount) {
  const rate =
    Number(
      process.env.ELEVENLABS_TTS_COST_PER_1K_CHARS ||
      0
    );

  if (!rate) {
    return null;
  }

  return Number(
    (
      (characterCount / 1000) *
      rate
    ).toFixed(8)
  );
}

export async function streamElevenLabsSpeech({ res, text, voiceProfile }) {
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

  const modelId =
    process.env.ELEVENLABS_STREAM_MODEL_ID ||
    process.env.ELEVENLABS_MODEL_ID ||
    "eleven_flash_v2_5";

  const characterCount =
    inputText.length;

  const estimatedCostUsd =
    estimateCostUsd(
      characterCount
    );

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
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

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    throw new Error(`elevenlabs_stream_failed: ${upstream.status} ${body}`);
  }

  res.status(200);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Voice-Provider", "elevenlabs");
  res.setHeader("X-Voice-Model", modelId);
  res.setHeader("X-Voice-Code", String(voiceProfile?.persona_code || voiceId));
  res.setHeader(
    "X-Voice-Characters",
    String(characterCount)
  );

  if (estimatedCostUsd !== null) {
    res.setHeader(
      "X-Voice-Estimated-Cost-Usd",
      String(estimatedCostUsd)
    );
  }

  const providerRequestId =
    String(
      upstream.headers.get("request-id") ||
      upstream.headers.get("x-request-id") ||
      upstream.headers.get("xi-request-id") ||
      ""
    ).trim();

  if (providerRequestId) {
    res.setHeader(
      "X-Voice-Request-Id",
      providerRequestId
    );
  }

  const reader = upstream.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        res.write(Buffer.from(value));
      }
    }
  } finally {
    res.end();
  }
}