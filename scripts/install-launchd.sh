#!/usr/bin/env bash
set -euo pipefail

# Configurable via env. Defaults to a generic label.
PLIST_NAME="${BRIDGE_PLIST_NAME:-com.slack-claude-bridge}"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
PROJECT_DIR="${BRIDGE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"

if [[ -z "${NODE_BIN}" || -z "${PNPM_BIN}" ]]; then
  echo "node and pnpm must be on PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "${PROJECT_DIR}/data"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PNPM_BIN}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${PROJECT_DIR}/data/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${PROJECT_DIR}/data/launchd.err.log</string>
</dict>
</plist>
EOF

launchctl unload "${PLIST_PATH}" 2>/dev/null || true
launchctl load "${PLIST_PATH}"

echo "installed and started: ${PLIST_PATH}"
echo "logs: ${PROJECT_DIR}/data/launchd.{out,err}.log"
