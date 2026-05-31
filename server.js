// Cammy Unified Memory API v1.0
// Endpoints:
//   POST /facts/extract   - extract + embed facts from session transcript
//   POST /facts/search    - semantic search over vector store
//   POST /facts/upsert    - directly upsert a single fact
//   GET  /health          - health check

import express from "express";
import https from "https";
import http from "http";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const QDRANT_URL = process.env.QDRANT_URL || "https://cammy-qdrant.onrender.com";
const QDRANT_KEY = process.env.QDRANT_API_KEY || "cammy-qdrant-k3y-2026";
const COLLECTION = "cammy_facts";
const API_KEY = process.env.MEMORY_API_KEY || "cammy-mem-2026";

// Auth middleware
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Helper: POST JSON
function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
      timeout: 30000
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function putJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
      timeout: 30000
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Ensure Qdrant collection exists
async function ensureCollection() {
  try {
    await putJSON(`${QDRANT_URL}/collections/${COLLECTION}`,
      { vectors: { size: 1536, distance: "Cosine" }, on_disk_payload: true },
      { "api-key": QDRANT_KEY }
    );
  } catch(e) { /* already exists */ }
}

// Embed text(s) via OpenAI
async function embed(input) {
  const isArray = Array.isArray(input);
  const resp = await postJSON(
    "https://api.openai.com/v1/embeddings",
    { model: "text-embedding-3-small", input },
    { Authorization: `Bearer ${OPENAI_KEY}` }
  );
  if (resp.status !== 200) throw new Error(`Embed failed: ${JSON.stringify(resp.body)}`);
  return isArray ? resp.body.data.map(d => d.embedding) : resp.body.data[0].embedding;
}

// Simple hash for stable point IDs
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = Math.imul(31, h) + str.charCodeAt(i) | 0; }
  return Math.abs(h);
}

// ── POST /facts/extract ─────────────────────────────────────
app.post("/facts/extract", async (req, res) => {
  const { session_id, transcript, session_type = "build" } = req.body;
  if (!transcript) return res.status(400).json({ error: "transcript required" });

  try {
    // Extract facts via GPT-4o-mini
    const extractResp = await postJSON(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Extract atomic durable facts from this Cammy AI EA session transcript.
Return JSON: { "facts": [ { "fact": "one sentence, third person", "category": "CONTACT|DECISION|PROJECT|PREFERENCE|INSTRUCTION|ENTITY|TEMPORAL", "expiry_type": "PERMANENT|DATE|CONDITION", "valid_until": null, "confidence": 0.0-1.0, "entities": [] } ] }
Skip: greetings, one-time tasks, former employer references, hypotheticals. Only durable facts.`
          },
          { role: "user", content: transcript.substring(0, 12000) }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1
      },
      { Authorization: `Bearer ${OPENAI_KEY}` }
    );

    let facts = [];
    try {
      const parsed = JSON.parse(extractResp.body.choices[0].message.content);
      facts = parsed.facts || [];
    } catch(e) { facts = []; }

    if (!facts.length) return res.json({ facts_extracted: 0, vectors_upserted: 0 });

    await ensureCollection();
    const embeddings = await embed(facts.map(f => f.fact));

    const points = facts.map((f, i) => ({
      id: hashCode(`${session_id || "s"}_${i}_${f.fact.substring(0,20)}`),
      vector: embeddings[i],
      payload: {
        fact: f.fact,
        category: f.category || "ENTITY",
        expiry_type: f.expiry_type || "PERMANENT",
        valid_until: f.valid_until || null,
        confidence: f.confidence || 0.8,
        entities: f.entities || [],
        session_id: session_id || "manual",
        session_type,
        created_at: new Date().toISOString(),
        source: "session_extractor"
      }
    }));

    await putJSON(
      `${QDRANT_URL}/collections/${COLLECTION}/points`,
      { points },
      { "api-key": QDRANT_KEY }
    );

    res.json({ facts_extracted: facts.length, vectors_upserted: points.length, conflict_flags: [] });
  } catch(e) {
    console.error("[extract]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /facts/search ──────────────────────────────────────
app.post("/facts/search", async (req, res) => {
  const start = Date.now();
  const { question, context_tags = [], top_k = 5, include_expired = false } = req.body;
  if (!question) return res.status(400).json({ error: "question required" });

  try {
    const vector = await embed(question);

    const searchBody = {
      vector,
      limit: top_k,
      with_payload: true,
      score_threshold: 0.60
    };

    if (context_tags.length) {
      searchBody.filter = {
        must: [{ key: "category", match: { any: context_tags.map(t => t.toUpperCase()) } }]
      };
    }

    const searchResp = await postJSON(
      `${QDRANT_URL}/collections/${COLLECTION}/points/search`,
      searchBody,
      { "api-key": QDRANT_KEY }
    );

    const now = new Date();
    let results = (searchResp.body.result || [])
      .filter(r => {
        if (include_expired) return true;
        if (r.payload.expiry_type === "DATE" && r.payload.valid_until) {
          return new Date(r.payload.valid_until) > now;
        }
        return true;
      })
      .map((r, i) => ({
        fact: r.payload.fact,
        confidence: r.score,
        source: r.payload.source || "vector",
        timestamp: r.payload.created_at,
        expiry_type: r.payload.expiry_type,
        valid_until: r.payload.valid_until,
        category: r.payload.category,
        entities: r.payload.entities || [],
        rank: i + 1
      }));

    res.json({ results, conflict_flags: [], latency_ms: Date.now() - start });
  } catch(e) {
    console.error("[search]", e.message);
    res.status(500).json({ error: e.message, results: [], latency_ms: Date.now() - start });
  }
});

// ── POST /facts/upsert ──────────────────────────────────────
app.post("/facts/upsert", async (req, res) => {
  const { fact, category = "ENTITY", expiry_type = "PERMANENT", valid_until = null, entities = [], confidence = 0.9 } = req.body;
  if (!fact) return res.status(400).json({ error: "fact required" });

  try {
    await ensureCollection();
    const vector = await embed(fact);
    const point = {
      id: hashCode(`manual_${fact.substring(0,40)}_${Date.now()}`),
      vector,
      payload: { fact, category, expiry_type, valid_until, entities, confidence, session_id: "manual", session_type: "direct", created_at: new Date().toISOString(), source: "direct_upsert" }
    };

    await putJSON(`${QDRANT_URL}/collections/${COLLECTION}/points`, { points: [point] }, { "api-key": QDRANT_KEY });
    res.json({ success: true, id: point.id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /health ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, v: "1.0", uptime: process.uptime(), time: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) });
});

app.listen(PORT, () => console.log(`Cammy Memory API v1.0 on port ${PORT}`));
