import "dotenv/config";

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { pool } from "../../lib/db.js";

import {
  recordLiveLifecycleEvent,
} from "../../conversation/ingleLiveEventJournal.js";

// ============================================================
// GPT Live lifecycle journal integration QA.
//
// Uses real PostgreSQL constraints and journal functions.
//
// All fixtures and journal events are created inside one
// transaction that is ALWAYS rolled back.
//
// No OpenAI calls.
// No Member Minutes debits.
// No permanent database changes.
// ============================================================

test(
  "GPT Live lifecycle journal: atomic states and idempotency",
  async () => {
    const db = await pool.connect();

    let transactionStarted = false;

    try {
      await db.query("BEGIN");
      transactionStarted = true;

      const uid = crypto.randomUUID();
      const email = `journal-qa-${uid}@example.invalid`;

      // ------------------------------------------------------
      // 1. Synthetic Member.
      // ------------------------------------------------------

      const memberResult = await db.query(
        `
          INSERT INTO public.ingle_members (
            school_id,
            email,
            provider,
            status,
            handle_tag
          )
          VALUES (
            9999,
            $1,
            'email_otp',
            'verified',
            'JournalQA'
          )
          RETURNING id
        `,
        [email]
      );

      const memberId = memberResult.rows[0].id;

      // ------------------------------------------------------
      // 2. Synthetic Student.
      //
      // students.member_id references the legacy members
      // table, not ingle_members.
      // ------------------------------------------------------

      const studentResult = await db.query(
        `
          INSERT INTO public.students (
            school_id,
            email,
            full_name
          )
          VALUES (
            9999,
            $1,
            'Lifecycle Journal QA'
          )
          RETURNING id
        `,
        [email]
      );

      const studentPk = studentResult.rows[0].id;

      // ------------------------------------------------------
      // 3. Synthetic Experience Frame.
      // ------------------------------------------------------

      const frameResult = await db.query(
        `
          INSERT INTO public.ingle_speak_frames (
            frame_uid,
            school_id,
            student_pk,
            member_id,
            frame_type,
            status,
            title
          )
          VALUES (
            $1::uuid,
            9999,
            $2,
            $3,
            'experience',
            'active',
            'Lifecycle Journal QA'
          )
          RETURNING id
        `,
        [
          crypto.randomUUID(),
          studentPk,
          memberId,
        ]
      );

      const frameId = frameResult.rows[0].id;

      // ------------------------------------------------------
      // 4. Helper: Create valid synthetic Live Grant.
      // ------------------------------------------------------

      async function createGrant() {
        const grantUid = crypto.randomUUID();

        const sessionId =
          `sess_${crypto.randomUUID().replaceAll("-", "")}`;

        const tokenHash = crypto
          .createHash("sha256")
          .update(crypto.randomUUID())
          .digest("hex");

        await db.query(
          `
            INSERT INTO public.ingle_live_grants (
              grant_uid,
              token_hash,
              client_key,
              school_id,
              student_pk,
              member_id,
              frame_id,
              entitlement_type,
              reserved_minutes,
              created_at,
              expires_at,
              consumed_at,
              session_id,
              session_started_at,
              session_deadline_at
            )
            VALUES (
              $1::uuid,
              $2,
              'ingle',
              9999,
              $3,
              $4,
              $5,
              'member_minutes',
              5,
              NOW(),
              NOW() + INTERVAL '1 hour',
              NOW(),
              $6,
              NOW(),
              NOW() + INTERVAL '5 minutes'
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

        return {
          grantUid,
          sessionId,
          providerEventId:
            `evt_${crypto.randomUUID().replaceAll("-", "")}`,
        };
      }

      // ------------------------------------------------------
      // 5. Acknowledged closure enters pending.
      // ------------------------------------------------------

      const acknowledged = await createGrant();

      const confirmedEvent = {
        ...acknowledged,
        eventKey:
          `qa:closed:${acknowledged.grantUid}`,
        eventType: "session_closed",
        usageSeconds: 120,
        closeReason: "qa_confirmed",
        payload: {
          provider: "openai",
          usage_confirmed: true,
        },
      };

      const pending = await recordLiveLifecycleEvent(
        {
          ...confirmedEvent,
          initialStatus: "pending",
        },
        db
      );

      assert.equal(pending.recorded, true);
      assert.equal(pending.duplicate, false);
      assert.equal(pending.initialStatus, "pending");

      console.log(
        "PASS: Acknowledged closure inserted as pending."
      );

      // ------------------------------------------------------
      // 6. Duplicate preserves event identity.
      // ------------------------------------------------------

      const duplicate = await recordLiveLifecycleEvent(
        confirmedEvent,
        db
      );

      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.eventId, pending.eventId);
      assert.equal(duplicate.initialStatus, "pending");

      console.log(
        "PASS: Duplicate closure preserves event ID."
      );

      // ------------------------------------------------------
      // 7. Conflicting usage is rejected.
      // ------------------------------------------------------

      await assert.rejects(
        () =>
          recordLiveLifecycleEvent(
            {
              ...confirmedEvent,
              usageSeconds: 180,
            },
            db
          ),
        /live_journal_event_conflict/
      );

      console.log(
        "PASS: Conflicting provider usage rejected."
      );

      // ------------------------------------------------------
      // 8. Deferred closure enters manual_review.
      // ------------------------------------------------------

      const unacknowledged = await createGrant();

      const deferredEvent = {
        ...unacknowledged,
        eventKey:
          `qa:closed:${unacknowledged.grantUid}`,
        eventType: "session_closed",
        usageSeconds: 60,
        closeReason: "qa_deferred",
        payload: {
          provider: "openai",
          usage_confirmed: true,
        },
        initialStatus: "manual_review",
      };

      const deferred = await recordLiveLifecycleEvent(
        deferredEvent,
        db
      );

      assert.equal(deferred.duplicate, false);
      assert.equal(
        deferred.initialStatus,
        "manual_review"
      );

      const storedDeferred = await db.query(
        `
          SELECT
            processing_status,
            next_attempt_at
          FROM public.ingle_live_lifecycle_events
          WHERE id = $1
        `,
        [deferred.eventId]
      );

      assert.equal(
        storedDeferred.rows[0].processing_status,
        "manual_review"
      );

      assert.equal(
        storedDeferred.rows[0].next_attempt_at,
        null
      );

      console.log(
        "PASS: Deferred closure inserted atomically as manual_review."
      );

      // ------------------------------------------------------
      // 9. Deferred closure excluded from automatic recovery.
      // ------------------------------------------------------

      const eligible = await db.query(
        `
          SELECT id
          FROM public.ingle_live_lifecycle_events
          WHERE id = $1
            AND event_type = 'session_closed'
            AND processing_status IN ('pending', 'retry')
            AND next_attempt_at <= NOW()
            AND lease_token IS NULL
        `,
        [deferred.eventId]
      );

      assert.equal(eligible.rowCount, 0);

      console.log(
        "PASS: Deferred closure excluded from recovery queue."
      );

      // ------------------------------------------------------
      // 10. Duplicate cannot reset manual_review.
      // ------------------------------------------------------

      const deferredDuplicate =
        await recordLiveLifecycleEvent(
          {
            ...deferredEvent,
            initialStatus: "pending",
          },
          db
        );

      assert.equal(deferredDuplicate.duplicate, true);
      assert.equal(
        deferredDuplicate.eventId,
        deferred.eventId
      );

      assert.equal(
        deferredDuplicate.initialStatus,
        "manual_review"
      );

      console.log(
        "PASS: Duplicate cannot reset manual_review."
      );

      // ------------------------------------------------------
      // 11. JSONB equality ignores object key ordering.
      // ------------------------------------------------------

      const jsonGrant = await createGrant();

      const jsonEvent = {
        ...jsonGrant,
        eventKey:
          `qa:jsonb:${jsonGrant.grantUid}`,
        eventType: "session_closed",
        usageSeconds: 30,
        closeReason: "qa_jsonb",
        payload: {
          alpha: 1,
          beta: {
            first: true,
            second: false,
          },
        },
      };

      const jsonOriginal =
        await recordLiveLifecycleEvent(
          jsonEvent,
          db
        );

      const jsonDuplicate =
        await recordLiveLifecycleEvent(
          {
            ...jsonEvent,
            payload: {
              beta: {
                second: false,
                first: true,
              },
              alpha: 1,
            },
          },
          db
        );

      assert.equal(jsonDuplicate.duplicate, true);
      assert.equal(
        jsonDuplicate.eventId,
        jsonOriginal.eventId
      );

      console.log(
        "PASS: Equivalent JSONB payload accepted."
      );

      // ------------------------------------------------------
      // 12. Exactly one journal row per event key.
      // ------------------------------------------------------

      const counts = await db.query(
        `
          SELECT
            event_key,
            COUNT(*)::integer AS event_count
          FROM public.ingle_live_lifecycle_events
          WHERE event_key = ANY($1::text[])
          GROUP BY event_key
        `,
        [[
          confirmedEvent.eventKey,
          deferredEvent.eventKey,
          jsonEvent.eventKey,
        ]]
      );

      assert.equal(counts.rowCount, 3);

      for (const row of counts.rows) {
        assert.equal(row.event_count, 1);
      }

      console.log(
        "PASS: Exactly one row per event key."
      );

    } finally {
      if (transactionStarted) {
        await db.query("ROLLBACK");
      }

      db.release();
    }
  }
);
