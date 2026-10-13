// ============================================================
// routes/conversation.routes.js
//
// Ingle Conversation — Voice Assets service boundary
//
// Ingle owns:
// - Member authentication
// - Experience authorization
// - Minutes reservations
// - Single-use Live grants
// - Authoritative Minutes accounting
//
// Voice Assets owns:
// - Conversation context
// - GPT Live session creation
// - WebRTC transport
// - Trusted sideband supervision
// - Provider session lifecycle reporting
//
// SECURITY:
// No OpenAI Live session may be created without successful
// Ingle grant redemption and Experience context verification.
//
// No SDP answer may be returned unless:
// - Ingle acknowledges the provider session.
// - Trusted sideband supervision is established.
//
// IMPORTANT:
// Durable recovery and provider termination guarantees remain
// release requirements. Do not deploy this implementation yet.
// ============================================================

import express from "express";
import OpenAI from "openai";

import {
  loadExperienceContext,
} from "../conversation/experienceContext.js";

import {
  buildConversationContext,
} from "../conversation/conversationContext.js";

import {
  acknowledgeLiveSession,
} from "../conversation/ingleLiveLifecycleClient.js";

import {
  superviseLiveSession,
} from "../conversation/liveSessionSupervisor.js";

import {
  reportLiveSessionClosed,
  reportLiveSessionUnconfirmed,
} from "../conversation/ingleLiveSessionCallbacks.js";

import {
  cleanupFailedLiveSession,
} from "../conversation/liveSessionCleanup.js";

const router = express.Router();

// ============================================================
// Configuration
// ============================================================

const LIVE_REDEMPTION_TIMEOUT_MS = 8000;

const LIVE_VOICES = new Set([
  "marin",
  "gleam",
  "meridian",
  "vesper",
  "quartz",
  "ripple",
  "willow",
  "stone",
]);

const DEFAULT_LIVE_VOICE = "marin";

const LIVE_LANGUAGES = new Map([
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["it", "Italian"],
  ["ko", "Korean"],
]);

// ============================================================
// OpenAI client
// ============================================================

function getOpenAIClient() {
  const apiKey = String(
    process.env.OPENAI_API_KEY || ""
  ).trim();

  if (!apiKey) {
    throw new Error("missing_openai_api_key");
  }

  return new OpenAI({ apiKey });
}

// ============================================================
// Extract browser authorization grant
//
// The browser receives a short-lived grant from Ingle.
// Voice Assets requires that grant before creating GPT Live.
//
// Never log the raw token.
// ============================================================

function getLiveGrantFromRequest(req) {
  const authorization = String(
    req.headers.authorization || ""
  );

  const match = /^Bearer ([a-f0-9]{64})$/i.exec(
    authorization
  );

  return match ? match[1] : null;
}

// ============================================================
// Redeem Live grant through Ingle
//
// Uses private Voice Assets service authentication.
//
// The browser never receives IN​GLE_VOICE_SERVICE_SECRET.
// ============================================================

