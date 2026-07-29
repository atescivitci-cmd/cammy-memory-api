#!/usr/bin/env node
// Merge the shared-memory hooks into a Claude Code settings.json.
//
//   node merge-settings.mjs <settings.json path> <hooks dir used in the command>
//
// Shared by setup-device.sh and setup-device.ps1 so the JSON handling is
// byte-identical on both platforms. Windows PowerShell 5.1 — still the default
// on Windows — has no `ConvertFrom-Json -AsHashtable`, and hand-rolling a
// nested merge against PSCustomObject is where that script broke.
import { readFileSync, writeFileSync, existsSync } from "fs";

const [settingsPath, hooksDir] = process.argv.slice(2);
if (!settingsPath || !hooksDir) {
  console.error("usage: merge-settings.mjs <settings.json> <hooks-dir>");
  process.exit(1);
}

const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").trim() : "";
let cfg;
try {
  cfg = raw ? JSON.parse(raw) : {};
} catch {
  console.error(`${settingsPath} is not valid JSON — refusing to overwrite it.`);
  process.exit(1);
}
if (!cfg.hooks || typeof cfg.hooks !== "object" || Array.isArray(cfg.hooks)) cfg.hooks = {};

for (const [event, script] of [["SessionStart", "memory-sync.mjs"], ["SessionEnd", "memory-persist.mjs"]]) {
  const existing = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : [];
  // Drop any prior entry for this hook so re-running updates instead of stacking.
  const kept = existing.filter(group =>
    !(Array.isArray(group && group.hooks) ? group.hooks : [])
      .some(h => String((h && h.command) || "").includes(script)));
  kept.push({ hooks: [{ type: "command", command: `node "${hooksDir}/${script}"` }] });
  cfg.hooks[event] = kept;
}

writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + "\n");
