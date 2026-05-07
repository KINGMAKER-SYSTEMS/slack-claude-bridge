#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="${BRIDGE_PLIST_NAME:-com.slack-claude-bridge}"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

if [[ -f "${PLIST_PATH}" ]]; then
  launchctl unload "${PLIST_PATH}" 2>/dev/null || true
  rm "${PLIST_PATH}"
  echo "removed: ${PLIST_PATH}"
else
  echo "not installed"
fi
