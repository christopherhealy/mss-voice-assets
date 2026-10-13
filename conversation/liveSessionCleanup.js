// ============================================================
// conversation/liveSessionCleanup.js
//
// Best-effort termination of a GPT Live session when
// initialization fails after provider session creation.
//
// SECURITY:
// - Requests provider-side session.close.
// - Only session.closed confirms provider termination.
// - Socket closure is NOT proof of session termination.
// - Never invents final provider usage.
// - Never directly debits Member Minutes.
// - Returns the provider closure event for durable reporting.
//
// RELEASE LIMITATION:
// This helper cannot recover a session after process failure.
// ============================================================

import crypto from "node:crypto";
import { SidebandWS } from "openai/resources/live/sideband/ws";

const CLEANUP_TIMEOUT_MS = 10000;

function validUsageSeconds(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 86400
  );
}

function validProviderEventId(value) {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9_-]{1,200}$/.test(value)
  );
}

export async function cleanupFailedLiveSession({
  client,
  sessionId,
  grantUid,
  reason = "initialization_failed",
}) {
  if (!client || !sessionId) {
    return {
      confirmed: false,
      usageConfirmed: false,
      usageSeconds: null,
      providerEventId: null,
      reason: "cleanup_session_unavailable",
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let sideband = null;
    let timer = null;

    function finish(result) {
      if (settled) return;

      settled = true;

      if (timer) {
        clearTimeout(timer);
      }

      try {
        sideband?.close();
      } catch {
        // Closing sideband does not close the provider session.
      }

      resolve(result);
    }

    function unresolved(failureReason) {
      finish({
        confirmed: false,
        usageConfirmed: false,
        usageSeconds: null,
        providerEventId: null,
        reason: failureReason,
      });
    }

    try {
      sideband = new SidebandWS(
        client,
        {
          session_id: sessionId,
          graceful_close: true,
        },
        {
          reconnect: null,
        }
      );

      // ------------------------------------------------------
      // Confirmed provider closure.
      //
      // A valid zero-second usage value is authoritative.
      // Missing usage is NOT equivalent to zero usage.
      // ------------------------------------------------------

      sideband.on("session.closed", (event) => {
        const usageConfirmed = validUsageSeconds(
          event?.usage?.seconds
        );

        const providerEventId =
          validProviderEventId(event?.event_id)
            ? event.event_id
            : null;

        finish({
          confirmed: true,
          usageConfirmed,
          usageSeconds: usageConfirmed
            ? event.usage.seconds
            : null,
          providerEventId,
          reason: event?.reason || "provider_closed",
        });
      });

      sideband.on("error", () => {
        unresolved("cleanup_sideband_error");
      });

      sideband.on("close", () => {
        unresolved("cleanup_sideband_closed");
      });

      sideband.socket.on("open", () => {
        if (settled) return;

        try {
          sideband.send({
            type: "session.close",
            event_id: `cleanup_${crypto.randomUUID()}`,
          });

          console.warn("LIVE_SESSION_CLEANUP_REQUESTED", {
            grantUid,
            sessionId,
            reason,
          });

        } catch {
          unresolved("cleanup_close_send_failed");
        }
      });

      timer = setTimeout(() => {
        unresolved("cleanup_confirmation_timeout");
      }, CLEANUP_TIMEOUT_MS);

    } catch {
      unresolved("cleanup_connection_failed");
    }
  });
}
