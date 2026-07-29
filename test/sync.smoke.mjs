// Smoke test for cammy-memory-api v1.1 session sync.
// Stands up a mock Qdrant, boots the real server.js against it, and exercises
// the endpoints that don't need OpenAI (scroll-based sync + /sessions).
import http from "http";

const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();

// Fixture facts across three sessions, incl. a duplicate and an expired one.
const POINTS = [
  { id: 1, payload: { fact: "Ates prefers 8am standups", category: "PREFERENCE", expiry_type: "PERMANENT", valid_until: null, confidence: 0.9, entities: [], session_id: "sess-A", session_type: "build", created_at: iso(NOW - 5000), source: "session_extractor" } },
  { id: 2, payload: { fact: "Cammy ships on Render", category: "DECISION", expiry_type: "PERMANENT", valid_until: null, confidence: 0.8, entities: [], session_id: "sess-A", session_type: "build", created_at: iso(NOW - 4000), source: "session_extractor" } },
  { id: 3, payload: { fact: "Ates prefers 8am standups", category: "PREFERENCE", expiry_type: "PERMANENT", valid_until: null, confidence: 0.7, entities: [], session_id: "sess-B", session_type: "voice", created_at: iso(NOW - 3000), source: "session_extractor" } },
  { id: 4, payload: { fact: "Q3 planning freeze is active", category: "TEMPORAL", expiry_type: "DATE", valid_until: iso(NOW - 100000), confidence: 0.9, entities: [], session_id: "sess-B", session_type: "voice", created_at: iso(NOW - 2000), source: "session_extractor" } },
  { id: 5, payload: { fact: "Nadia runs the design review", category: "CONTACT", expiry_type: "PERMANENT", valid_until: null, confidence: 0.85, entities: ["Nadia"], session_id: "sess-C", session_type: "voice", created_at: iso(NOW - 1000), source: "session_extractor" } },
  { id: 6, payload: { fact: "Caller session note, local only", category: "ENTITY", expiry_type: "PERMANENT", valid_until: null, confidence: 0.6, entities: [], session_id: "sess-ME", session_type: "voice", created_at: iso(NOW), source: "session_extractor" } },
];

// ── Minimal Qdrant stand-in: supports filtered scroll ────────
function matchesFilter(payload, filter) {
  if (!filter) return true;
  for (const c of filter.must || []) {
    if (c.match.any && !c.match.any.includes(payload[c.key])) return false;
    if (c.match.value !== undefined && payload[c.key] !== c.match.value) return false;
  }
  for (const c of filter.must_not || []) {
    if (c.match.value !== undefined && payload[c.key] === c.match.value) return false;
    if (c.match.any && c.match.any.includes(payload[c.key])) return false;
  }
  return true;
}

const qdrant = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const b = body ? JSON.parse(body) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("/points/scroll")) {
      const points = POINTS.filter(p => matchesFilter(p.payload, b.filter));
      return res.end(JSON.stringify({ result: { points, next_page_offset: null } }));
    }
    res.end(JSON.stringify({ result: true, status: "ok" }));
  });
});

const PORT_Q = 7331, PORT_S = 7332;
await new Promise(r => qdrant.listen(PORT_Q, r));

process.env.QDRANT_URL = `http://127.0.0.1:${PORT_Q}`;
process.env.PORT = String(PORT_S);
process.env.MEMORY_API_KEY = "test-key";
await import(new URL("../server.js", import.meta.url).href);
await new Promise(r => setTimeout(r, 400));

const call = async (path, method = "GET", payload) => {
  const resp = await fetch(`http://127.0.0.1:${PORT_S}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: resp.status, body: await resp.json() };
};

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\n/facts/sync — excludes caller's own session");
let r = await call("/facts/sync", "POST", { session_id: "sess-ME" });
check("200", r.status === 200, JSON.stringify(r.body).slice(0, 200));
const facts = r.body.results.map(x => x.fact);
check("caller's own fact excluded", !facts.includes("Caller session note, local only"));
check("expired DATE fact dropped", !facts.includes("Q3 planning freeze is active"));
check("duplicate fact carried once", facts.filter(f => f === "Ates prefers 8am standups").length === 1, JSON.stringify(facts));
check("from_sessions lists sources", JSON.stringify(r.body.from_sessions.sort()) === JSON.stringify(["sess-A", "sess-B", "sess-C"]), JSON.stringify(r.body.from_sessions));
check("recency ordered (newest first)", facts[0] === "Nadia runs the design review", facts[0]);
check("digest is prompt-injectable", r.body.digest.startsWith("Context carried over from other Cammy sessions:") && r.body.digest.includes("- Nadia runs the design review"));

console.log("\n/facts/sync — include_expired + filters");
r = await call("/facts/sync", "POST", { session_id: "sess-ME", include_expired: true });
check("expired fact returned when asked", r.body.results.some(x => x.fact === "Q3 planning freeze is active"));

r = await call("/facts/sync", "POST", { session_id: "sess-ME", categories: ["contact"] });
check("category filter (case-insensitive)", r.body.results.length === 1 && r.body.results[0].category === "CONTACT", JSON.stringify(r.body.results.map(x => x.category)));

r = await call("/facts/sync", "POST", { session_id: "sess-ME", session_types: ["voice"] });
check("session_type filter", r.body.results.every(x => x.session_type === "voice") && r.body.results.length > 0);

r = await call("/facts/sync", "POST", { session_id: "sess-ME", since: iso(NOW - 1500) });
check("since filter drops older facts", r.body.results.length === 1 && r.body.results[0].fact === "Nadia runs the design review", JSON.stringify(r.body.results.map(x => x.fact)));

r = await call("/facts/sync", "POST", { session_id: "sess-ME", top_k: 2 });
check("top_k caps results", r.body.results.length === 2 && r.body.count === 2);

r = await call("/facts/sync", "POST", {});
check("missing session_id is a 400", r.status === 400);

console.log("\n/sessions");
r = await call("/sessions");
check("200", r.status === 200);
check("all four sessions aggregated", r.body.count === 4, JSON.stringify(r.body.sessions.map(s => s.session_id)));
const sB = r.body.sessions.find(s => s.session_id === "sess-B");
check("live_facts excludes expired", sB.facts === 2 && sB.live_facts === 1, JSON.stringify(sB));
check("sorted by last_seen desc", r.body.sessions[0].session_id === "sess-ME", r.body.sessions[0].session_id);

console.log("\nauth");
const noKey = await fetch(`http://127.0.0.1:${PORT_S}/sessions`);
check("/sessions requires api key", noKey.status === 401);
const health = await fetch(`http://127.0.0.1:${PORT_S}/health`);
check("/health is open and reports v1.1", health.status === 200 && (await health.json()).v === "1.1");

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
