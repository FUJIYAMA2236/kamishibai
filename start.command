#!/bin/sh
# Kamishibai launcher for running from the source code (macOS / Linux).
# End users should use the packaged desktop app (npm run dist builds it with Tauri).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Please install the LTS version from https://nodejs.org/"
  exit 1
fi
exec node bin/kamishibai.js serve "$@"
