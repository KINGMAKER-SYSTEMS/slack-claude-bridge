#!/usr/bin/env bash
set -euo pipefail

# Interactive setup for slack-claude-bridge.
# Walks a teammate through the post-clone configuration:
#   1. Install dependencies
#   2. Generate .env from prompts
#   3. Generate cloudflared.yml from prompts
#   4. Copy default system prompt
#   5. Print next steps for Slack + Cloudflare side
#
# Re-run safely: existing files prompt before overwriting.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_DIR}"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }
warn() { printf "\033[33m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✓ %s\033[0m\n" "$1"; }

prompt() {
  local label="$1"
  local default="${2:-}"
  local var
  if [[ -n "$default" ]]; then
    read -r -p "$label [$default]: " var
    echo "${var:-$default}"
  else
    read -r -p "$label: " var
    echo "$var"
  fi
}

confirm_overwrite() {
  local file="$1"
  if [[ -e "$file" ]]; then
    read -r -p "$file already exists. Overwrite? [y/N] " yn
    [[ "$yn" =~ ^[Yy]$ ]]
  fi
}

bold "slack-claude-bridge setup"
echo

# ── Dependency check ──────────────────────────────────────────────
bold "1. Checking prerequisites"
for cmd in node pnpm cloudflared claude; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    warn "Missing: $cmd"
    case "$cmd" in
      node) echo "  → install Node 22+: https://nodejs.org" ;;
      pnpm) echo "  → npm i -g pnpm" ;;
      cloudflared) echo "  → brew install cloudflared" ;;
      claude) echo "  → install Claude Code: https://docs.claude.com/en/docs/claude-code" ;;
    esac
    exit 1
  fi
done
ok "node, pnpm, cloudflared, claude all on PATH"
echo

# ── Install deps ──────────────────────────────────────────────────
bold "2. Installing dependencies"
pnpm install
ok "dependencies installed"
echo

# ── .env ─────────────────────────────────────────────────────────
bold "3. Generating .env"
if [[ -e .env ]] && ! confirm_overwrite ".env"; then
  dim "skipping .env"
else
  echo "Paste each value when prompted. You can leave blank now and edit .env later."
  signing=$(prompt "Slack Signing Secret")
  bot_token=$(prompt "Slack Bot Token (xoxb-...)")
  bot_user_id=$(prompt "Slack Bot User ID (U...)")
  allowed=$(prompt "Allowed user IDs (comma-separated)")
  cat > .env <<EOF
SLACK_SIGNING_SECRET=${signing}
SLACK_BOT_TOKEN=${bot_token}
SLACK_BOT_USER_ID=${bot_user_id}
ALLOWED_USER_IDS=${allowed}
PORT=3737
SESSIONS_FILE=./data/sessions.json
LOG_FILE=./data/bridge.log
SYSTEM_PROMPT_FILE=./prompts/system.md
EOF
  ok ".env written"
fi
echo

# ── cloudflared.yml ───────────────────────────────────────────────
bold "4. Generating cloudflared.yml"
if [[ -e cloudflared.yml ]] && ! confirm_overwrite "cloudflared.yml"; then
  dim "skipping cloudflared.yml"
else
  echo "If you don't have a tunnel yet, run:"
  dim "  cloudflared tunnel create <name>"
  dim "  cloudflared tunnel route dns <tunnel-id> <hostname>"
  echo
  tunnel_id=$(prompt "Tunnel ID")
  hostname=$(prompt "Hostname (e.g. my-bot.example.com)")
  creds_file=$(prompt "Credentials file" "$HOME/.cloudflared/${tunnel_id}.json")
  cat > cloudflared.yml <<EOF
tunnel: ${tunnel_id}
credentials-file: ${creds_file}

ingress:
  - hostname: ${hostname}
    service: http://127.0.0.1:3737
  - service: http_status:404
EOF
  ok "cloudflared.yml written"
fi
echo

# ── system prompt ─────────────────────────────────────────────────
bold "5. System prompt"
if [[ -e prompts/system.md ]]; then
  dim "prompts/system.md already exists, leaving as-is"
else
  cp prompts/system.example.md prompts/system.md
  ok "copied prompts/system.example.md → prompts/system.md"
  dim "Edit prompts/system.md to customize how your bot behaves."
fi
echo

# ── data dir ──────────────────────────────────────────────────────
mkdir -p data
ok "data/ ready"
echo

# ── Next steps ────────────────────────────────────────────────────
bold "Next steps"
cat <<'EOS'

1. Slack app
   → https://api.slack.com/apps → Create New App → From an app manifest
   → Paste slack-app-manifest.yaml (toggle YAML in the editor)
   → Update display_name + request_url to match your bot/tunnel
   → Save Changes (verification will fail until step 3, that's ok)
   → Install to Workspace → grab Bot Token and User ID → paste into .env

2. Cloudflare tunnel (autostart on boot)
   sudo cloudflared --config "$(pwd)/cloudflared.yml" service install
   See README "Autostart on login" for the plist fixup.

3. Run the bridge
   pnpm dev
   Once it's up, go back to Slack and re-save Event Subscriptions to verify the URL.

4. Optional: install bridge as launchd agent
   ./scripts/install-launchd.sh

EOS
ok "setup complete"
