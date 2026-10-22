#!/bin/sh
# Use a Homebrew Node installation even if its global symlink is missing.
set -eu
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  node_bin=$(command -v node)
elif [ -x /opt/homebrew/opt/node/bin/node ]; then
  node_bin=/opt/homebrew/opt/node/bin/node
elif [ -x /usr/local/opt/node/bin/node ]; then
  node_bin=/usr/local/opt/node/bin/node
else
  echo "Journey Watch needs Node.js 22 or newer. Install Node and try again." >&2
  exit 1
fi
"$node_bin" -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Journey Watch needs Node.js 22 or newer."); process.exit(1); }'
exec "$node_bin" server.js
