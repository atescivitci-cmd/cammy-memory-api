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

Confirm it's live: `curl https://<your-service>.onrender.com/health` should
report `v: "1.1"`.

### 2. Point each device at it

On the **Mac** (and any other zsh/bash machine):

```bash
echo 'export MEMORY_API_URL="https://<your-service>.onrender.com"' >> ~/.zshrc
echo 'export MEMORY_API_KEY="<your-memory-api-key>"' >> ~/.zshrc
```

On the **Dell** (PowerShell):

```powershell
setx MEMORY_API_URL "https://<your-service>.onrender.com"
setx MEMORY_API_KEY "<your-memory-api-key>"
```

Open a new terminal afterwards so the variables are present.

Without both variables the hooks exit silently and sessions behave normally —
so an unconfigured machine is never broken by this, just not synced.

### 3. Enable the hooks beyond this repo

`.claude/settings.json` here is committed, so any session working in **this
repo** picks the hooks up automatically — including cloud sessions, which get it
via git with nothing to install.

To sync sessions in *other* directories, copy the hook scripts to
`~/.claude/hooks/` on each machine and add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/memory-sync.mjs\"" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/memory-persist.mjs\"" }] }
    ]
  }
}
```

On Windows, `$HOME` and `$CLAUDE_PROJECT_DIR` resolve under Git Bash and WSL. In
a native PowerShell setup, use an absolute path instead.

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
