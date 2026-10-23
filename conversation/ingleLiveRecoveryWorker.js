import {qaDrain} from '../lib/qa-drain.js';
// ============================================================
// conversation/ingleLiveRecoveryWorker.js
//
// Durable GPT Live confirmed-closure recovery worker.
//
// Voice Assets persists provider events in PostgreSQL.
// Ingle remains authoritative for Member Minutes debits.
//
// SECURITY:
// - Processes confirmed session_closed events only.
// - Claims events transactionally using SKIP LOCKED.
// - Uses lease ownership to prevent stale-worker updates.
// - Never automatically retries exhausted events.
// - Relies on Ingle's idempotent grant-based ledger debit.
// - Never derives usage from browser data.
// - Never treats connection loss as provider termination.
//
// TESTABILITY:
// - Database and finalization function may be injected.
// - Production defaults remain the PostgreSQL pool and
//   trusted Ingle lifecycle client.
// ============================================================

import crypto from "node:crypto";

import { pool } from "../lib/db.js";

import {
  finalizeLiveSession,
} from "./ingleLiveLifecycleClient.js";

const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 10;

// ------------------------------------------------------------
// Claim one eligible event.
//
// Exhausted events with expired leases are moved directly
// to manual_review, without another financial API call.
//
// A transaction is never held open during HTTP.
// ------------------------------------------------------------

