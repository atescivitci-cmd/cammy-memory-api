#!/usr/bin/env bash
# Wire this machine (macOS / Linux) into Cammy shared memory.
#
#   ./scripts/setup-device.sh https://your-service.onrender.com YOUR_MEMORY_API_KEY
#
# Installs the SessionStart/SessionEnd hooks globally, persists the two env
# vars to your shell profile, and verifies the API is reachable.
set -euo pipefail

URL="${1:-}"
KEY="${2:-}"

if [[ -z "$URL" || -z "$KEY" ]]; then
  echo "usage: $0 <MEMORY_API_URL> <MEMORY_API_KEY>" >&2
  exit 1
fi
URL="${URL%/}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_DIR="$HOME/.claude/hooks"
SETTINGS="$HOME/.claude/settings.json"

echo "==> Verifying $URL"
VERSION="$(curl -fsS --max-time 15 "$URL/health" | sed -n 's/.*"v":"\([^"]*\)".*/\1/p' || true)"
if [[ -z "$VERSION" ]]; then
  echo "    could not reach $URL/health — check the URL and that the service is deployed" >&2
  exit 1
fi
echo "    reachable, v$VERSION"

echo "==> Checking the key"
CODE="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 -H "x-api-key: $KEY" "$URL/sessions" || true)"
if [[ "$CODE" != "200" ]]; then
  echo "    API rejected that key (HTTP $CODE) — check MEMORY_API_KEY matches the deployed value" >&2
  exit 1
fi
echo "    accepted"

echo "==> Installing hooks to $HOOK_DIR"
mkdir -p "$HOOK_DIR"
cp "$REPO_DIR/.claude/hooks/memory-sync.mjs" "$REPO_DIR/.claude/hooks/memory-persist.mjs" "$HOOK_DIR/"
chmod +x "$HOOK_DIR/memory-sync.mjs" "$HOOK_DIR/memory-persist.mjs"

echo "==> Merging hook config into $SETTINGS"
mkdir -p "$(dirname "$SETTINGS")"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak.$(date +%s)"
# Single-quoted so $HOME stays literal in the written command — the hook then
# resolves it at run time rather than baking in this machine's path.
node "$REPO_DIR/scripts/merge-settings.mjs" "$SETTINGS" '$HOME/.claude/hooks'
echo "    done (previous file backed up alongside it)"

echo "==> Persisting env vars"
case "${SHELL##*/}" in
  zsh)  PROFILE="$HOME/.zshrc" ;;
  bash) PROFILE="$HOME/.bashrc" ;;
  *)    PROFILE="$HOME/.profile" ;;
esac
touch "$PROFILE"
# Drop any earlier block so re-running updates rather than appends.
sed -i.bak '/# >>> cammy shared memory >>>/,/# <<< cammy shared memory <<</d' "$PROFILE"
cat >> "$PROFILE" <<EOF

# >>> cammy shared memory >>>
export MEMORY_API_URL="$URL"
export MEMORY_API_KEY="$KEY"
# <<< cammy shared memory <<<
EOF
echo "    written to $PROFILE"

cat <<EOF

Done. Open a new terminal, then confirm with:

  curl -H "x-api-key: \$MEMORY_API_KEY" "\$MEMORY_API_URL/sessions"

Every Claude Code session on this machine will now sync shared memory.
EOF
