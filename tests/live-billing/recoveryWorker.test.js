import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "../../lib/db.js";

import {
  recordLiveLifecycleEvent,
} from "../../conversation/ingleLiveEventJournal.js";

import {
  runLiveRecoveryBatch,
} from "../../conversation/ingleLiveRecoveryWorker.js";

// ============================================================
// GPT Live recovery worker PostgreSQL integration QA.
//
// - Real PostgreSQL constraints and row locking.
// - Synthetic Member, Student, Frame, and Grants.
// - All data inside one outer transaction.
// - Worker transactions mapped to SAVEPOINT operations.
// - Finalization API stubbed: no HTTP or Member Minutes debit.
// - Outer transaction ALWAYS rolled back.
// ============================================================

function createTransactionalWorkerDb(client) {
  let savepointActive = false;

  return {
    async connect() {
      return {
        async query(sql, params) {
          const command = String(sql).trim().toUpperCase();

          if (command === "BEGIN") {
            assert.equal(savepointActive, false);

            await client.query(
              "SAVEPOINT live_recovery_claim"
            );

            savepointActive = true;
            return;
          }

          if (command === "COMMIT") {
            assert.equal(savepointActive, true);

            await client.query(
              "RELEASE SAVEPOINT live_recovery_claim"
            );

            savepointActive = false;
            return;
          }

          if (command === "ROLLBACK") {
            assert.equal(savepointActive, true);

            await client.query(
              "ROLLBACK TO SAVEPOINT live_recovery_claim"
            );

            await client.query(
              "RELEASE SAVEPOINT live_recovery_claim"
            );

            savepointActive = false;
            return;
          }

          return client.query(sql, params);
        },

        release() {
          // The outer test owns the PostgreSQL connection.
        },
      };
    },

    query(sql, params) {
      return client.query(sql, params);
    },
  };
}

