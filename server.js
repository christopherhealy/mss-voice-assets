import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import voiceRoutes from "./routes/voice.routes.js";

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
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",

    "https://www.ingless.io",
    "https://ingless.io",
    "https://api.ingless.io",

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

// -------------------------
// HEALTH
// -------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mss-voiceAssets",
    time: new Date().toISOString()
  });
});

// -------------------------
// ROUTES (AFTER CORS)
// -------------------------
app.use("/api/voice", voiceRoutes);

// debug route to prove server can see the file
app.get("/debug-file", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mock-audio", "Kids_Smartphones.txt"));
});


// root
app.get("/", (req, res) => {
  res.send(`
    <h1>MSS Voice Assets</h1>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/api/voice/profiles">/api/voice/profiles</a></li>
      <li><a href="/mock-audio/Kids_Smartphones.txt">/mock-audio/Kids_Smartphones.txt</a></li>
      <li><a href="/debug-file">/debug-file</a></li>
    </ul>
  `);
});

const PORT = process.env.PORT || 3010;

app.listen(PORT, () => {
  console.log(`✅ MSS Voice Assets running on http://localhost:${PORT}`);
});