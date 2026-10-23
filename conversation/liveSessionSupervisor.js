import {qaDrain} from '../lib/qa-drain.js';
// ============================================================
// conversation/liveSessionSupervisor.js
//
// Voice Assets — GPT Live Session Supervisor
//
// Responsibilities:
// - Attach a trusted OpenAI sideband connection.
// - Supervise the authorized session deadline.
// - Attempt reconnection when supervision is interrupted.
// - Request provider-side session termination.
// - Capture cumulative provider usage.
// - Distinguish confirmed closure from unresolved termination.
//
// SECURITY:
// - sideband.close() does NOT terminate a GPT Live session.
// - Only session.closed confirms provider finalization.
// - Unconfirmed sessions must retain their reservation.
// - A process restart destroys in-memory timers.
// - This module does NOT write to Ingle's Minutes ledger.
//
// INTEGRATION STATUS:
// Standalone module. Not yet connected to Live session creation.
// ============================================================

import crypto from "node:crypto";

import {
  SidebandWS,
} from "openai/resources/live/sideband/ws";

// ============================================================
// Configuration
// ============================================================

const MAX_SESSION_MS = 10 * 60 * 1000;

const CONNECTION_TIMEOUT_MS = 8000;

const FINALIZATION_TIMEOUT_MS = 15000;

const RECONNECT_MAX_RETRIES = 5;

// ============================================================
// Helpers
// ============================================================

function validUsageSeconds(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const seconds = Number(value);

  return Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : null;
}

// ============================================================
// Supervise an authorized GPT Live session.
//
// The initial connection must succeed before this function
// resolves.
//
// Subsequent lifecycle events are delivered through callbacks.
//
// IMPORTANT:
// Callback delivery is not durable. Ingle lifecycle persistence
// and restart recovery must be implemented before activation.
// ============================================================

