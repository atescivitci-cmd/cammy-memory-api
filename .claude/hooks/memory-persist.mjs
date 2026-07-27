#!/usr/bin/env node
// SessionEnd hook — send this session's transcript to /facts/extract so what
// was learned here becomes durable and reaches every other device.
//
// Requires MEMORY_API_URL and MEMORY_API_KEY. Exits silently without them.
import { hostname } from "os";
import { readFileSync } from "fs";

const API = (process.env.MEMORY_API_URL || "").replace(/\/$/, "");
const KEY = process.env.MEMORY_API_KEY || "";

const skip = () => process.exit(0);

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s ? JSON.parse(s) : {};
}

// Flatten the JSONL transcript into plain "role: text" lines.
function transcriptText(path) {
  const parts = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line).message;
      if (!msg || !msg.role) continue;
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.filter(c => c.type === "text").map(c => c.text).join("\n")
          : "";
      if (text.trim()) parts.push(`${msg.role}: ${text.trim()}`);
    } catch { /* skip malformed line */ }
  }
  return parts.join("\n\n");
}

try {
  if (!API || !KEY) skip();

  const input = await readStdin();
  if (!input.transcript_path) skip();

  const full = transcriptText(input.transcript_path);
  if (full.length < 200) skip(); // nothing worth extracting from a trivial session

  // The API truncates at 12k anyway; keep the tail, where conclusions live.
  const transcript = full.length > 12000 ? full.slice(-12000) : full;

  await fetch(`${API}/facts/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({
      session_id: `${hostname()}:${input.session_id || "unknown"}`,
      session_type: "claude-code",
      transcript,
    }),
    signal: AbortSignal.timeout(25000),
  });
} catch {
  /* never fail a session teardown on memory being unreachable */
}
process.exit(0);
