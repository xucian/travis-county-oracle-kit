#!/usr/bin/env bash
# Refresh this mirror from a kit checkout on branch `travis`.
# usage: oracle/travis/refresh-from-kit.sh /path/to/kit-travis
set -euo pipefail
kit="${1:?kit checkout path}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="99c7bff"
rm -rf "$here/kit"
grep -v '^#' "$here/kit-files.txt" | grep -v '^$' | while read -r rel; do
  mkdir -p "$here/kit/$(dirname "$rel")"
  cp "$kit/$rel" "$here/kit/$rel"
done
# The two kit core files that only gain the Travis registration (ADAPTERS entry, data/ ignore line).
git -C "$kit" diff "$base" -- skills/use-oracle/runtime/bin/elephant-county.mjs skills/use-oracle/runtime/.gitignore > "$here/kit-core.patch"
git -C "$kit" rev-parse HEAD > "$here/KIT_COMMIT"
echo "mirrored $(grep -vc '^#' "$here/kit-files.txt") files from $kit at $(cat "$here/KIT_COMMIT")"
