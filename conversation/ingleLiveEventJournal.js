// ============================================================
// conversation/ingleLiveEventJournal.js
//
// Durable GPT Live lifecycle event journal.
//
// Voice Assets records provider events in PostgreSQL.
// Ingle remains authoritative for Member Minutes billing.
//
// SECURITY:
// - The journal never debits Member Minutes.
// - Provider-confirmed closure requires final usage.
// - Event identity is stable across retries.
// - Processing status is assigned atomically on INSERT.
// - Duplicate event keys cannot silently change usage.
// - Duplicate recording never resets processing state.
//
// IMPORTANT:
// The journal preserves provider evidence, but does not
// guarantee delivery or termination of an active session.
// ============================================================

import { pool } from "../lib/db.js";

// ============================================================
// Supported lifecycle events
// ============================================================

const EVENT_TYPES = new Set([
  "session_created",
  "session_started",
  "session_closed",
  "session_unconfirmed",
  "cleanup_requested",
  "cleanup_confirmed",
]);

// Only these states can be assigned when an event is created.
// Subsequent transitions belong to lifecycle processors.
const INITIAL_STATUSES = new Set([
  "pending",
  "manual_review",
]);

// PostgreSQL stores usage_seconds as NUMERIC(12,3).
const MAX_USAGE_SECONDS = 86400;

// ============================================================
// Validation helpers
// ============================================================

function validGrantUid(value) {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value
    )
  );
}

function validEventKey(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 240 &&
    value.trim() === value
  );
}

function validOptionalText(value, maxLength = 500) {
  return (
    value === null ||
    (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength
    )
  );
}

function normalizeUsageSeconds(value) {
  if (value === null) {
    return null;
  }

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_USAGE_SECONDS
  ) {
    throw new Error("live_journal_invalid_usage");
  }

  // Normalize once to match PostgreSQL NUMERIC(12,3).
  return Math.round(value * 1000) / 1000;
}

function validPayload(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

// ============================================================
// Record an immutable lifecycle event.
//
// New events are inserted directly in their initial status.
//
// pending:
//   Eligible for appropriate automatic processing.
//
// manual_review:
//   Not eligible for the ordinary recovery worker.
//
// IMPORTANT:
// Duplicate event keys preserve the original processing
// status. They never reset an event to pending.
// ============================================================

export async function recordLiveLifecycleEvent({
  grantUid,
  sessionId = null,
  eventKey,
  eventType,
  providerEventId = null,
  usageSeconds = null,
  closeReason = null,
  payload = {},
  initialStatus = "pending",
}, db = pool) {
  if (!db || typeof db.query !== "function") {
    throw new Error("live_journal_database_client_required");
  }
  // ----------------------------------------------------------
  // 1. Validate identity and event type.
  // ----------------------------------------------------------

  if (!validGrantUid(grantUid)) {
    throw new Error("live_journal_invalid_grant");
  }

  if (!validEventKey(eventKey)) {
    throw new Error("live_journal_invalid_event_key");
  }

  if (!EVENT_TYPES.has(eventType)) {
    throw new Error("live_journal_invalid_event_type");
  }

  if (!INITIAL_STATUSES.has(initialStatus)) {
    throw new Error("live_journal_invalid_initial_status");
  }

  if (!validOptionalText(sessionId, 200)) {
    throw new Error("live_journal_invalid_session_id");
  }

  if (!validOptionalText(providerEventId, 200)) {
    throw new Error("live_journal_invalid_provider_event_id");
  }

  if (!validOptionalText(closeReason, 500)) {
    throw new Error("live_journal_invalid_close_reason");
  }

  if (!validPayload(payload)) {
    throw new Error("live_journal_invalid_payload");
  }

  const normalizedUsageSeconds =
    normalizeUsageSeconds(usageSeconds);

  // ----------------------------------------------------------
  // 2. Validate confirmed closure.
  //
  // A valid zero is different from missing usage.
  // ----------------------------------------------------------

  if (
    eventType === "session_closed" &&
    (
      !sessionId ||
      !providerEventId ||
      normalizedUsageSeconds === null
    )
  ) {
    throw new Error("live_journal_closure_incomplete");
  }

  // ----------------------------------------------------------
  // 3. Insert event with its initial state atomically.
  //
  // In particular, unacknowledged confirmed closures can be
  // written directly as manual_review.
  //
  // No separate UPDATE is required to make them ineligible
  // for the automatic recovery worker.
  // ----------------------------------------------------------

  const result = await db.query(
    `
      INSERT INTO public.ingle_live_lifecycle_events (
        grant_uid,
        session_id,
        event_key,
        event_type,
        provider_event_id,
        usage_seconds,
        close_reason,
        event_payload,
        processing_status,
        next_attempt_at
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9,
        CASE
          WHEN $9 = 'pending' THEN NOW()
          ELSE NULL
        END
      )
      ON CONFLICT (event_key) DO NOTHING
      RETURNING id
    `,
    [
      grantUid,
      sessionId,
      eventKey,
      eventType,
      providerEventId,
      normalizedUsageSeconds,
      closeReason,
      JSON.stringify(payload),
      initialStatus,
    ]
  );

  if (result.rows.length > 0) {
    return {
      recorded: true,
      duplicate: false,
      eventId: result.rows[0].id,
      initialStatus,
    };
  }

  // ----------------------------------------------------------
  // 4. Validate a duplicate.
  //
  // Never accept a reused event key with different immutable
  // event data.
  //
  // Do not update processing_status, attempt_count, leases,
  // or retry scheduling on duplicates.
  // ----------------------------------------------------------

  const existing = await db.query(
    `
      SELECT
        id,
        grant_uid,
        session_id,
        event_key,
        event_type,
        provider_event_id,
        usage_seconds,
        close_reason,
        event_payload,
        processing_status
      FROM public.ingle_live_lifecycle_events
      WHERE event_key = $1
      LIMIT 1
    `,
    [eventKey]
  );

  const row = existing.rows[0] || null;

  // PostgreSQL NUMERIC is returned as text by pg.
  const storedUsageSeconds =
    row?.usage_seconds === null ||
    row?.usage_seconds === undefined
      ? null
      : Number(row.usage_seconds);

  const usageMatches =
    storedUsageSeconds === normalizedUsageSeconds;

  // ----------------------------------------------------------
  // Compare JSONB payloads by value, not property order.
  //
  // PostgreSQL JSONB does not preserve object key ordering.
  // ----------------------------------------------------------

  const payloadComparison = await db.query(
    `
      SELECT
        event_payload = $2::jsonb AS matches
      FROM public.ingle_live_lifecycle_events
      WHERE event_key = $1
    `,
    [
      eventKey,
      JSON.stringify(payload),
    ]
  );

  const payloadMatches =
    payloadComparison.rows[0]?.matches === true;
  if (
    !row ||
    String(row.grant_uid).toLowerCase() !==
      grantUid.toLowerCase() ||
    row.session_id !== sessionId ||
    row.event_key !== eventKey ||
    row.event_type !== eventType ||
    row.provider_event_id !== providerEventId ||
    !usageMatches ||
    row.close_reason !== closeReason ||
    !payloadMatches
  ) {
    throw new Error("live_journal_event_conflict");
  }

  // ----------------------------------------------------------
  // 5. Return the existing event without changing its state.
  //
  // A pending/retry/processing/completed/manual_review event
  // remains in its recorded state.
  // ----------------------------------------------------------

  return {
    recorded: true,
    duplicate: true,
    eventId: row.id,
    initialStatus: row.processing_status,
  };
}
