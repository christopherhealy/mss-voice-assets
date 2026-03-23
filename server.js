import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import voiceRoutes from "./routes/voice.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());

// DEBUG
console.log("SERVER __dirname =", __dirname);
console.log("STATIC DIR =", path.join(__dirname, "public"));

// static files
app.use(express.static(path.join(__dirname, "public")));

// health
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mss-voiceAssets",
    time: new Date().toISOString()
  });
});

// debug route to prove server can see the file
app.get("/debug-file", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "mock-audio", "Kids_Smartphones.txt"));
});

// API
app.use("/api/voice", voiceRoutes);

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