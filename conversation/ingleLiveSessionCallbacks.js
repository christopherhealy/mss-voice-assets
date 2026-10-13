// ============================================================
// conversation/ingleLiveSessionCallbacks.js
//
// Durable GPT Live lifecycle callbacks.
//
// Confirmed closure:
//   OpenAI session.closed
//     -> PostgreSQL lifecycle journal
//     -> Ingle authoritative finalization
//     -> Journal completed
//
// Unverified acknowledgement:
//   OpenAI session.closed
//     -> PostgreSQL manual_review
//     -> Explicit reconciliation required
//
// SECURITY:
// - Never bill from browser-reported usage.
// - Never finalize without provider-confirmed usage.
// - Journal closure before attempting finalization.
// - Deferred closure status is assigned atomically.
// - Never automatically finalize a deferred closure.
// - Never overwrite a recovery worker's lease.
// - Never interpret socket closure as provider termination.
//
// RELEASE LIMITATIONS:
// - Recovery worker scheduling remains to be completed.
// - Unacknowledged sessions require reconciliation.
// - Provider-side restart recovery remains outstanding.
// ============================================================

import {
  finalizeLiveSession,
} from "./ingleLiveLifecycleClient.js";

import {
  recordLiveLifecycleEvent,
} from "./ingleLiveEventJournal.js";

import { pool } from "../lib/db.js";

// ============================================================
// Helpers
// ============================================================

function normalizeUsageSeconds(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 86400
  ) {
    throw new Error("live_final_usage_invalid");
  }

  return Math.round(value * 1000) / 1000;
}

function validProviderEventId(value) {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9_-]{1,200}$/.test(value)
  );
}

// ============================================================
// Confirmed provider closure
//
// finalizeImmediately = true:
//   Attempt authoritative Ingle finalization.
//
// finalizeImmediately = false:
//   Persist closure in manual_review without billing.
// ============================================================

