// ============================================================
// conversation/ingleLiveLifecycleClient.js
//
// Trusted Voice Assets -> Ingle lifecycle API client.
//
// SECURITY:
// - Uses a server-side service credential.
// - Never exposes the credential to the browser.
// - Fails closed when configuration is missing.
// - Applies network timeouts.
// ============================================================

const REQUEST_TIMEOUT_MS = 8000;

function lifecycleConfig() {
  const baseUrl = String(
    process.env.INGLE_LIVE_LIFECYCLE_URL || ""
  ).trim().replace(/\/+$/, "");

  const serviceSecret = String(
    process.env.INGLE_VOICE_SERVICE_SECRET || ""
  ).trim();

  if (!baseUrl || !serviceSecret) {
    throw new Error("live_lifecycle_not_configured");
  }

  const url = new URL(baseUrl);

  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("live_lifecycle_url_invalid");
  }

  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    throw new Error("live_lifecycle_https_required");
  }

  return { baseUrl, serviceSecret };
}

async function postLifecycleEvent(path, payload) {
  const { baseUrl, serviceSecret } = lifecycleConfig();

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const error = new Error("live_lifecycle_request_rejected");
    error.status = response.status;
    throw error;
  }

  const result = await response.json();

  if (!result?.ok) {
    throw new Error("live_lifecycle_response_invalid");
  }

  return result;
}

// ============================================================
// Acknowledge that OpenAI created a Live session.
//
// Safe to retry with the same grant/session association.
// ============================================================

export async function acknowledgeLiveSession({
  grantUid,
  sessionId,
}) {
  return postLifecycleEvent("/session-started", {
    grant_uid: grantUid,
    session_id: sessionId,
  });
}

// ============================================================
// Report provider-confirmed GPT Live session closure.
//
// SECURITY:
// - Only call after receiving OpenAI session.closed.
// - usageSeconds must be final cumulative provider usage.
// - The Ingle endpoint handles transactional billing.
// - Retries use the same grant and provider event identifiers.
// ============================================================

export async function finalizeLiveSession({
  grantUid,
  sessionId,
  usageSeconds,
  providerEventId,
  closeReason = null,
}) {
  if (
    typeof usageSeconds !== "number" ||
    !Number.isFinite(usageSeconds) ||
    usageSeconds < 0
  ) {
    throw new Error("live_final_usage_invalid");
  }

  return postLifecycleEvent("/session-closed", {
    grant_uid: grantUid,
    session_id: sessionId,
    usage_seconds: usageSeconds,
    provider_event_id: providerEventId,
    close_reason: closeReason,
  });
}
