#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${KITTEN_PACKAGE:-@cheater/cheater-pi}"
VERSION="${KITTEN_VERSION:-}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 22.5.0 is required. Install it from https://nodejs.org/ and run this installer again." >&2
  exit 1
fi
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ "${NODE_MAJOR:-0}" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "${NODE_MINOR:-0}" -lt "$MIN_NODE_MINOR" ]; }; then
  echo "Node.js >= 22.5.0 is required; found $NODE_VERSION. Upgrade from https://nodejs.org/ and run this installer again." >&2
  exit 1
fi

SPEC="$PACKAGE"
if [ -n "$VERSION" ]; then SPEC="$PACKAGE@$VERSION"; fi
echo "Installing Kitten package $SPEC ..."
npm install --global "$SPEC"
echo "Running Kitten doctor..."
if ! kitten doctor; then
  echo "Warning: Kitten doctor reported a problem; the installation itself succeeded." >&2
fi
echo "Kitten is installed. The native desktop app is available from the matching GitHub Release desktop artifact."