async function claimNextEvent(db, eventId = null) {
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        SELECT
          id,
          grant_uid,
          session_id,
          provider_event_id,
          usage_seconds,
          close_reason,
          attempt_count
        FROM public.ingle_live_lifecycle_events
        WHERE event_type = 'session_closed'
          AND ($1::bigint IS NULL OR id = $1::bigint)
          AND (
            (
              processing_status IN ('pending', 'retry')
              AND (
                next_attempt_at IS NULL
                OR next_attempt_at <= NOW()
              )
            )
            OR (
              processing_status = 'processing'
              AND lease_expires_at < NOW()
            )
          )
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
      [eventId]
    );

    const event = result.rows[0];

    if (!event) {
      await client.query("COMMIT");
      return null;
    }

    if (Number(event.attempt_count) >= MAX_ATTEMPTS) {
      await client.query(
        `
          UPDATE public.ingle_live_lifecycle_events
          SET
            processing_status = 'manual_review',
            lease_token = NULL,
            lease_expires_at = NULL,
            next_attempt_at = NULL,
            last_error = COALESCE(
              last_error,
              'live_recovery_attempts_exhausted'
            )
          WHERE id = $1
        `,
        [event.id]
      );

      await client.query("COMMIT");

      return {
        id: event.id,
        exhausted: true,
      };
    }

    const leaseToken = crypto.randomUUID();

    await client.query(
      `
        UPDATE public.ingle_live_lifecycle_events
        SET
          processing_status = 'processing',
          lease_token = $2::uuid,
          lease_expires_at =
            NOW() + ($3::integer * INTERVAL '1 second'),
          attempt_count = attempt_count + 1,
          next_attempt_at = NULL
        WHERE id = $1
      `,
      [event.id, leaseToken, LEASE_SECONDS]
    );

    await client.query("COMMIT");

    return {
      ...event,
      leaseToken,
      attemptNumber: Number(event.attempt_count) + 1,
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// Mark successful finalization.
//
// Only the current lease owner may complete the event.
// ------------------------------------------------------------

async function markCompleted(db, event) {
  const result = await db.query(
    `
      UPDATE public.ingle_live_lifecycle_events
      SET
        processing_status = 'completed',
        processed_at = NOW(),
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = NULL,
        last_error = NULL
      WHERE id = $1
        AND lease_token = $2::uuid
        AND processing_status = 'processing'
      RETURNING id
    `,
    [event.id, event.leaseToken]
  );

  return result.rowCount === 1;
}

// ------------------------------------------------------------
// Preserve failures with bounded exponential backoff.
// ------------------------------------------------------------

async function markFailed(db, event, error) {
  const attempt = event.attemptNumber;

  const manualReview = attempt >= MAX_ATTEMPTS;

  const backoffSeconds = Math.min(
    3600,
    60 * 2 ** Math.max(0, attempt - 1)
  );

  const result = await db.query(
    `
      UPDATE public.ingle_live_lifecycle_events
      SET
        processing_status = $3,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at =
          CASE
            WHEN $3 = 'manual_review' THEN NULL
            ELSE NOW() +
              ($4::integer * INTERVAL '1 second')
          END,
        last_error = LEFT($5, 500)
      WHERE id = $1
        AND lease_token = $2::uuid
        AND processing_status = 'processing'
      RETURNING id
    `,
    [
      event.id,
      event.leaseToken,
      manualReview ? "manual_review" : "retry",
      backoffSeconds,
      error?.message || "unknown_recovery_error",
    ]
  );

  return {
    updated: result.rowCount === 1,
    status: manualReview ? "manual_review" : "retry_scheduled",
  };
}

// ------------------------------------------------------------
// Process one claimed event.
// ------------------------------------------------------------

async function processEvent(db, finalize, event) {
  const grantUid = String(event.grant_uid);

  const sessionId = event.session_id;
  const providerEventId = event.provider_event_id;
  const usageSeconds = Number(event.usage_seconds);

  if (
    !sessionId ||
    !providerEventId ||
    event.usage_seconds === null ||
    !Number.isFinite(usageSeconds) ||
    usageSeconds < 0
  ) {
    const failure = await markFailed(
      db,
      event,
      new Error("live_recovery_event_incomplete")
    );

    return {
      eventId: event.id,
      status: failure.updated
        ? failure.status
        : "lease_lost",
      error: "live_recovery_event_incomplete",
    };
  }

  try {
    const result = await finalize({
      grantUid,
      sessionId,
      providerEventId,
      usageSeconds,
      closeReason: event.close_reason ?? null,
    });

    if (!result?.ok) {
      throw new Error(
        "live_recovery_finalization_not_acknowledged"
      );
    }

    const completed = await markCompleted(db, event);

    return {
      eventId: event.id,
      status: completed
        ? "completed"
        : "lease_lost",
    };

  } catch (error) {
    const failure = await markFailed(db, event, error);

    return {
      eventId: event.id,
      status: failure.updated
        ? failure.status
        : "lease_lost",
      error: error?.message || String(error),
    };
  }
}

// ------------------------------------------------------------
// Explicit batch entry point.
//
// Not automatically scheduled or started on import.
//
// Production uses pool + trusted lifecycle client.
// Tests may inject db and finalize.
// ------------------------------------------------------------

export async function runLiveRecoveryBatch(options={}) { return qaDrain.task('completion',()=>runRecoveryBatch(options)); }
async function runRecoveryBatch({
  batchSize = BATCH_SIZE,
  db = pool,
  finalize = finalizeLiveSession,
  eventId = null,
} = {}) {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 50
  ) {
    throw new Error("live_recovery_invalid_batch_size");
  }

  if (
    !db ||
    typeof db.connect !== "function" ||
    typeof db.query !== "function"
  ) {
    throw new Error("live_recovery_invalid_database");
  }

  if (typeof finalize !== "function") {
    throw new Error("live_recovery_invalid_finalizer");
  }

  if (
    eventId !== null &&
    (
      !/^[1-9][0-9]*$/.test(String(eventId)) ||
      !Number.isSafeInteger(Number(eventId))
    )
  ) {
    throw new Error("live_recovery_invalid_event_id");
  }

  const results = [];

  for (let index = 0; index < batchSize; index++) {
    const event = await claimNextEvent(db, eventId);

    if (!event) break;

    if (event.exhausted) {
      results.push({
        eventId: event.id,
        status: "manual_review",
        reason: "attempts_exhausted",
      });

      continue;
    }

    results.push(
      await processEvent(db, finalize, event)
    );
  }

  return {
    ok: true,
    claimed: results.length,
    results,
  };
}
