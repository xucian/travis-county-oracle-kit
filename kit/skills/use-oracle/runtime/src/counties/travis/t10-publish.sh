#!/usr/bin/env bash
# T10: publish the next run of a published run (assignment decisions.md section 33). Only what is new is uploaded and
# checked; carried roots keep their CIDs and the earlier run's evidence. Run 1's final order (decisions.md 28.7, ruling 3):
# plan, tables CARs, upload with readback, Filebase pins, gateway checks (Pinata first, before its pins, then Filebase),
# Pinata pins, the manifest, the manifest's pin; the remaining Pinata-gateway checks continue in the background, paced to
# its quota. Every step resumes where it stopped: run the same command again.
#
#   src/counties/travis/t10-publish.sh <run id> [<previous run id>]
set -euo pipefail
RUNTIME="$(cd "$(dirname "$0")/../../.." && pwd)"
ASSIGN=/Users/luti/dev/oracle-property-intelligence-platform-pipeline-travis-tx
RUN="${1:?usage: t10-publish.sh <run id> [<previous run id>]}"
PREV="${2:-20261018T143520Z-t5-full}"
CLI="$ASSIGN/node_modules/.bin/elephant-cli"
OUT="data/travis/publish/$RUN"
PINATA=https://gateway.pinata.cloud
FILEBASE=https://ipfs.filebase.io
cd "$RUNTIME"
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
# Credentials from the git-ignored .env, for this process only (never printed).
set -a
# shellcheck disable=SC1091
source "$ASSIGN/.env"
set +a
export FILEBASE_ACCESS_KEY="$FILEBASE_ACCESS_TOKEN"
P=(node src/counties/travis/t6-publish.mjs)
step() { echo "[t10-publish $(date -u +%H:%M:%SZ)] $*"; }

mkdir -p "$OUT" "$ASSIGN/publish/$RUN"
step plan
[ -f "$OUT/plan.json" ] || "${P[@]}" plan --run "data/travis/runs/$RUN" --runtime . --schema-cache data/travis/publish/schema-cache \
  --previous "data/travis/publish/$PREV" --previous-release-tag "run-$PREV" --out "$OUT"
step "tables CARs (new tables roots only)"
"${P[@]}" tables-cars --cli "$CLI" --runtime . --out "$OUT"
step "upload with readback (new roots only)"
"${P[@]}" upload --cli "$CLI" --runtime . --out "$OUT" --concurrency 4 --fetch-timeout-minutes 30
step "Filebase pins (every CID of the run)"
"${P[@]}" filebase-pins --out "$OUT"
step "Pinata gateway, before its pins (stops at its hourly quota; the rest is paced in the background)"
"${P[@]}" gateway-check --out "$OUT" --gateways "$PINATA" --deadline-minutes 15 || true
step "Filebase gateway (every new object)"
"${P[@]}" gateway-check --out "$OUT" --gateways "$FILEBASE" --deadline-minutes 90
step "Pinata pins (every root; carried roots are already pinned)"
"${P[@]}" pin --out "$OUT" --wait-minutes 45 || true
step manifest
"${P[@]}" manifest --out "$OUT" --release-tag "run-$RUN" --with-matches-of "$PINATA" \
  --gateway-copy "$ASSIGN/runs/$RUN.gateway-checks.json" --gateway-name "runs/$RUN.gateway-checks.json" \
  --background-gateway "$PINATA" --background-file "runs/$RUN.gateway-checks-pinata.json" \
  --output "$ASSIGN/publish/$RUN/manifest.json"
step "manifest pin (Filebase add, Pinata pin-by-CID, both gateways)"
"${P[@]}" pin-manifest --cli "$CLI" --out "$OUT" --file "$ASSIGN/publish/$RUN/manifest.json" --gateways "$FILEBASE,$PINATA" || true
step "remaining Pinata-gateway checks, paced, in the background (log $OUT/gateway-checks-pinata.log)"
nohup caffeinate -ims "${P[@]}" gateway-paced --out "$OUT" --gateway "$PINATA" --jsonl gateway-checks-pinata.jsonl --seed-from gateway-checks.jsonl \
  --copy-to "$ASSIGN/runs/$RUN.gateway-checks-pinata.json" > "$OUT/gateway-checks-pinata.log" 2>&1 &
echo "{\"pid\": $!}" > "$OUT/gateway-checks-pinata.pid.json"
step "done: $ASSIGN/publish/$RUN/manifest.json; manifest pin in $OUT/manifest-pin.json"
