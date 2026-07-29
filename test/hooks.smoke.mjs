// Smoke test for the shared-memory hooks. Boots the real server.js against a
// mock Qdrant, then runs the hook scripts as Claude Code would: JSON on stdin,
// JSON (or nothing) on stdout.
import http from "http";
import { execFile } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const iso = ms => new Date(ms).toISOString();
const NOW = Date.now();

const POINTS = [
  { id: 1, payload: { fact: "Cammy ships on Render", category: "DECISION", expiry_type: "PERMANENT", valid_until: null, confidence: 0.9, entities: [], session_id: "mac-host:sess-1", session_type: "claude-code", created_at: iso(NOW - 2000), source: "session_extractor" } },
  { id: 2, payload: { fact: "postJSON drops explicit ports", category: "PROJECT", expiry_type: "PERMANENT", valid_until: null, confidence: 0.9, entities: [], session_id: "dell-host:sess-2", session_type: "claude-code", created_at: iso(NOW - 1000), source: "session_extractor" } },
];

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
      return res.end(JSON.stringify({ result: { points: POINTS.filter(p => matchesFilter(p.payload, b.filter)), next_page_offset: null } }));
    }
    res.end(JSON.stringify({ result: true, status: "ok" }));
  });
});

const PORT_Q = 7431, PORT_S = 7432;
await new Promise(r => qdrant.listen(PORT_Q, r));

process.env.QDRANT_URL = `http://127.0.0.1:${PORT_Q}`;
process.env.PORT = String(PORT_S);
process.env.MEMORY_API_KEY = "test-key";
await import(new URL("../server.js", import.meta.url).href);
await new Promise(r => setTimeout(r, 400));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

// Must be async: the mock Qdrant and the API server both run in THIS process,
// so a synchronous exec would block the event loop and the hook's own HTTP
// request would never be answered.
const hook = (name, stdin, env) => new Promise((resolve, reject) => {
  const child = execFile(
    "node",
    [new URL(`../.claude/hooks/${name}`, import.meta.url).pathname],
    { env: { ...process.env, MEMORY_API_URL: `http://127.0.0.1:${PORT_S}`, ...env }, encoding: "utf8" },
    (err, stdout) => (err ? reject(err) : resolve(stdout)),
  );
  child.stdin.end(JSON.stringify(stdin));
});

console.log("\nmemory-sync (SessionStart)");
let out = await hook("memory-sync.mjs", { session_id: "fresh-session", hook_event_name: "SessionStart" });
let parsed = JSON.parse(out);
check("emits SessionStart additionalContext", parsed.hookSpecificOutput?.hookEventName === "SessionStart" && !!parsed.hookSpecificOutput?.additionalContext, out.slice(0, 200));
const ctx = parsed.hookSpecificOutput.additionalContext;
check("carries facts from other devices", ctx.includes("Cammy ships on Render") && ctx.includes("postJSON drops explicit ports"), ctx);
check("is a prompt-shaped digest", ctx.startsWith("Context carried over from other Cammy sessions:"));

out = await hook("memory-sync.mjs", { session_id: "x" }, { MEMORY_API_URL: "", MEMORY_API_KEY: "" });
check("silent when unconfigured", out.trim() === "", out);

out = await hook("memory-sync.mjs", { session_id: "x" }, { MEMORY_API_URL: "http://127.0.0.1:9" });
check("silent when API unreachable", out.trim() === "", out);

console.log("\nmemory-persist (SessionEnd)");
const dir = mkdtempSync(join(tmpdir(), "tr-"));
const tp = join(dir, "transcript.jsonl");
writeFileSync(tp, [
  JSON.stringify({ message: { role: "user", content: "Deploy the memory API to Render and wire the hooks." } }),
  "not json at all",
  JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Added render.yaml with a /health check path." }, { type: "tool_use", name: "Write" }] } }),
  JSON.stringify({ noMessageField: true }),
].join("\n") + "\n");

out = await hook("memory-persist.mjs", { session_id: "s", transcript_path: tp, hook_event_name: "SessionEnd" });
check("survives malformed transcript lines, exits clean", out.trim() === "");

out = await hook("memory-persist.mjs", { session_id: "s", hook_event_name: "SessionEnd" });
check("silent with no transcript_path", out.trim() === "");

out = await hook("memory-persist.mjs", { session_id: "s", transcript_path: "/nonexistent/path.jsonl" });
check("silent when transcript missing", out.trim() === "");

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