export async function superviseLiveSession({
  client,
  sessionId,
  grantUid,
  sessionDeadlineAt,

  onUsage = async () => {},
  onClosed = async () => {},
  onUnconfirmed = async () => {},
}) {
  // ----------------------------------------------------------
  // 1. Validate authorization context.
  // ----------------------------------------------------------

  if (!client) {
    throw new Error("live_supervisor_client_required");
  }

  if (
    typeof sessionId !== "string" ||
    !sessionId.trim()
  ) {
    throw new Error(
      "live_supervisor_session_id_required"
    );
  }

  if (
    typeof grantUid !== "string" ||
    !grantUid.trim()
  ) {
    throw new Error(
      "live_supervisor_grant_uid_required"
    );
  }

  const deadline = Date.parse(sessionDeadlineAt);

  if (
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    deadline - Date.now() > MAX_SESSION_MS
  ) {
    throw new Error(
      "live_supervisor_deadline_invalid"
    );
  }

  // ----------------------------------------------------------
  // 2. Establish trusted sideband connection.
  //
  // The SDK handles reconnection attempts.
  // ----------------------------------------------------------

  const sideband = new SidebandWS(
    client,
    {
      session_id: sessionId,
      graceful_close: true,
    },
    {
      reconnect: {
        maxRetries: RECONNECT_MAX_RETRIES,
        initialDelay: 500,
        maxDelay: 3000,
      },
    }
  );

  // ----------------------------------------------------------
  // 3. Session lifecycle state.
  // ----------------------------------------------------------

  let connected = false;
  let initialConnectionSettled = false;

  let finalized = false;
  let unresolvedReported = false;

  let closeRequested = false;

  let cumulativeSeconds = 0;

  let connectionTimer = null;
  let deadlineTimer = null;
  let finalizationTimer = null;

  let resolveInitialConnection;
  let rejectInitialConnection;

  const finishDrainSupervisor=qaDrain.track('supervisors');
  const initialConnection = new Promise(
    (resolve, reject) => {
      resolveInitialConnection = resolve;
      rejectInitialConnection = reject;
    }
  );

  function resolveInitialization() {
    if (initialConnectionSettled) return;

    initialConnectionSettled = true;

    clearTimeout(connectionTimer);

    resolveInitialConnection();
  }

  function rejectInitialization(error) {
    if (initialConnectionSettled) return;

    initialConnectionSettled = true;

    clearTimeout(connectionTimer);

    rejectInitialConnection(error);
  }

  function clearAllTimers() {
    clearTimeout(connectionTimer);
    clearTimeout(deadlineTimer);
    clearTimeout(finalizationTimer);
  }

  // ----------------------------------------------------------
  // 4. Report unresolved termination.
  //
  // This is NOT confirmation that OpenAI stopped billing.
  //
  // The reservation must remain outstanding.
  // ----------------------------------------------------------

  function reportUnconfirmed(reason) {
    if (finalized || unresolvedReported) {
      return;
    }

    unresolvedReported = true;

    console.error(
      "LIVE_SESSION_TERMINATION_UNCONFIRMED",
      {
        grantUid,
        sessionId,
        reason,
        lastKnownUsageSeconds: cumulativeSeconds,
      }
    );

    Promise.resolve()
      .then(() =>
        onUnconfirmed({
          grantUid,
          sessionId,
          reason,
          lastKnownUsageSeconds:
            cumulativeSeconds,
        })
      )
      .catch((error) => {
        console.error(
          "LIVE_UNCONFIRMED_REPORT_FAILED",
          {
            grantUid,
            sessionId,
            message: error?.message,
          }
        );
      });
  }

  // ----------------------------------------------------------
  // 5. Request provider-side termination.
  //
  // Do not mark the session finalized here.
  // ----------------------------------------------------------

  function requestClose(reason = "authorized_deadline") {
    if (finalized) {
      return;
    }

    if (!connected) {
      reportUnconfirmed(
        "close_required_while_disconnected"
      );

      return;
    }

    // Avoid repeated sends on the same connection.
    if (closeRequested) {
      return;
    }

    try {
      sideband.send({
        type: "session.close",
        event_id:
          `close_${crypto.randomUUID()}`,
      });

      closeRequested = true;

      console.log(
        "LIVE_SESSION_CLOSE_REQUESTED",
        {
          grantUid,
          sessionId,
          reason,
        }
      );

      if (!finalizationTimer) {
        finalizationTimer = setTimeout(() => {
          if (!finalized) {
            reportUnconfirmed(
              "session_close_unconfirmed"
            );
          }
        }, FINALIZATION_TIMEOUT_MS);
      }

    } catch (error) {
      reportUnconfirmed(
        "session_close_send_failed"
      );
    }
  }

  // ----------------------------------------------------------
  // 6. Deadline enforcement.
  //
  // The timer starts immediately, rather than waiting
  // for the initial sideband connection.
  //
  // This is a best-effort safeguard, not a provider-side
  // hard duration guarantee.
  // ----------------------------------------------------------

  deadlineTimer = setTimeout(() => {
    requestClose("authorized_deadline");
  }, Math.max(0, deadline - Date.now()));

  // ----------------------------------------------------------
  // 7. Connection established.
  // ----------------------------------------------------------

  function handleConnected() {
    if (finalized) return;

    connected = true;

    // A prior close attempt may not have reached OpenAI.
    // Permit another attempt on the new connection.
    closeRequested = false;

    resolveInitialization();

    console.log(
      "LIVE_SUPERVISOR_CONNECTED",
      {
        grantUid,
        sessionId,
      }
    );

    // If reconnection occurred after the deadline,
    // immediately request termination.
    if (Date.now() >= deadline) {
      requestClose("deadline_after_reconnect");
    }
  }

  sideband.socket.on(
    "open",
    handleConnected
  );

  sideband.on("reconnected", () => {
    handleConnected();
  });

  sideband.on("reconnecting", () => {
    connected = false;

    console.warn(
      "LIVE_SUPERVISOR_RECONNECTING",
      {
        grantUid,
        sessionId,
      }
    );
  });

  // ----------------------------------------------------------
  // 8. Provider cumulative usage.
  //
  // Usage updates are snapshots, not increments.
  // ----------------------------------------------------------

  sideband.on(
    "session.usage.updated",
    (event) => {
      if (finalized) return;

      const seconds = validUsageSeconds(
        event?.usage?.seconds
      );

      if (seconds === null) {
        return;
      }

      cumulativeSeconds = Math.max(
        cumulativeSeconds,
        seconds
      );

      Promise.resolve()
        .then(() =>
          onUsage({
            grantUid,
            sessionId,
            cumulativeSeconds,
          })
        )
        .catch((error) => {
          console.error(
            "LIVE_USAGE_REPORT_FAILED",
            {
              grantUid,
              sessionId,
              message: error?.message,
            }
          );
        });
    }
  );

  // ----------------------------------------------------------
  // 9. Confirmed provider session termination.
  //
  // Only this event confirms finalization.
  // ----------------------------------------------------------

  sideband.on(
    "session.closed",
    (event) => {
      if (finalized) return;

      finalized = true;
      connected = false;

      clearAllTimers();

      const finalSeconds =
        validUsageSeconds(
          event?.usage?.seconds
        );

      if (finalSeconds !== null) {
        cumulativeSeconds = finalSeconds;
      }

      console.log(
        "LIVE_SESSION_CLOSED_CONFIRMED",
        {
          grantUid,
          sessionId,
          reason: event.reason,
          usageSeconds: cumulativeSeconds,
          usageConfirmed:
            finalSeconds !== null,
        }
      );

      Promise.resolve()
        .then(() =>
          onClosed({
            grantUid,
            sessionId,
            reason: event.reason,
            usageSeconds:
              cumulativeSeconds,
            usageConfirmed:
              finalSeconds !== null,
            providerEventId:
              event.event_id,
          })
        )
        .catch((error) => {
          console.error(
            "LIVE_CLOSED_REPORT_FAILED",
            {
              grantUid,
              sessionId,
              message: error?.message,
            }
          );
        })
        .finally(() => {
          sideband.close();
          finishDrainSupervisor();
        });
    }
  );

  // ----------------------------------------------------------
  // 10. Connection errors.
  //
  // A connection failure does not prove the primary
  // WebRTC session has ended.
  // ----------------------------------------------------------

  sideband.on("error", (error) => {
    connected = false;

    console.error(
      "LIVE_SUPERVISOR_ERROR",
      {
        grantUid,
        sessionId,
        message: error?.message,
      }
    );

    if (!initialConnectionSettled) {
      rejectInitialization(error);

      reportUnconfirmed(
        "initial_sideband_connection_failed"
      );

      return;
    }

    if (!finalized) {
      reportUnconfirmed(
        "sideband_connection_error"
      );
    }
  });

  // ----------------------------------------------------------
  // 11. Permanent sideband closure.
  //
  // This is NOT session.closed.
  // ----------------------------------------------------------

  sideband.on("close", () => {
    connected = false;

    if (finalized) {
      return;
    }

    if (!initialConnectionSettled) {
      rejectInitialization(
        new Error(
          "live_sideband_closed_before_ready"
        )
      );
    }

    reportUnconfirmed(
      "sideband_closed_without_finalization"
    );
  });

  // ----------------------------------------------------------
  // 12. Initial connection timeout.
  //
  // An unsuccessful initial connection must prevent the
  // caller from returning an apparently supervised SDP.
  // ----------------------------------------------------------

  connectionTimer = setTimeout(() => {
    if (initialConnectionSettled) {
      return;
    }

    rejectInitialization(
      new Error(
        "live_sideband_connection_timeout"
      )
    );

    reportUnconfirmed(
      "sideband_initial_connection_timeout"
    );

    // Closing this WebSocket is not equivalent to closing
    // the provider session. The session remains unresolved.
    sideband.close();

  }, CONNECTION_TIMEOUT_MS);

  // ----------------------------------------------------------
  // 13. Require initial sideband readiness.
  // ----------------------------------------------------------

  await initialConnection;

  // ----------------------------------------------------------
  // 14. Return the supervisor control interface.
  // ----------------------------------------------------------

  return {
    grantUid,
    sessionId,
    sessionDeadlineAt,

    requestClose,

    getUsageSeconds: () =>
      cumulativeSeconds,

    isFinalized: () =>
      finalized,

    isConnected: () =>
      connected,
  };
}
