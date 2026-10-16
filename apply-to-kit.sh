#!/usr/bin/env bash
# Rebuild the Travis county modules into a kit checkout (soofi-xyz-team-kit at 99c7bff) so a
# reviewer can rerun from this repository alone.
# usage: oracle/travis/apply-to-kit.sh /path/to/kit-checkout
set -euo pipefail
kit="${1:?kit checkout path}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base="99c7bff"
if ! git -C "$kit" merge-base --is-ancestor "$base" HEAD; then
  echo "kit checkout must contain $base" >&2; exit 1
fi
grep -v '^#' "$here/kit-files.txt" | grep -v '^$' | while read -r rel; do
  mkdir -p "$kit/$(dirname "$rel")"
  cp "$here/kit/$rel" "$kit/$rel"
done
if ! git -C "$kit" apply --check "$here/kit-core.patch" 2>/dev/null; then
  if grep -q "travisAdapter" "$kit/skills/use-oracle/runtime/bin/elephant-county.mjs"; then
    echo "kit core registration already present; patch skipped"
  else
    echo "kit-core.patch does not apply cleanly; register the adapter by hand (see kit-core.patch)" >&2; exit 1
  fi
else
  git -C "$kit" apply "$here/kit-core.patch"
fi
echo "applied the Travis modules into $kit; next: (cd $kit/skills/use-oracle/runtime && npm ci && TZ=America/Chicago npm test)"
