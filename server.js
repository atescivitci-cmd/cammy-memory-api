// Cammy Unified Memory API v1.1
// Endpoints:
//   POST /facts/extract   - extract + embed facts from session transcript
//   POST /facts/search    - semantic search over vector store
//   POST /facts/sync      - pull facts learned in OTHER sessions into this one
//   POST /facts/upsert    - directly upsert a single fact
//   GET  /sessions        - list known sessions with fact counts
//   GET  /health          - health check
//
// NEW in v1.1: session scoping. Facts were always stamped with session_id /
// session_type but nothing read them back, so every session searched one flat
// pool. /facts/search now takes session filters, and /facts/sync uses them to
// answer the question a fresh session actually has: "what did the other
// sessions learn that I don't know yet?"

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
      port: urlObj.port || undefined, // else an explicit port (e.g. Qdrant :6333) is dropped
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
      port: urlObj.port || undefined, // else an explicit port (e.g. Qdrant :6333) is dropped
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
  // Payload indexes for the session filters — best effort, no-op once created.
  for (const field of ["session_id", "session_type", "category"]) {
    try {
      await putJSON(`${QDRANT_URL}/collections/${COLLECTION}/index`,
        { field_name: field, field_schema: "keyword" },
        { "api-key": QDRANT_KEY }
      );
    } catch(e) { /* already indexed */ }
  }
}

// ── Shared: is this fact still valid right now? ─────────────
function isLive(payload, now) {
  if (payload.expiry_type === "DATE" && payload.valid_until) return new Date(payload.valid_until) > now;
  return true;
}

// ── Shared: build a Qdrant filter for session/category scoping ──
// `since` is deliberately NOT pushed down here: created_at is an ISO string,
// and range-filtering it in Qdrant would need a datetime index. ISO-8601 sorts
// lexicographically, so callers filter it in-app instead.
function buildFilter({ categories = [], session_id, exclude_session_id, session_types = [] }) {
  const must = [], must_not = [];
  if (categories.length) must.push({ key: "category", match: { any: categories.map(t => String(t).toUpperCase()) } });
  if (session_types.length) must.push({ key: "session_type", match: { any: session_types } });
  if (session_id) must.push({ key: "session_id", match: { value: session_id } });
  if (exclude_session_id) must_not.push({ key: "session_id", match: { value: exclude_session_id } });
  if (!must.length && !must_not.length) return null;
  const filter = {};
  if (must.length) filter.must = must;
  if (must_not.length) filter.must_not = must_not;
  return filter;
}

// ── Shared: normalize a Qdrant point payload into an API result ──
function toResult(p, score, i) {
  return {
    fact: p.fact,
    confidence: score,
    source: p.source || "vector",
    timestamp: p.created_at,
    expiry_type: p.expiry_type,
    valid_until: p.valid_until,
    category: p.category,
    entities: p.entities || [],
    session_id: p.session_id,
    session_type: p.session_type,
    rank: i + 1
  };
}

// ── Shared: page through Qdrant scroll (non-semantic listing) ──
async function scrollPoints(filter, cap = 500) {
  const out = [];
  let offset;
  while (out.length < cap) {
    const body = { limit: Math.min(256, cap - out.length), with_payload: true, with_vector: false };
    if (filter) body.filter = filter;
    if (offset !== undefined && offset !== null) body.offset = offset;
    const resp = await postJSON(`${QDRANT_URL}/collections/${COLLECTION}/points/scroll`, body, { "api-key": QDRANT_KEY });
    const result = resp.body && resp.body.result;
    if (!result) break;
    const pts = result.points || [];
    out.push(...pts);
    offset = result.next_page_offset;
    if (!pts.length || offset === null || offset === undefined) break;
  }
  return out;
}