async function redeemIngleLiveGrant(grantToken) {
  const redemptionUrl = String(
    process.env.INGLE_LIVE_REDEMPTION_URL || ""
  ).trim();

  const serviceSecret = String(
    process.env.INGLE_VOICE_SERVICE_SECRET || ""
  ).trim();

  if (!redemptionUrl || !serviceSecret) {
    const error = new Error(
      "live_authorization_not_configured"
    );

    error.status = 503;
    throw error;
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    LIVE_REDEMPTION_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      redemptionUrl,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${serviceSecret}`,

          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          grant_token: grantToken,
        }),

        signal: controller.signal,
        redirect: "error",
      }
    );

    if (!response.ok) {
      const error = new Error(
        "live_grant_redemption_rejected"
      );

      error.status = 403;
      throw error;
    }

    const result = await response.json();

    if (!result?.ok || !result?.grant) {
      const error = new Error(
        "live_grant_redemption_invalid_response"
      );

      error.status = 502;
      throw error;
    }

    return result.grant;

  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// Validate authorized Experience context
//
// The requested Experience and level must match Ingle's
// authoritative authorization grant.
// ============================================================

function validateAuthorizedContext({
  grant,
  experienceKey,
  levelNo,
}) {
  const authorizedExperienceKey = String(
    grant?.experienceKey || ""
  ).trim();

  const authorizedLevelNo = Number(
    grant?.levelNo
  );

  const authorizedMinutes = Number(
    grant?.authorizedMinutes
  );

  const deadline = Date.parse(
    grant?.sessionDeadlineAt || ""
  );

  if (
    !authorizedExperienceKey ||

    !Number.isSafeInteger(
      authorizedLevelNo
    ) ||

    authorizedLevelNo <= 0 ||

    !Number.isFinite(
      authorizedMinutes
    ) ||

    authorizedMinutes <= 0 ||
    authorizedMinutes > 10 ||

    !Number.isFinite(deadline) ||
    deadline <= Date.now()
  ) {
    return false;
  }

  return (
    authorizedExperienceKey === experienceKey &&
    authorizedLevelNo === levelNo
  );
}

// ============================================================
// Health
// ============================================================

router.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: "mss-voiceAssets",
    module: "conversation",
    mode: "experimental",
    time: new Date().toISOString(),
  });
});

// ============================================================
// Read-only Experience context
//
// Preserves normal current-version lookup.
// ============================================================

router.get("/context", async (req, res) => {
  try {
    const experienceKey = String(
      req.query.experience ||
      "visit_veterinarian"
    ).trim();

    const levelNo = Number(
      req.query.level || 1
    );

    const ctx = await loadExperienceContext({
      experienceKey,
      levelNo,
    });

    return res.json({
      ok: true,

      source: ctx.source,

      experience: {
        key: ctx.experience.key,
        title: ctx.experience.title,
        can_do_statement:
          ctx.experience.canDoStatement,
      },

      level: {
        number: ctx.level.number,
        title: ctx.level.title,
      },

      host: {
        key: ctx.host.key,
        name: ctx.host.name,
        role: ctx.host.roleName,
      },

      objective_count:
        ctx.objectives.length,

      objectives:
        ctx.objectives.map((o) => ({
          gate_no: o.number,
          gate_key: o.key,
          title: o.title,
          can_do_statement:
            o.canDoStatement,
        })),
    });

  } catch (err) {
    return res
      .status(err?.status || 500)
      .json({
        ok: false,
        error:
          err?.message ||
          "context_load_failed",
      });
  }
});

// ============================================================
// GPT Live WebRTC session
//
// Browser supplies:
// - SDP offer
// - Single-use Ingle Live grant
// - Experience key
// - Level number
// - Voice and conversation language
//
// SECURITY:
// Grant redemption occurs before OpenAI session creation.
//
// Provider session acknowledgement and sideband supervision
// must succeed before SDP is returned.
// ============================================================

router.post(
  "/live/session",

  express.text({
    type: "application/sdp",
    limit: "256kb",
  }),

  async (req, res) => {

    // ========================================================
    // Provider session tracking
    //
    // CRITICAL:
    // These variables belong OUTSIDE the try block.
    //
    // The catch handler needs them if OpenAI creates a
    // session but a subsequent initialization step fails.
    // ========================================================

    let createdSessionId = null;

    let createdSessionClient = null;

    let createdGrantUid = null;

    let sessionAcknowledged = false;

    let sessionSupervisor = null;

    try {

      // ------------------------------------------------------
      // 1. Require browser Live grant.
      // ------------------------------------------------------

      const grantToken =
        getLiveGrantFromRequest(req);

      if (!grantToken) {
        return res.status(401).json({
          ok: false,
          error: "live_grant_required",
        });
      }

      // ------------------------------------------------------
      // 2. Validate SDP offer.
      // ------------------------------------------------------

      const sdp = req.body;

      if (
        typeof sdp !== "string" ||
        !sdp.trim()
      ) {
        return res.status(400).json({
          ok: false,
          error: "missing_sdp_offer",
        });
      }

      // ------------------------------------------------------
      // 3. Validate voice.
      // ------------------------------------------------------

      const requestedVoice = String(
        req.query.voice ||
        DEFAULT_LIVE_VOICE
      ).trim();

      if (!LIVE_VOICES.has(requestedVoice)) {
        return res.status(400).json({
          ok: false,
          error: "unsupported_live_voice",
        });
      }

      // ------------------------------------------------------
      // 4. Validate requested Experience.
      // ------------------------------------------------------

      const experienceKey = String(
        req.query.experience || ""
      ).trim();

      const levelNo = Number(
        req.query.level
      );

      if (
        !experienceKey ||
        !Number.isSafeInteger(levelNo) ||
        levelNo <= 0
      ) {
        return res.status(400).json({
          ok: false,
          error: "invalid_experience_context",
        });
      }

      // ------------------------------------------------------
      // 5. Validate conversation language.
      // ------------------------------------------------------

      const conversationLanguage = String(
        req.query.language || "en"
      )
        .trim()
        .toLowerCase();

      if (
        !LIVE_LANGUAGES.has(
          conversationLanguage
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "unsupported_conversation_language",
        });
      }

      // ------------------------------------------------------
      // 6. Redeem authorization grant.
      //
      // Ingle performs single-use redemption.
      //
      // No OpenAI session exists at this point.
      // ------------------------------------------------------

      const grant =
        await redeemIngleLiveGrant(
          grantToken
        );

      // ------------------------------------------------------
      // 7. Validate authorized Experience.
      // ------------------------------------------------------

      if (
        !validateAuthorizedContext({
          grant,
          experienceKey,
          levelNo,
        })
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "live_experience_context_mismatch",
        });
      }

      // ------------------------------------------------------
      // 8. Require precise authorized version.
      // ------------------------------------------------------

      const authorizedVersionId = Number(
        grant.experienceVersionId
      );

      const authorizedLevelId = Number(
        grant.experienceLevelId
      );

      if (
        !Number.isSafeInteger(
          authorizedVersionId
        ) ||

        authorizedVersionId <= 0 ||

        !Number.isSafeInteger(
          authorizedLevelId
        ) ||

        authorizedLevelId <= 0
      ) {
        return res.status(403).json({
          ok: false,
          error:
            "live_authorized_version_missing",
        });
      }

      // ------------------------------------------------------
      // 9. Load exact authorized Experience definition.
      //
      // Never substitute the current version.
      // ------------------------------------------------------

      const experienceContext =
        await loadExperienceContext({
          experienceKey:
            grant.experienceKey,

          levelNo:
            grant.levelNo,

          experienceVersionId:
            authorizedVersionId,

          experienceLevelId:
            authorizedLevelId,
        });

      const authoredInstructions =
        buildConversationContext(
          experienceContext
        );

      const languageName =
        LIVE_LANGUAGES.get(
          conversationLanguage
        );

      const instructions =
        `CURRENT CONVERSATIONAL LANGUAGE: ${languageName} (${conversationLanguage}).\n\n` +
        authoredInstructions;

      console.log(
        "CONVERSATION_CONTEXT_LOADED",
        {
          source:
            experienceContext.source,

          experienceKey:
            experienceContext.experience.key,

          experienceTitle:
            experienceContext.experience.title,

          experienceVersionId:
            authorizedVersionId,

          experienceLevelId:
            authorizedLevelId,

          levelNo:
            experienceContext.level.number,

          host:
            experienceContext.host.name,

          conversationLanguage,

          objectiveCount:
            experienceContext.objectives.length,
        }
      );

      // ------------------------------------------------------
      // 10. Create authorized GPT Live session.
      //
      // This is the billable provider operation.
      // ------------------------------------------------------

      const client =
        getOpenAIClient();

      const live =
        await client.live.create(
          {
            session: {
              model: "gpt-live-1",

              audio: {
                output: {
                  voice:
                    requestedVoice,
                },
              },

              instructions,
            },

            transport: {
              type: "webrtc",
              sdp,
            },
          },

          {
            maxRetries: 0,
          }
        );

      // ------------------------------------------------------
      // 11. Capture provider session identity.
      //
      // These values must be available to catch().
      // ------------------------------------------------------

      const sessionId = String(
        live?.session?.id || ""
      ).trim();

      createdSessionId =
        sessionId || null;

      createdSessionClient =
        client;

      createdGrantUid =
        grant.grantUid;

      if (!sessionId) {
        throw new Error(
          "live_provider_session_id_missing"
        );
      }

      // ------------------------------------------------------
      // 12. Acknowledge session creation in Ingle.
      //
      // Do not return SDP until acknowledged.
      // ------------------------------------------------------

      const acknowledgement =
        await acknowledgeLiveSession({
          grantUid:
            grant.grantUid,

          sessionId,
        });

      if (!acknowledgement?.ok) {
        throw new Error(
          "live_session_acknowledgement_failed"
        );
      }

      sessionAcknowledged = true;

      // ------------------------------------------------------
      // 13. Attach trusted sideband supervisor.
      //
      // Initial connection must succeed.
      // ------------------------------------------------------

      sessionSupervisor =
        await superviseLiveSession({
          client,

          sessionId,

          grantUid:
            grant.grantUid,

          sessionDeadlineAt:
            grant.sessionDeadlineAt,

          onClosed:
            reportLiveSessionClosed,

          onUnconfirmed:
            reportLiveSessionUnconfirmed,
        });

      if (
        !sessionSupervisor?.isConnected()
      ) {
        throw new Error(
          "live_supervisor_not_connected"
        );
      }

      // ------------------------------------------------------
      // 14. Session is acknowledged and supervised.
      // ------------------------------------------------------

      console.log(
        "CONVERSATION_LIVE_SESSION_SUPERVISED",
        {
          sessionId,

          grantUid:
            grant.grantUid,

          model:
            "gpt-live-1",

          voice:
            requestedVoice,

          conversationLanguage,

          sessionDeadlineAt:
            grant.sessionDeadlineAt,
        }
      );

      // ------------------------------------------------------
      // 15. Return SDP answer.
      //
      // Only reached after acknowledgement and supervision.
      // ------------------------------------------------------

      return res
        .status(201)
        .type("application/sdp")
        .send(live.transport.sdp);

    } catch (err) {

      // ======================================================
      // 16. Failure-safe cleanup
      //
      // If OpenAI created a session before an error occurred,
      // attempt provider-side termination.
      //
      // IMPORTANT:
      // A cleanup attempt is not proof of termination.
      // ======================================================

      if (
        createdSessionId &&
        createdSessionClient
      ) {

        console.error(
          "LIVE_SESSION_INITIALIZATION_FAILED",
          {
            sessionId:
              createdSessionId,

            grantUid:
              createdGrantUid,

            sessionAcknowledged,

            supervisorConnected:
              Boolean(
                sessionSupervisor?.isConnected()
              ),
          }
        );

        // ----------------------------------------------------
        // If the supervisor was successfully initialized,
        // use its existing trusted connection.
        //
        // Otherwise establish a temporary cleanup sideband.
        // ----------------------------------------------------

        if (sessionSupervisor) {

          try {
            sessionSupervisor.requestClose(
              "initialization_failed"
            );

          } catch (cleanupError) {

            console.error(
              "LIVE_SUPERVISOR_CLEANUP_FAILED",
              {
                sessionId:
                  createdSessionId,

                message:
                  cleanupError?.message,
              }
            );

            await reportLiveSessionUnconfirmed({
              grantUid:
                createdGrantUid,

              sessionId:
                createdSessionId,

              reason:
                "supervisor_cleanup_failed",
            });
          }

        } else {

          try {

            const cleanup =
              await cleanupFailedLiveSession({
                client:
                  createdSessionClient,

                sessionId:
                  createdSessionId,

                grantUid:
                  createdGrantUid,

                reason:
                  "live_session_initialization_failed",
              });

            console.error(
              "LIVE_SESSION_INITIALIZATION_CLEANUP",
              {
                sessionId:
                  createdSessionId,

                grantUid:
                  createdGrantUid,

                confirmed:
                  cleanup.confirmed,

                reason:
                  cleanup.reason,
              }
            );

            // ------------------------------------------------
            // 16A. Process provider cleanup result.
            //
            // Confirmed closure with valid final usage:
            // - Persist provider evidence in PostgreSQL.
            // - Finalize immediately only if Ingle has
            //   acknowledged the provider session.
            //
            // Unconfirmed closure or incomplete provider data:
            // - Preserve unresolved evidence.
            // - Never invent usage or debit Member Minutes.
            // ------------------------------------------------

            const confirmedClosureUsable =
              cleanup.confirmed === true &&
              cleanup.usageConfirmed === true &&
              typeof cleanup.providerEventId === "string" &&
              cleanup.providerEventId.length > 0;

            if (confirmedClosureUsable) {

              await reportLiveSessionClosed(
                {
                  grantUid: createdGrantUid,
                  sessionId: createdSessionId,

                  reason: cleanup.reason,

                  usageSeconds:
                    cleanup.usageSeconds,

                  usageConfirmed: true,

                  providerEventId:
                    cleanup.providerEventId,
                },
                {
                  finalizeImmediately:
                    sessionAcknowledged,
                }
              );

              console.log(
                "LIVE_SESSION_CLEANUP_CLOSURE_RECORDED",
                {
                  grantUid: createdGrantUid,
                  sessionId: createdSessionId,
                  sessionAcknowledged,
                  usageSeconds:
                    cleanup.usageSeconds,
                }
              );

            } else {

              await reportLiveSessionUnconfirmed({
                grantUid: createdGrantUid,
                sessionId: createdSessionId,

                reason:
                  cleanup.confirmed
                    ? "cleanup_confirmed_missing_final_usage_or_event_id"
                    : cleanup.reason,

                lastKnownUsageSeconds:
                  cleanup.usageSeconds ?? null,
              });
            }

          } catch (cleanupError) {

            // ------------------------------------------------
            // Cleanup or reporting failure.
            //
            // A confirmed closure may already be persisted.
            // Do not attempt a second finalization here.
            // ------------------------------------------------

            console.error(
              "LIVE_SESSION_CLEANUP_ERROR",
              {
                sessionId:
                  createdSessionId,

                grantUid:
                  createdGrantUid,

                message:
                  cleanupError?.message ||
                  String(cleanupError),
              }
            );

            try {

              await reportLiveSessionUnconfirmed({
                grantUid:
                  createdGrantUid,

                sessionId:
                  createdSessionId,

                reason:
                  "cleanup_or_reporting_exception",
              });

            } catch (reportError) {

              console.error(
                "LIVE_UNCONFIRMED_REPORT_ERROR",
                {
                  sessionId:
                    createdSessionId,

                  grantUid:
                    createdGrantUid,

                  message:
                    reportError?.message ||
                    String(reportError),
                }
              );
            }
          }
        }
      }

      // ======================================================
      // 17. Return sanitized error to browser.
      //
      // Never expose service secrets, grant tokens,
      // or provider credentials.
      // ======================================================

      console.error(
        "POST /api/conversation/live/session failed:",
        {
          name:
            err?.name || null,

          status:
            err?.status || null,

          message:
            err?.message || String(err),
        }
      );

      const status =
        Number.isInteger(err?.status) &&
        err.status >= 400 &&
        err.status <= 599
          ? err.status
          : 502;

      return res.status(status).json({
        ok: false,

        error:
          status === 403
            ? "live_authorization_failed"
            : status === 503
              ? "live_authorization_unavailable"
              : "live_session_creation_failed",
      });

    }
  }
);

export default router;