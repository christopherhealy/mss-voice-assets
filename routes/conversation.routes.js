import express from "express";
import OpenAI from "openai";
import { loadExperienceContext } from "../conversation/experienceContext.js";
import { buildConversationContext } from "../conversation/conversationContext.js";

const router = express.Router();

// ----------------------------------------------------------
// Ingle Conversation — experimental service boundary
// ----------------------------------------------------------
// Experience owns:
// - scenario
// - learner context
// - objectives / gates
// - completion / learning outcomes
//
// Conversation owns:
// - live conversational session
// - provider integration
// - host voice / persona execution
// - session telemetry / metering
// ----------------------------------------------------------


// ----------------------------------------------------------
// Health
// ----------------------------------------------------------
router.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mss-voiceAssets",
    module: "conversation",
    mode: "experimental",
    time: new Date().toISOString(),
  });
});


// ----------------------------------------------------------
// OpenAI client
// ----------------------------------------------------------
function getOpenAIClient() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();

  if (!apiKey) {
    throw new Error("missing_openai_api_key");
  }

  return new OpenAI({ apiKey });
}


// ----------------------------------------------------------
// GPT-Live voice profiles — T2 audition set
// ----------------------------------------------------------
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


// ----------------------------------------------------------
// T5 — read-only Experience context proof
// ----------------------------------------------------------
router.get("/context", async (req, res) => {
  try {
    const experienceKey = String(
      req.query.experience || "visit_veterinarian"
    ).trim();
    const levelNo = Number(req.query.level || 1);

    const ctx = await loadExperienceContext({ experienceKey, levelNo });

    return res.json({
      ok: true,
      source: ctx.source,
      experience: {
        key: ctx.experience.key,
        title: ctx.experience.title,
        can_do_statement: ctx.experience.canDoStatement,
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
      objective_count: ctx.objectives.length,
      objectives: ctx.objectives.map((o) => ({
        gate_no: o.number,
        gate_key: o.key,
        title: o.title,
        can_do_statement: o.canDoStatement,
      })),
    });
  } catch (err) {
    return res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || "context_load_failed",
    });
  }
});


// ----------------------------------------------------------
// GPT-Live WebRTC session
// ----------------------------------------------------------
// Browser sends the WebRTC SDP offer as raw application/sdp.
// Voice Assets creates the GPT-Live session using the server-side
// OpenAI API key and returns the raw SDP answer as application/sdp.
//
// Optional query:
//   ?voice=marin
//
// T5 loads current published Experience context from the DB.
// ----------------------------------------------------------
router.post(
  "/live/session",
  express.text({
    type: "application/sdp",
    limit: "256kb",
  }),
  async (req, res) => {
    try {
      const sdp = req.body;

      if (typeof sdp !== "string" || !sdp.trim()) {
        return res.status(400).json({
          ok: false,
          error: "missing_sdp_offer",
        });
      }

      const requestedVoice = String(
        req.query.voice || DEFAULT_LIVE_VOICE
      ).trim();

      if (!LIVE_VOICES.has(requestedVoice)) {
        return res.status(400).json({
          ok: false,
          error: "unsupported_live_voice",
          voice: requestedVoice,
        });
      }

      const experienceKey = String(
        req.query.experience || "visit_veterinarian"
      ).trim();

      const levelNo = Number(req.query.level || 1);

      const experienceContext = await loadExperienceContext({
        experienceKey,
        levelNo,
      });

      const instructions = buildConversationContext(experienceContext);

      console.log("CONVERSATION_CONTEXT_LOADED", {
        source: experienceContext.source,
        experienceKey: experienceContext.experience.key,
        experienceTitle: experienceContext.experience.title,
        levelNo: experienceContext.level.number,
        levelTitle: experienceContext.level.title,
        host: experienceContext.host.name,
        objectiveCount: experienceContext.objectives.length,
      });

      console.log("CONVERSATION_SDP_OFFER", {
        length: sdp.length,
        startsWith: JSON.stringify(sdp.slice(0, 20)),
        endsWith: JSON.stringify(sdp.slice(-40)),
      });

      const client = getOpenAIClient();

      const live = await client.live.create(
        {
          session: {
            model: "gpt-live-1",

            audio: {
              output: {
                voice: requestedVoice,
              },
            },

            // T5 — compiled from the current published Experience DB context.
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

      console.log("CONVERSATION_LIVE_SESSION_CREATED", {
        sessionId: live?.session?.id || null,
        model: "gpt-live-1",
        voice: requestedVoice,
      });

      return res
        .status(201)
        .type("application/sdp")
        .send(live.transport.sdp);

    } catch (err) {
      console.error(
        "POST /api/conversation/live/session failed:",
        {
          name: err?.name || null,
          status: err?.status || null,
          message: err?.message || String(err),
        }
      );

      return res.status(err?.status || 502).json({
        ok: false,
        error: "live_session_creation_failed",
        message:
          err?.message ||
          "Unable to create GPT-Live session",
      });
    }
  }
);


export default router;