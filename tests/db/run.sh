#!/usr/bin/env bash
# =====================================================================
# BenSocial database tests.
#
# Starts a throwaway PostgreSQL 16 cluster, loads the Supabase stand-in,
# applies supabase/schema.sql (twice, to prove it can be re-run) and
# supabase/seed.sql (twice), loads the test helpers and fixture accounts,
# then runs every tests/db/NN_*.sql file. A full run finishes by applying
# schema.sql once more on top of the test data: before_rerun.sql turns the
# server switches on and leaves a ban behind first, and after_rerun.sql
# checks that nothing was lost or undone.
# The cluster is stopped and deleted on exit, pass or fail.
#
#   tests/db/run.sh            run everything
#   tests/db/run.sh 07 11      run only files whose names start with 07 or 11
#
# Needs the PostgreSQL 16 server binaries (default /usr/lib/postgresql/16/bin,
# override with PGBIN). When run as root, the server runs as the "postgres"
# OS user because initdb refuses to run as root.
# Exit code is 0 only when every assertion passes.
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=tests/db/cluster.sh
. "$HERE/cluster.sh"

cleanup() {
  local code=$?
  cluster_stop
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cluster_start "${BENSOCIAL_TEST_PORT:-54329}"

# --------------------------------------------------------------- setup
step "supabase stand-in"            "$SUPERUSER" "$HERE/supabase_stubs.sql"
step "schema.sql (first run)"       postgres     "$ROOT/supabase/schema.sql"
step "schema.sql (second run)"      postgres     "$ROOT/supabase/schema.sql"
step "seed.sql (first run)"         postgres     "$ROOT/supabase/seed.sql"
step "seed.sql (second run)"        postgres     "$ROOT/supabase/seed.sql"
step "test helpers"                 "$SUPERUSER" "$HERE/helpers.sql"
step "fixture accounts"             "$SUPERUSER" "$HERE/fixtures.sql"

# --------------------------------------------------------------- tests
TOTAL_PASS=0
TOTAL_FAIL=0
BROKEN=0

run_test_file() {
  local file="$1" name out code pass fail
  name="$(basename "$file")"
  set +e
  out="$(psql_as "$SUPERUSER" -f "$file" 2>&1 >/dev/null)"
  code=$?
  set -e
  pass="$(printf '%s\n' "$out" | grep -c 'NOTICE:  PASS ' || true)"
  fail="$(printf '%s\n' "$out" | grep -c 'WARNING:  FAIL ' || true)"
  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  if [ "$code" != "0" ]; then
    BROKEN=$((BROKEN + 1))
    printf 'FAIL  %-28s %4d passed, %d failed, stopped by an error\n' "$name" "$pass" "$fail"
    printf '%s\n' "$out" | grep -E 'WARNING:  FAIL |ERROR:|DETAIL:|CONTEXT:|HINT:' | sed 's/^/      /'
  elif [ "$fail" != "0" ]; then
    printf 'FAIL  %-28s %4d passed, %d failed\n' "$name" "$pass" "$fail"
    printf '%s\n' "$out" | grep 'WARNING:  FAIL ' | sed 's/^/      /'
  elif [ "$pass" = "0" ]; then
    BROKEN=$((BROKEN + 1))
    printf 'FAIL  %-28s no assertions ran\n' "$name"
  else
    printf 'ok    %-28s %4d passed\n' "$name" "$pass"
  fi
  if [ -n "${VERBOSE:-}" ]; then
    printf '%s\n' "$out" | grep -E 'PASS |FAIL ' | sed 's/^.*\(PASS\|FAIL\) /      \1 /'
  fi
}

FILTERS=("$@")
matches_filter() {
  local name="$1" f
  [ "${#FILTERS[@]}" = "0" ] && return 0
  for f in "${FILTERS[@]}"; do
    case "$name" in "$f"*) return 0 ;; esac
  done
  return 1
}

shopt -s nullglob
for file in "$HERE"/[0-9][0-9]_*.sql; do
  matches_filter "$(basename "$file")" || continue
  run_test_file "$file"
done

# Re-apply the schema on a database that now holds users, posts,
# settings and bans, then check nothing was lost or broken.
if [ "${#FILTERS[@]}" = "0" ]; then
  step "settings and bans before the re-run" "$SUPERUSER" "$HERE/before_rerun.sql"
  step "schema.sql (re-run on live data)" postgres "$ROOT/supabase/schema.sql"
  run_test_file "$HERE/after_rerun.sql"
fi

echo
if [ "$TOTAL_FAIL" = "0" ] && [ "$BROKEN" = "0" ]; then
  echo "DB tests passed: $TOTAL_PASS assertions, 0 failures."
  exit 0
fi
echo "DB tests FAILED: $TOTAL_PASS passed, $TOTAL_FAIL failed, $BROKEN file(s) stopped early."
exit 1