test(
  "GPT Live recovery worker: claims, retries, leases and manual review",
  async () => {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const uid = crypto.randomUUID();
      const email = `recovery-qa-${uid}@example.invalid`;

      const memberResult = await client.query(
        `
          INSERT INTO public.ingle_members (
            school_id, email, provider, status, handle_tag
          )
          VALUES (9999, $1, 'email_otp', 'verified', 'RecoveryQA')
          RETURNING id
        `,
        [email]
      );

      const memberId = memberResult.rows[0].id;

      const studentResult = await client.query(
        `
          INSERT INTO public.students (
            school_id, email, full_name
          )
          VALUES (9999, $1, 'Recovery Worker QA')
          RETURNING id
        `,
        [email]
      );

      const studentPk = studentResult.rows[0].id;

      const frameResult = await client.query(
        `
          INSERT INTO public.ingle_speak_frames (
            frame_uid, school_id, student_pk, member_id,
            frame_type, status, title
          )
          VALUES (
            $1::uuid, 9999, $2, $3,
            'experience', 'active', 'Recovery Worker QA'
          )
          RETURNING id
        `,
        [crypto.randomUUID(), studentPk, memberId]
      );

      const frameId = frameResult.rows[0].id;

      async function createEvent(initialStatus = "pending") {
        const grantUid = crypto.randomUUID();
        const sessionId =
          `sess_${crypto.randomUUID().replaceAll("-", "")}`;

        const providerEventId =
          `evt_${crypto.randomUUID().replaceAll("-", "")}`;

        const tokenHash = crypto
          .createHash("sha256")
          .update(crypto.randomUUID())
          .digest("hex");

        await client.query(
          `
            INSERT INTO public.ingle_live_grants (
              grant_uid, token_hash, client_key,
              school_id, student_pk, member_id, frame_id,
              entitlement_type, reserved_minutes,
              created_at, expires_at, consumed_at,
              session_id, session_started_at, session_deadline_at
            )
            VALUES (
              $1::uuid, $2, 'ingle',
              9999, $3, $4, $5,
              'member_minutes', 5,
              NOW(), NOW() + INTERVAL '1 hour', NOW(),
              $6, NOW(), NOW() + INTERVAL '5 minutes'
            )
          `,
          [
            grantUid,
            tokenHash,
            studentPk,
            memberId,
            frameId,
            sessionId,
          ]
        );

        const journal = await recordLiveLifecycleEvent(
          {
            grantUid,
            sessionId,
            eventKey: `qa:recovery:${grantUid}`,
            eventType: "session_closed",
            providerEventId,
            usageSeconds: 120,
            closeReason: "qa_confirmed",
            payload: {
              provider: "openai",
              usage_confirmed: true,
            },
            initialStatus,
          },
          client
        );

        return {
          id: journal.eventId,
          grantUid,
          sessionId,
          providerEventId,
        };
      }

      const db = createTransactionalWorkerDb(client);

      async function getEvent(id) {
        const result = await client.query(
          `
            SELECT
              processing_status,
              attempt_count,
              lease_token,
              lease_expires_at,
              next_attempt_at,
              last_error
            FROM public.ingle_live_lifecycle_events
            WHERE id = $1
          `,
          [id]
        );

        assert.equal(result.rowCount, 1);
        return result.rows[0];
      }

      // ------------------------------------------------------
      // 1. Pending confirmed closure: finalized exactly once.
      // ------------------------------------------------------

      const success = await createEvent();

      let successfulCalls = 0;

      const successBatch = await runLiveRecoveryBatch({
        batchSize: 1,
        db,
        finalize: async (payload) => {
          successfulCalls++;

          assert.equal(payload.grantUid, success.grantUid);
          assert.equal(payload.sessionId, success.sessionId);
          assert.equal(payload.providerEventId, success.providerEventId);
          assert.equal(payload.usageSeconds, 120);

          return { ok: true };
        },
      });

      assert.equal(successBatch.claimed, 1);
      assert.equal(successBatch.results[0].status, "completed");
      assert.equal(successfulCalls, 1);

      let row = await getEvent(success.id);

      assert.equal(row.processing_status, "completed");
      assert.equal(Number(row.attempt_count), 1);
      assert.equal(row.lease_token, null);

      const duplicateBatch = await runLiveRecoveryBatch({
        batchSize: 1,
        db,
        finalize: async () => {
          throw new Error("completed_event_reprocessed");
        },
      });

      assert.equal(duplicateBatch.claimed, 0);
      assert.equal(successfulCalls, 1);

      console.log(
        "PASS: Confirmed closure completed once; duplicate excluded."
      );

      // ------------------------------------------------------
      // 2. Failed finalization schedules retry.
      // ------------------------------------------------------

      const retry = await createEvent();

      const retryBatch = await runLiveRecoveryBatch({
        batchSize: 1,
        db,
        finalize: async () => {
          throw new Error("qa_transient_failure");
        },
      });

      assert.equal(retryBatch.claimed, 1);
      assert.equal(retryBatch.results[0].status, "retry_scheduled");

      row = await getEvent(retry.id);

      assert.equal(row.processing_status, "retry");
      assert.equal(Number(row.attempt_count), 1);
      assert.equal(row.lease_token, null);
      assert.ok(row.next_attempt_at);
      assert.match(row.last_error, /qa_transient_failure/);

      console.log("PASS: Failed finalization schedules retry.");

      // Keep this event out of subsequent batches.
      await client.query(
        `
          UPDATE public.ingle_live_lifecycle_events
          SET next_attempt_at = NOW() + INTERVAL '1 hour'
          WHERE id = $1
        `,
        [retry.id]
      );

      // ------------------------------------------------------
      // 3. Eighth failed attempt enters manual_review.
      // ------------------------------------------------------

      const eighth = await createEvent();

      await client.query(
        `
          UPDATE public.ingle_live_lifecycle_events
          SET attempt_count = 7
          WHERE id = $1
        `,
        [eighth.id]
      );

      const eighthBatch = await runLiveRecoveryBatch({
        batchSize: 1,
        db,
        finalize: async () => {
          throw new Error("qa_eighth_failure");
        },
      });

      assert.equal(eighthBatch.claimed, 1);
      assert.equal(eighthBatch.results[0].status, "manual_review");

      row = await getEvent(eighth.id);

      assert.equal(row.processing_status, "manual_review");
      assert.equal(Number(row.attempt_count), 8);
      assert.equal(row.lease_token, null);
      assert.equal(row.next_attempt_at, null);

      console.log("PASS: Eighth failure enters manual_review.");

      // ------------------------------------------------------
      // 4. Expired eighth-attempt lease is quarantined.
      // ------------------------------------------------------

      const exhausted = await createEvent();

      await client.query(
        `
          UPDATE public.ingle_live_lifecycle_events
          SET
            processing_status = 'processing',
            attempt_count = 8,
            lease_token = $2::uuid,
            lease_expires_at = NOW() - INTERVAL '1 minute',
            next_attempt_at = NULL
          WHERE id = $1
        `,
        [exhausted.id, crypto.randomUUID()]
      );

      let exhaustedCalls = 0;

      const exhaustedBatch = await runLiveRecoveryBatch({
        batchSize: 1,
        db,
        finalize: async () => {
          exhaustedCalls++;
          return { ok: true };
        },
      });

      assert.equal(exhaustedBatch.claimed, 1);
      assert.equal(exhaustedBatch.results[0].status, "manual_review");
      assert.equal(exhaustedCalls, 0);

      row = await getEvent(exhausted.id);

      assert.equal(row.processing_status, "manual_review");
      assert.equal(Number(row.attempt_count), 8);
      assert.equal(row.lease_token, null);
      assert.equal(row.lease_expires_at, null);

      console.log(
        "PASS: Expired exhausted lease quarantined without billing."
      );

      // ------------------------------------------------------
      // 5. Existing manual_review is never claimed.
      // ------------------------------------------------------

      const deferred = await createEvent("manual_review");

      let deferredCalls = 0;

      const deferredBatch = await runLiveRecoveryBatch({
        batchSize: 1,
        db,
        finalize: async () => {
          deferredCalls++;
          return { ok: true };
        },
      });

      assert.equal(deferredBatch.claimed, 0);
      assert.equal(deferredCalls, 0);

      row = await getEvent(deferred.id);

      assert.equal(row.processing_status, "manual_review");

      console.log("PASS: Existing manual_review remains excluded.");

      // ------------------------------------------------------
      // 6. Active lease is never claimed.
      // ------------------------------------------------------

      const active = await createEvent();

      const activeLease = crypto.randomUUID();

      await client.query(
        `
          UPDATE public.ingle_live_lifecycle_events
          SET
            processing_status = 'processing',
            attempt_count = 1,
            lease_token = $2::uuid,
            lease_expires_at = NOW() + INTERVAL '5 minutes',
            next_attempt_at = NULL
          WHERE id = $1
        `,
        [active.id, activeLease]
      );

      const activeBatch = await runLiveRecoveryBatch({
        batchSize: 1,
        db,
        finalize: async () => {
          throw new Error("active_lease_reprocessed");
        },
      });

      assert.equal(activeBatch.claimed, 0);

      row = await getEvent(active.id);

      assert.equal(row.processing_status, "processing");
      assert.equal(row.lease_token, activeLease);

      console.log("PASS: Active unexpired lease is protected.");

      // ------------------------------------------------------
      // 7. Invalid provider event is not finalized.
      // ------------------------------------------------------

      const invalid = await createEvent();

      await client.query(
        `
          UPDATE public.ingle_live_lifecycle_events
          SET provider_event_id = NULL
          WHERE id = $1
        `,
        [invalid.id]
      );

      let invalidCalls = 0;

      const invalidBatch = await runLiveRecoveryBatch({
        batchSize: 1,
        db,
        finalize: async () => {
          invalidCalls++;
          return { ok: true };
        },
      });

      assert.equal(invalidBatch.claimed, 1);
      assert.equal(invalidBatch.results[0].status, "retry_scheduled");
      assert.equal(invalidCalls, 0);

      row = await getEvent(invalid.id);

      assert.equal(row.processing_status, "retry");
      assert.match(row.last_error, /live_recovery_event_incomplete/);

      console.log("PASS: Incomplete provider event never finalized.");

      console.log(
        "PASS: Recovery worker PostgreSQL integration QA complete."
      );

    } finally {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }

      client.release();
    }
  }
);
