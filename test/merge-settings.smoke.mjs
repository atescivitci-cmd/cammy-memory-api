// Covers scripts/merge-settings.mjs — the settings.json merge shared by both
// setup scripts. This is the step that broke on Windows PowerShell 5.1, so it
// gets its own coverage independent of either shell.
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const MERGE = new URL("../scripts/merge-settings.mjs", import.meta.url).pathname;
const POSIX_HOOKS = "$HOME/.claude/hooks";
const WIN_HOOKS = "C:/Users/Ates/.claude/hooks";

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const dir = mkdtempSync(join(tmpdir(), "ms-"));
let n = 0;
const fresh = content => {
  const p = join(dir, `s${n++}.json`);
  if (content !== undefined) writeFileSync(p, content);
  return p;
};
const run = (p, hooks = POSIX_HOOKS) => execFileSync("node", [MERGE, p, hooks], { encoding: "utf8" });
const read = p => JSON.parse(readFileSync(p, "utf8"));

console.log("\nmerge-settings");

// A path that does not exist yet is the common case on a clean machine.
let p = fresh();
run(p);
let cfg = read(p);
check("creates settings from nothing",
  cfg.hooks.SessionStart.length === 1 && cfg.hooks.SessionEnd.length === 1);
check("writes the SessionStart command",
  cfg.hooks.SessionStart[0].hooks[0].command === 'node "$HOME/.claude/hooks/memory-sync.mjs"',
  cfg.hooks.SessionStart[0].hooks[0].command);
check("writes the SessionEnd command",
  cfg.hooks.SessionEnd[0].hooks[0].command === 'node "$HOME/.claude/hooks/memory-persist.mjs"');

p = fresh("");
run(p);
check("handles an empty file", read(p).hooks.SessionStart.length === 1);

p = fresh('{"model":"opus","hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}');
run(p);
cfg = read(p);
check("preserves unrelated top-level settings", cfg.model === "opus");
check("preserves unrelated hook events", cfg.hooks.PreToolUse.length === 1);
check("adds ours alongside", cfg.hooks.SessionStart.length === 1);

// Re-running the setup script must not stack duplicate entries.
p = fresh();
run(p); run(p); run(p);
cfg = read(p);
check("idempotent across three runs",
  cfg.hooks.SessionStart.length === 1 && cfg.hooks.SessionEnd.length === 1,
  `start=${cfg.hooks.SessionStart.length} end=${cfg.hooks.SessionEnd.length}`);

// A user's own SessionStart hook must survive ours being added.
p = fresh('{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node /my/own/thing.mjs"}]}]}}');
run(p);
cfg = read(p);
check("keeps the user's own SessionStart hook", cfg.hooks.SessionStart.length === 2,
  JSON.stringify(cfg.hooks.SessionStart));

// Windows passes a drive-letter path rather than $HOME.
p = fresh();
run(p, WIN_HOOKS);
check("accepts a Windows absolute path",
  read(p).hooks.SessionStart[0].hooks[0].command === 'node "C:/Users/Ates/.claude/hooks/memory-sync.mjs"',
  read(p).hooks.SessionStart[0].hooks[0].command);

// Never clobber a file we cannot parse.
p = fresh("{ this is not json");
let threw = false;
try { run(p); } catch { threw = true; }
check("refuses invalid JSON", threw);
check("leaves invalid JSON untouched", readFileSync(p, "utf8") === "{ this is not json");

// hooks present but the wrong shape shouldn't crash the merge.
p = fresh('{"hooks":[]}');
run(p);
check("recovers from a malformed hooks value", read(p).hooks.SessionStart.length === 1);

threw = false;
try { execFileSync("node", [MERGE], { encoding: "utf8", stdio: "pipe" }); } catch { threw = true; }
check("requires both arguments", threw);

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
