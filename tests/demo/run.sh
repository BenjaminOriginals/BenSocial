#!/usr/bin/env bash
# =====================================================================
# BenSocial demo-mode and fake-client browser tests (no database).
#
#   tests/demo/run.sh                  run every suite
#   tests/demo/run.sh verify [filter]  demo mode only (filter: a regex such as sweep|diff)
#   tests/demo/run.sh live [suite]     live mode with the fake client (suite: e.g. switchesOn)
#   tests/demo/run.sh noclient         demo mode never loads supabase-js
#
# Needs Node.js 18+, Playwright with Chromium (see README.md) and git
# history (verify.js compares against the first prototype, commit a1e807c).
# live-smoke.js also loads the real supabase-js build from tests/e2e; it is
# installed here with npm ci if it is missing.
# Screenshots and scratch copies of index.html go to tests/demo/.out/.
# Exit code is 0 only when every suite passes.
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
MODE="${1:-all}"
ARG="${2:-}"

case "$MODE" in
  all|verify|live|noclient) ;;
  *) echo "Usage: $0 [all|verify|live|noclient] [filter]" >&2; exit 2 ;;
esac

command -v node >/dev/null || { echo "Node.js 18 or newer is required." >&2; exit 2; }

if [ "$MODE" = "all" ] || [ "$MODE" = "live" ]; then
  if [ ! -f "$ROOT/tests/e2e/node_modules/@supabase/supabase-js/dist/umd/supabase.js" ]; then
    echo "Installing tests/e2e dependencies (npm ci) for the real supabase-js build ..."
    (cd "$ROOT/tests/e2e" && npm ci --no-audit --no-fund >/dev/null)
  fi
fi

rm -rf "$HERE/.out"
mkdir -p "$HERE/.out"

SUITES=()
case "$MODE" in
  all) SUITES=(verify live-smoke demo-noclient) ;;
  verify) SUITES=(verify) ;;
  live) SUITES=(live-smoke) ;;
  noclient) SUITES=(demo-noclient) ;;
esac

FAILED=0
for suite in "${SUITES[@]}"; do
  echo
  echo "== $suite.js"
  if ! node "$HERE/$suite.js" ${ARG:+"$ARG"}; then
    FAILED=$((FAILED + 1))
  fi
done

echo
if [ "$FAILED" = "0" ]; then
  echo "Demo tests passed: ${#SUITES[@]} suite(s)."
  exit 0
fi
echo "Demo tests FAILED: $FAILED of ${#SUITES[@]} suite(s)."
exit 1
