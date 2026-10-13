import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import voiceRoutes from "./routes/voice.routes.js";
import conversationRoutes from "./routes/conversation.routes.js";
import {
  startLiveRecoveryScheduler,
} from "./conversation/ingleLiveRecoveryScheduler.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());

// -------------------------
// CORS CONFIG (Gold Standard)
// -------------------------
function isAllowedOrigin(origin = "") {
  if (!origin) return true;

  const exactOrigins = new Set([
  "http://localhost:3010",
  "http://127.0.0.1:3010",

  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8080",

  "https://www.ingless.io",
  "https://ingless.io",
  "https://api.ingless.io",

  "https://fluently.click",
  "https://www.fluently.click",

  "https://eslsuccess.club",
  "https://www.eslsuccess.club",
]);

  if (exactOrigins.has(origin)) return true;

  // Production tenant subdomains:
  // https://mss.ingless.io
  // https://jessyacademy.ingless.io
  if (/^https:\/\/[a-z0-9-]+\.ingless\.io$/i.test(origin)) return true;

  // Local tenant subdomains:
  // http://mss.localhost:3000
  // http://jessyacademy.localhost:3000
  if (/^http:\/\/[a-z0-9-]+\.localhost(?::\d+)?$/i.test(origin)) return true;

  return false;
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    console.warn("VOICE CORS blocked origin:", origin);
    return callback(new Error(`CORS not allowed: ${origin}`), false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "Authorization"],
  credentials: false,
  optionsSuccessStatus: 204,
};

// Apply globally
app.use(cors(corsOptions));

// Explicit preflight for critical routes
app.options("/api/voice/render", cors(corsOptions));
app.options("/api/voice/profiles", cors(corsOptions));
app.options("/api/voice/playback", cors(corsOptions));
// -------------------------
// DEBUG
// -------------------------
console.log("SERVER __dirname =", __dirname);
console.log("STATIC DIR =", path.join(__dirname, "public"));

// -------------------------
// STATIC
// -------------------------
app.use(express.static(path.join(__dirname, "public")));




// HEALTH
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mss-voicePersonas",
    time: new Date().toISOString()
  });
});

// -------------------------
// ROUTES (AFTER CORS)
// -------------------------
app.use("/api/voice", voiceRoutes);

// -------------------------
// CONVERSATION
// -------------------------

app.use("/api/conversation", conversationRoutes);

// debug route to prove server can see the file
app.get("/debug-file", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mock-audio", "Kids_Smartphones.txt"));
});


// root
app.get("/", (req, res) => {
  res.send(`
    <h1>MSS Voice Personas</h1>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/api/voice/profiles">/api/voice/profiles</a></li>
      <li><a href="/mock-audio/Kids_Smartphones.txt">/mock-audio/Kids_Smartphones.txt</a></li>
      <li><a href="/debug-file">/debug-file</a></li>
    </ul>
  `);
});

const PORT = process.env.PORT || 3010;

const server = app.listen(PORT, () => {
  console.log(`✅ MSS Voice Personas running on http://localhost:${PORT}`);
});

const liveRecoveryScheduler = startLiveRecoveryScheduler();

// ------------------------------------------------------------
// Graceful shutdown
//
// Stop new HTTP connections and recovery scheduling.
// Wait for in-flight HTTP requests and recovery work.
//
// A timeout prevents indefinite shutdown.
// Durable recovery remains responsible for interrupted work.
// ------------------------------------------------------------

const SHUTDOWN_TIMEOUT_MS = 30_000;

let shuttingDown = false;

function closeHttpServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });

    // Close idle keep-alive connections without terminating
    // requests that are actively being processed.
    server.closeIdleConnections?.();
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log("VOICE_ASSETS_SHUTDOWN_STARTED", { signal });

  let timeoutHandle;

  const deadline = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("voice_assets_shutdown_timeout"));
    }, SHUTDOWN_TIMEOUT_MS);
  });

  try {
    // Begin HTTP shutdown and scheduler shutdown together.
    // Both must complete before shutdown is successful.
    await Promise.race([
      Promise.all([
        closeHttpServer(),
        liveRecoveryScheduler.stop(),
      ]),
      deadline,
    ]);

    console.log("VOICE_ASSETS_SHUTDOWN_COMPLETE");

    process.exitCode = 0;
  } catch (error) {
    console.error("VOICE_ASSETS_SHUTDOWN_ERROR", {
      message: error?.message || String(error),
    });

    process.exitCode = 1;

    // Only force-close HTTP connections after the deadline.
    // The recovery journal protects unfinished recovery work
    // when the process is subsequently terminated.
    server.closeAllConnections?.();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