export async function reportLiveSessionClosed(
  event,
  { finalizeImmediately = true } = {}
) {
  // ----------------------------------------------------------
  // 1. Validate provider-confirmed usage.
  // ----------------------------------------------------------

  if (event?.usageConfirmed !== true) {
    throw new Error("live_final_usage_not_confirmed");
  }

  if (!validProviderEventId(event.providerEventId)) {
    throw new Error("live_final_provider_event_missing");
  }

  const usageSeconds = normalizeUsageSeconds(
    event.usageSeconds
  );

  const eventKey =
    `openai:session_closed:${event.grantUid}`;

  // ----------------------------------------------------------
  // 2. Persist provider evidence.
  //
  // The event's initial processing state is assigned in
  // the INSERT itself.
  //
  // A deferred closure never briefly enters the retry queue.
  // ----------------------------------------------------------

  const journal = await recordLiveLifecycleEvent({
    grantUid: event.grantUid,
    sessionId: event.sessionId,

    eventKey,
    eventType: "session_closed",

    providerEventId: event.providerEventId,
    usageSeconds,
    closeReason: event.reason ?? null,

    payload: {
      provider: "openai",
      usage_confirmed: true,
    },

    initialStatus: finalizeImmediately
      ? "pending"
      : "manual_review",
  });

  // ----------------------------------------------------------
  // 3. Deferred closure.
  //
  // Ingle has not verified the provider session association.
  //
  // The journal already contains manual_review.
  // Do not call the finalization endpoint.
  // ----------------------------------------------------------

  if (!finalizeImmediately) {
    // A duplicate may already have a different processing
    // state. Never imply it was safely deferred unless
    // the existing row is actually in manual_review.
    if (journal.initialStatus !== "manual_review") {
      throw new Error(
        "live_closure_deferred_state_conflict"
      );
    }

    console.warn(
      "LIVE_CLOSURE_AWAITING_RECONCILIATION",
      {
        grantUid: event.grantUid,
        sessionId: event.sessionId,
        journalEventId: journal.eventId,
      }
    );

    return {
      ok: true,
      recorded: true,
      finalized: false,
      requiresReconciliation: true,
      journalEventId: journal.eventId,
    };
  }

  // ----------------------------------------------------------
  // 4. Never bypass a previous reconciliation decision.
  //
  // A duplicate callback cannot convert manual_review
  // into automatic finalization.
  // ----------------------------------------------------------

  if (journal.initialStatus === "manual_review") {
    throw new Error(
      "live_closure_requires_reconciliation"
    );
  }

  // ----------------------------------------------------------
  // 5. Already completed event.
  //
  // The journal's status is authoritative for delivery state.
  // No additional finalization request is needed.
  // ----------------------------------------------------------

  if (journal.initialStatus === "completed") {
    return {
      ok: true,
      recorded: true,
      finalized: true,
      alreadyFinalized: true,
      journalEventId: journal.eventId,
    };
  }

  // ----------------------------------------------------------
  // 6. Attempt authoritative Ingle finalization.
  //
  // Ingle owns the Minutes ledger and grant finalization.
  //
  // Its grant-based idempotency protects against repeated
  // HTTP requests for the same confirmed closure.
  // ----------------------------------------------------------

  try {
    const result = await finalizeLiveSession({
      grantUid: event.grantUid,
      sessionId: event.sessionId,
      usageSeconds,
      providerEventId: event.providerEventId,
      closeReason: event.reason ?? null,
    });

    if (!result?.ok) {
      throw new Error(
        "live_finalization_not_acknowledged"
      );
    }

    // --------------------------------------------------------
    // 7. Mark completed.
    //
    // Do not overwrite a recovery worker's active lease.
    // --------------------------------------------------------

    const completion = await pool.query(
      `
        UPDATE public.ingle_live_lifecycle_events
        SET
          processing_status = 'completed',
          processed_at = NOW(),
          last_error = NULL,
          next_attempt_at = NULL,
          lease_token = NULL,
          lease_expires_at = NULL
        WHERE id = $1
          AND event_type = 'session_closed'
          AND processing_status IN ('pending', 'retry')
          AND lease_token IS NULL
        RETURNING id
      `,
      [journal.eventId]
    );

    if (completion.rowCount === 0) {
      console.log(
        "LIVE_FINALIZATION_JOURNAL_OWNED_ELSEWHERE",
        {
          journalEventId: journal.eventId,
          grantUid: event.grantUid,
        }
      );
    }

    console.log(
      "LIVE_SESSION_FINALIZATION_COMPLETE",
      {
        grantUid: event.grantUid,
        sessionId: event.sessionId,
        usageSeconds,
        journalEventId: journal.eventId,
      }
    );

    return result;

  } catch (error) {

    // --------------------------------------------------------
    // 8. Preserve failed delivery for recovery.
    //
    // The callback never modifies events owned by another
    // worker and does not increment recovery attempt_count.
    // --------------------------------------------------------

    const retry = await pool.query(
      `
        UPDATE public.ingle_live_lifecycle_events
        SET
          processing_status = 'retry',
          next_attempt_at =
            NOW() + INTERVAL '1 minute',
          last_error = LEFT($2, 500),
          lease_token = NULL,
          lease_expires_at = NULL
        WHERE id = $1
          AND event_type = 'session_closed'
          AND processing_status IN ('pending', 'retry')
          AND lease_token IS NULL
        RETURNING id
      `,
      [
        journal.eventId,
        error?.message ||
          "unknown_finalization_error",
      ]
    );

    if (retry.rowCount === 0) {
      console.log(
        "LIVE_FINALIZATION_RETRY_OWNED_ELSEWHERE",
        {
          journalEventId: journal.eventId,
          grantUid: event.grantUid,
        }
      );
    }

    console.error(
      "LIVE_SESSION_FINALIZATION_RETRY_REQUIRED",
      {
        grantUid: event.grantUid,
        sessionId: event.sessionId,
        journalEventId: journal.eventId,
        message: error?.message,
      }
    );

    throw error;
  }
}

// ============================================================
// Unconfirmed provider termination
//
// Socket loss, cleanup failure, or unavailable final usage
// must never become an invented closure event.
//
// Each distinct reason receives its own durable event key,
// allowing multiple failure observations to be preserved.
//
// Repeating the same observation remains idempotent.
// ============================================================

export async function reportLiveSessionUnconfirmed(event) {
  const grantUid = String(
    event?.grantUid || ""
  ).trim();

  const sessionId =
    event?.sessionId || null;

  const reason = String(
    event?.reason || "unknown"
  ).trim();

  const lastKnownUsageSeconds =
    event?.lastKnownUsageSeconds ?? null;

  // Distinct reasons get distinct journal entries.
  // The journal validates the grant and session fields.
  const eventKey =
    `openai:unconfirmed:${grantUid}:${reason}`;

  const journal = await recordLiveLifecycleEvent({
    grantUid,
    sessionId,
    eventKey,
    eventType: "session_unconfirmed",

    closeReason: reason,

    payload: {
      last_known_usage_seconds:
        lastKnownUsageSeconds,
    },

    // Unconfirmed termination must never enter the
    // ordinary confirmed-closure recovery queue.
    initialStatus: "manual_review",
  });

  console.error(
    "LIVE_SESSION_UNCONFIRMED",
    {
      grantUid,
      sessionId,
      reason,
      journalEventId: journal.eventId,
    }
  );

  return journal;
}
