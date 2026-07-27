#!/usr/bin/env node
// SessionStart hook — pull durable facts learned in OTHER sessions (any device)
// and inject them as context, so a session on the Dell opens knowing what the
// Mac and the cloud sessions figured out.
//
// Requires MEMORY_API_URL and MEMORY_API_KEY in the environment. Without them
// the hook exits silently, so an unconfigured machine still works normally.
import { hostname } from "os";

const API = (process.env.MEMORY_API_URL || "").replace(/\/$/, "");
const KEY = process.env.MEMORY_API_KEY || "";
const TOP_K = Number(process.env.MEMORY_SYNC_TOP_K || 25);

// Memory being slow or down must never block a session from starting.
const skip = () => process.exit(0);

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s ? JSON.parse(s) : {};
}

try {
  if (!API || !KEY) skip();

  const input = await readStdin();
  // Device-qualified so /sessions shows provenance; still unique per session,
  // so /facts/sync excludes only THIS session and returns everything else —
  // including earlier sessions on this same machine.
  const session_id = `${hostname()}:${input.session_id || "unknown"}`;

  const resp = await fetch(`${API}/facts/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ session_id, top_k: TOP_K }),
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) skip();
  const body = await resp.json();
  if (!body.digest) skip();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: body.digest,
    },
  }));
  process.exit(0);
} catch {
  skip();
}