// ── Shared: prompt-injectable summary of carried-over facts ──
function buildDigest(results) {
  if (!results.length) return "";
  const byCat = {};
  for (const r of results) (byCat[r.category || "ENTITY"] ||= []).push(r.fact);
  const lines = ["Context carried over from other Cammy sessions:"];
  for (const [cat, facts] of Object.entries(byCat)) {
    lines.push(`${cat}:`);
    for (const f of facts) lines.push(`- ${f}`);
  }
  return lines.join("\n");
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
  const {
    question, context_tags = [], top_k = 5, include_expired = false,
    session_id = null, exclude_session_id = null, session_types = [], since = null
  } = req.body;
  if (!question) return res.status(400).json({ error: "question required" });

  try {
    const vector = await embed(question);

    const searchBody = {
      vector,
      limit: top_k,
      with_payload: true,
      score_threshold: 0.60
    };

    const filter = buildFilter({ categories: context_tags, session_id, exclude_session_id, session_types });
    if (filter) searchBody.filter = filter;

    const searchResp = await postJSON(
      `${QDRANT_URL}/collections/${COLLECTION}/points/search`,
      searchBody,
      { "api-key": QDRANT_KEY }
    );

    const now = new Date();
    const results = (searchResp.body.result || [])
      .filter(r => r.payload && (include_expired || isLive(r.payload, now)))
      .filter(r => !since || String(r.payload.created_at || "") > since)
      .map((r, i) => toResult(r.payload, r.score, i));

    res.json({ results, conflict_flags: [], latency_ms: Date.now() - start });
  } catch(e) {
    console.error("[search]", e.message);
    res.status(500).json({ error: e.message, results: [], latency_ms: Date.now() - start });
  }
});

// ── POST /facts/sync ────────────────────────────────────────
// "What have the OTHER sessions learned that I don't know yet?"
// Scopes to everything NOT stamped with the caller's session_id. Pass a
// `question` to rank by semantic relevance, or omit it to get the most recent
// cross-session facts. Returns a ready-to-inject `digest` alongside the rows.
app.post("/facts/sync", async (req, res) => {
  const start = Date.now();
  const {
    session_id, question = null, since = null, categories = [], session_types = [],
    top_k = 20, include_expired = false, digest = true
  } = req.body;
  if (!session_id) return res.status(400).json({ error: "session_id required" });

  try {
    const filter = buildFilter({ categories, session_types, exclude_session_id: session_id });
    const now = new Date();
    let rows;

    if (question) {
      const vector = await embed(question);
      const body = { vector, limit: Math.min(top_k * 4, 200), with_payload: true, score_threshold: 0.60 };
      if (filter) body.filter = filter;
      const resp = await postJSON(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, body, { "api-key": QDRANT_KEY });
      rows = (resp.body.result || []).map(r => ({ payload: r.payload, score: r.score }));
    } else {
      const pts = await scrollPoints(filter, 500);
      rows = pts.map(p => ({ payload: p.payload, score: (p.payload && p.payload.confidence) || 0.8 }));
      rows.sort((a, b) => String(b.payload.created_at || "").localeCompare(String(a.payload.created_at || "")));
    }

    rows = rows
      .filter(r => r.payload && (include_expired || isLive(r.payload, now)))
      .filter(r => !since || String(r.payload.created_at || "") > since);

    // The same fact can be extracted independently by several sessions — carry it once.
    const seen = new Set();
    const results = [];
    for (const r of rows) {
      const key = (r.payload.fact || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(toResult(r.payload, r.score, results.length));
      if (results.length >= top_k) break;
    }

    const body = {
      session_id,
      from_sessions: [...new Set(results.map(r => r.session_id).filter(Boolean))],
      count: results.length,
      results,
      latency_ms: Date.now() - start
    };
    if (digest) body.digest = buildDigest(results);
    res.json(body);
  } catch(e) {
    console.error("[sync]", e.message);
    res.status(500).json({ error: e.message, results: [], latency_ms: Date.now() - start });
  }
});

// ── GET /sessions ───────────────────────────────────────────
// What sessions exist to sync from, and how much each one knows.
app.get("/sessions", async (req, res) => {
  try {
    const pts = await scrollPoints(null, 2000);
    const now = new Date();
    const map = new Map();

    for (const p of pts) {
      const pl = p.payload || {};
      const id = pl.session_id || "unknown";
      const e = map.get(id) || {
        session_id: id, session_type: pl.session_type || null,
        facts: 0, live_facts: 0, first_seen: null, last_seen: null
      };
      e.facts++;
      if (isLive(pl, now)) e.live_facts++;
      const t = pl.created_at || null;
      if (t) {
        if (!e.first_seen || t < e.first_seen) e.first_seen = t;
        if (!e.last_seen || t > e.last_seen) e.last_seen = t;
      }
      map.set(id, e);
    }

    const sessions = [...map.values()]
      .sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")));
    res.json({ sessions, count: sessions.length, sampled_points: pts.length });
  } catch(e) {
    console.error("[sessions]", e.message);
    res.status(500).json({ error: e.message, sessions: [] });
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
  res.json({
    ok: true, v: "1.1", uptime: process.uptime(),
    time: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
    endpoints: ["/facts/extract", "/facts/search", "/facts/sync", "/facts/upsert", "/sessions"]
  });
});

app.listen(PORT, () => console.log(`Cammy Memory API v1.1 on port ${PORT}`));
