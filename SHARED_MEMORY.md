# Shared memory across devices

One memory, every device. A session on the Dell opens already knowing what the
Mac and the cloud sessions worked out.

## How it works

```
  Mac session ─┐                                    ┌─→ Mac session
  Dell session ├─→ SessionEnd  → /facts/extract →  Qdrant  → /facts/sync → SessionStart ─┤─→ Dell session
  Cloud session┘                                    └─→ Cloud session
```

- **SessionStart** (`.claude/hooks/memory-sync.mjs`) calls `POST /facts/sync`
  and injects the returned `digest` as session context.
- **SessionEnd** (`.claude/hooks/memory-persist.mjs`) sends the transcript to
  `POST /facts/extract`, which distils durable facts and embeds them.

Each session identifies itself as `<hostname>:<session_id>`. Because
`/facts/sync` excludes only the *calling* session, every session receives
everything learned everywhere else — including earlier sessions on its own
machine.

## What this does and does not share

It shares **facts**, not conversations. The Dell will know *"Cammy ships on
Render"*; it will **not** let you resume the Mac's thread mid-sentence. Local
CLI transcripts live on each machine's disk, keyed by an absolute project path
that differs between macOS and Windows — there is no configuration that makes
them portable. If resuming the exact conversation matters more than carrying
knowledge, run sessions from claude.ai/code instead; those live in the cloud and
are reachable from any device.

## Setup

### 1. Deploy the API

`render.yaml` in this repo defines the service. Deploy it, then set these in the
Render dashboard (never commit values):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Fact extraction + embeddings |
| `QDRANT_API_KEY` | Vector store auth |
| `MEMORY_API_KEY` | The key each device presents |

**Pick a fresh random value for `MEMORY_API_KEY`.** It is the only thing between
the open internet and every fact this service holds. The server refuses to start
without it — there is deliberately no default, because a default here would be a
password published in a public repo.

Confirm it's live: `curl https://<your-service>.onrender.com/health` should
report `v: "1.1"`.

### 2. Point each device at it

Clone this repo on the machine, then run the setup script for its platform. One
command does everything: verifies the URL and key against the live service,
installs both hooks to `~/.claude/hooks/`, merges the hook config into
`~/.claude/settings.json` (backing up whatever was there), and persists the two
env vars.

On the **Mac** (or any Linux box):

```bash
./scripts/setup-device.sh https://<your-service>.onrender.com <your-memory-api-key>
```

On the **Dell**:

```powershell
.\scripts\setup-device.ps1 -Url https://<your-service>.onrender.com -Key <your-memory-api-key>
```

Open a new terminal afterwards so the variables are present.

Both scripts are safe to re-run — they replace their own previous entries rather
than stacking duplicates — and both refuse to change anything if the URL is
unreachable or the key is rejected, so you find out immediately rather than via
silent no-op hooks.

Installing globally like this covers sessions in **any** directory, not just
this repo. Sessions working inside this repo also pick the hooks up from the
committed `.claude/settings.json`, so cloud sessions need no setup at all.

Without both env vars the hooks exit silently and sessions behave normally — an
unconfigured machine is never broken by this, just unsynced.

## If setup fails

| Symptom | Cause |
|---|---|
| `API rejected that key` | The key doesn't match the deployed `MEMORY_API_KEY`. Re-copy it from the Render dashboard — and check you didn't paste the placeholder. |
| `could not reach .../health` | The service isn't deployed, or the URL is wrong. |
| `node is not on PATH` | Install Node 18+ and reopen the terminal. |
| `running scripts is disabled` (Windows) | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then retry. |
| `git is not recognized` (Windows) | Install Git from git-scm.com and reopen PowerShell. |

Both scripts verify the URL and key before writing anything, so a failure at
either of those points leaves the machine exactly as it was.

## Tuning

| Variable | Default | Effect |
|---|---|---|
| `MEMORY_SYNC_TOP_K` | `25` | How many facts get injected at session start |

Both hooks fail open — an 8s timeout on sync, 25s on persist, and any error
exits quietly. Memory being down slows nothing and blocks nothing.

## Checking it works

```bash
curl -H "x-api-key: $MEMORY_API_KEY" $MEMORY_API_URL/sessions
```

Lists every session that has contributed, with fact counts and last-seen — you
should see one entry per device once each has run a session.
