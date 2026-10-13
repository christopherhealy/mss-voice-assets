// ============================================================
// lib/ingle-live-session-lifecycle.js
//
// Ingle GPT Live — trusted session lifecycle.
//
// Records provider session creation against an authenticated,
// previously redeemed Live authorization grant.
//
// SECURITY:
// - Called only after service authentication.
// - Never accepts Member identity from the browser.
// - Cannot overwrite an existing provider session ID.
// - Cannot acknowledge an expired or unredeemed grant.
// - Session IDs are unique across grants.
// - Repeated identical acknowledgements are idempotent.
// ============================================================

function validGrantUid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function validSessionId(value) {
  return typeof value === "string" &&
    /^[-_a-zA-Z0-9]{8,200}$/.test(value);
}

export async function acknowledgeLiveSessionStarted(
  db,
  { grantUid, sessionId }
) {
  if (!db || typeof db.query !== "function") {
    throw new Error("live_lifecycle_database_required");
  }

  if (!validGrantUid(grantUid) || !validSessionId(sessionId)) {
    return {
      ok: false,
      error: "live_session_identity_invalid",
    };
  }

  const result = await db.query(
    `
      UPDATE public.ingle_live_grants

      SET
        session_id = $2,
        session_started_at = NOW()

      WHERE grant_uid = $1::uuid
        AND consumed_at IS NOT NULL
        AND finalized_at IS NULL
        AND session_id IS NULL
        AND session_started_at IS NULL
        AND session_deadline_at > NOW()

      RETURNING
        grant_uid,
        session_id,
        session_started_at,
        session_deadline_at
    `,
    [grantUid, sessionId]
  );

  if (result.rows.length) {
    return {
      ok: true,
      acknowledged: true,
      alreadyAcknowledged: false,
      session: result.rows[0],
    };
  }

  // Idempotent retry: accept only the exact same association.
  const existing = await db.query(
    `
      SELECT
        grant_uid,
        session_id,
        session_started_at,
        session_deadline_at

      FROM public.ingle_live_grants

      WHERE grant_uid = $1::uuid
        AND session_id = $2
        AND consumed_at IS NOT NULL
        AND finalized_at IS NULL
    `,
    [grantUid, sessionId]
  );

  if (existing.rows.length) {
    return {
      ok: true,
      acknowledged: true,
      alreadyAcknowledged: true,
      session: existing.rows[0],
    };
  }

  return {
    ok: false,
    error: "live_session_acknowledgement_rejected",
  };
}
