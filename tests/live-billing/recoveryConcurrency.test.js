import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "../../lib/db.js";
import { recordLiveLifecycleEvent } from "../../conversation/ingleLiveEventJournal.js";
import { runLiveRecoveryBatch } from "../../conversation/ingleLiveRecoveryWorker.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("GPT Live recovery: two independent workers finalize once", {
  timeout: 30000,
}, async () => {
  assert.notEqual(
    process.env.INGLE_LIVE_RECOVERY_ENABLED,
    "true",
    "Recovery scheduler must be disabled during concurrency QA"
  );

  const uid = crypto.randomUUID();
  const email = `recovery-concurrency-${uid}@example.invalid`;

  const fixture = {
    memberId: null,
    studentPk: null,
    frameId: null,
    grantUid: crypto.randomUUID(),
    eventId: null,
  };

  const sessionId = `sess_${uid.replaceAll("-", "")}`;
  const providerEventId = `evt_${uid.replaceAll("-", "")}`;

  const enteredFinalizer = deferred();
  const releaseFinalizer = deferred();

  let finalizationCalls = 0;
  let workerAPromise;

  try {
    // Committed synthetic fixtures, visible to separate connections.
    const member = await pool.query(
      `INSERT INTO public.ingle_members
         (school_id, email, provider, status, handle_tag)
       VALUES (9999, $1, 'email_otp', 'verified', 'ConcurrencyQA')
       RETURNING id`,
      [email]
    );
    fixture.memberId = member.rows[0].id;

    const student = await pool.query(
      `INSERT INTO public.students
         (school_id, email, full_name)
       VALUES (9999, $1, 'Recovery Concurrency QA')
       RETURNING id`,
      [email]
    );
    fixture.studentPk = student.rows[0].id;

    const frame = await pool.query(
      `INSERT INTO public.ingle_speak_frames
         (frame_uid, school_id, student_pk, member_id,
          frame_type, status, title)
       VALUES ($1::uuid, 9999, $2, $3,
               'experience', 'active', 'Recovery Concurrency QA')
       RETURNING id`,
      [crypto.randomUUID(), fixture.studentPk, fixture.memberId]
    );
    fixture.frameId = frame.rows[0].id;

    const tokenHash = crypto
      .createHash("sha256")
      .update(uid)
      .digest("hex");

    await pool.query(
      `INSERT INTO public.ingle_live_grants
         (grant_uid, token_hash, client_key,
          school_id, student_pk, member_id, frame_id,
          entitlement_type, reserved_minutes,
          created_at, expires_at, consumed_at,
          session_id, session_started_at, session_deadline_at)
       VALUES (
         $1::uuid, $2, 'ingle',
         9999, $3, $4, $5,
         'member_minutes', 5,
         NOW(), NOW() + INTERVAL '1 hour', NOW(),
         $6, NOW(), NOW() + INTERVAL '5 minutes'
       )`,
      [
        fixture.grantUid,
        tokenHash,
        fixture.studentPk,
        fixture.memberId,
        fixture.frameId,
        sessionId,
      ]
    );

    const journal = await recordLiveLifecycleEvent({
      grantUid: fixture.grantUid,
      sessionId,
      eventKey: `qa:concurrency:${uid}`,
      eventType: "session_closed",
      providerEventId,
      usageSeconds: 120,
      closeReason: "qa_confirmed",
      payload: { qa: true, usage_confirmed: true },
      initialStatus: "manual_review",
    });

    fixture.eventId = journal.eventId;

    // Make only our event eligible.
    const activated = await pool.query(
      `UPDATE public.ingle_live_lifecycle_events
       SET processing_status = 'pending',
           next_attempt_at = NOW()
       WHERE id = $1
         AND grant_uid = $2::uuid
         AND processing_status = 'manual_review'
       RETURNING id`,
      [fixture.eventId, fixture.grantUid]
    );

    assert.equal(activated.rowCount, 1);

    const finalize = async (payload) => {
      finalizationCalls++;

      assert.equal(payload.grantUid, fixture.grantUid);
      assert.equal(payload.sessionId, sessionId);
      assert.equal(payload.providerEventId, providerEventId);
      assert.equal(payload.usageSeconds, 120);

      enteredFinalizer.resolve();

      await releaseFinalizer.promise;

      return { ok: true };
    };

    // Worker A claims the event, commits its lease, then pauses.
    workerAPromise = runLiveRecoveryBatch({
      batchSize: 1,
      db: pool,
      finalize,
      eventId: fixture.eventId,
    });

    await Promise.race([
      enteredFinalizer.promise,
      workerAPromise.then(() => {
        throw new Error("worker_a_finished_before_finalizer");
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("worker_a_finalizer_timeout")),
          10000
        ).unref();
      }),
    ]);

    // Worker B uses its own PostgreSQL connection and must
    // not claim the event while Worker A's lease is active.
    const workerB = await runLiveRecoveryBatch({
      batchSize: 1,
      db: pool,
      finalize: async () => {
        throw new Error("worker_b_must_not_finalize");
      },
      eventId: fixture.eventId,
    });

    assert.equal(workerB.claimed, 0);
    assert.equal(finalizationCalls, 1);

    console.log("PASS: Worker B could not claim Worker A's lease.");

    releaseFinalizer.resolve();

    const workerA = await workerAPromise;
    workerAPromise = null;

    assert.equal(workerA.claimed, 1);
    assert.equal(workerA.results[0].status, "completed");

    const result = await pool.query(
      `SELECT processing_status, attempt_count,
              lease_token, processed_at
       FROM public.ingle_live_lifecycle_events
       WHERE id = $1`,
      [fixture.eventId]
    );

    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].processing_status, "completed");
    assert.equal(Number(result.rows[0].attempt_count), 1);
    assert.equal(result.rows[0].lease_token, null);
    assert.ok(result.rows[0].processed_at);
    assert.equal(finalizationCalls, 1);

    console.log("PASS: Event completed with exactly one finalization.");
  } finally {
    // Release a paused worker even if an assertion fails.
    releaseFinalizer.resolve();

    if (workerAPromise) {
      await workerAPromise.catch(() => {});
    }

    // Remove records in foreign-key dependency order.
    if (fixture.eventId !== null) {
      await pool.query(
        `DELETE FROM public.ingle_live_lifecycle_events
         WHERE id = $1 AND grant_uid = $2::uuid`,
        [fixture.eventId, fixture.grantUid]
      );
    }

    await pool.query(
      `DELETE FROM public.ingle_live_grants
       WHERE grant_uid = $1::uuid`,
      [fixture.grantUid]
    );

    if (fixture.frameId !== null) {
      await pool.query(
        `DELETE FROM public.ingle_speak_frames WHERE id = $1`,
        [fixture.frameId]
      );
    }

    if (fixture.studentPk !== null) {
      await pool.query(
        `DELETE FROM public.students WHERE id = $1`,
        [fixture.studentPk]
      );
    }

    if (fixture.memberId !== null) {
      await pool.query(
        `DELETE FROM public.ingle_members WHERE id = $1`,
        [fixture.memberId]
      );
    }

    console.log("PASS: Synthetic concurrency fixtures removed.");
  }
});
