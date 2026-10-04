#!/usr/bin/env bash
# =====================================================================
# BenSocial live-mode end-to-end tests.
#
# Starts a local stand-in for a Supabase project, then drives the real app
# in Chromium against it:
#   * a throwaway PostgreSQL 16 cluster with the Supabase stand-in
#     (tests/db/supabase_stubs.sql), supabase/schema.sql and supabase/seed.sql
#   * PostgREST v12.2.3 (downloaded once into tests/e2e/.bin/)
#   * gateway.js: serves index.html, /rest/v1 (PostgREST) and /auth/v1
#     (auth-stub.js, a small GoTrue stand-in) on one port
# Everything is stopped and deleted on exit, pass or fail.
#
#   tests/e2e/run.sh              run every spec
#   tests/e2e/run.sh live         run only live.spec.js (also: auth, switches)
#   tests/e2e/run.sh serve        start the stack and wait (Ctrl-C to stop)
#
# Ports (override with env): E2E_PG_PORT 54339, E2E_POSTGREST_PORT 54340,
# E2E_GATEWAY_PORT 54341. POSTGREST_BIN uses your own PostgREST binary.
# HEADED=1 shows the browser. Failure screenshots go to tests/e2e/.artifacts/.
# Exit code is 0 only when every spec passes.
# =====================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=tests/db/cluster.sh
. "$ROOT/tests/db/cluster.sh"

PG_PORT="${E2E_PG_PORT:-54339}"
PGRST_PORT="${E2E_POSTGREST_PORT:-54340}"
GW_PORT="${E2E_GATEWAY_PORT:-54341}"
PGRST_VERSION="v12.2.3"
PGRST_TARBALL="postgrest-$PGRST_VERSION-linux-static-x64.tar.xz"
PGRST_SHA256="9f71269e61ac3a940281e93ff415760f5957e430e475ba4c3889f3ede7d5527c"
BIN="$HERE/.bin"
MODE="${1:-all}"

case "$MODE" in
  all|live|auth|switches|serve) ;;
  *) echo "Usage: $0 [all|live|auth|switches|serve]" >&2; exit 2 ;;
esac

PIDS=()
cleanup() {
  local code=$?
  local pid
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  cluster_stop
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

show_logs() {
  local f
  for f in "$WORK/postgrest.log" "$WORK/gateway.log"; do
    [ -s "$f" ] || continue
    echo "---- last lines of $(basename "$f")" >&2
    tail -n 40 "$f" >&2
  done
}

# ------------------------------------------------------------ tools
command -v node >/dev/null || { echo "Node.js 18 or newer is required." >&2; exit 2; }

if [ ! -f "$HERE/node_modules/@supabase/supabase-js/dist/umd/supabase.js" ] || [ ! -d "$HERE/node_modules/pg" ]; then
  echo "Installing test dependencies (npm ci) ..."
  (cd "$HERE" && npm ci --no-audit --no-fund >/dev/null)
fi

PGRST="${POSTGREST_BIN:-$BIN/postgrest}"
if [ -n "${POSTGREST_BIN:-}" ]; then
  [ -x "$PGRST" ] || { echo "POSTGREST_BIN is not an executable: $PGRST" >&2; exit 2; }
elif [ ! -x "$PGRST" ] || ! "$PGRST" --version 2>/dev/null | grep -q "${PGRST_VERSION#v}"; then
  if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
    echo "The automatic PostgREST download is for Linux x86_64. Set POSTGREST_BIN to a PostgREST $PGRST_VERSION binary." >&2
    exit 2
  fi
  echo "Downloading PostgREST $PGRST_VERSION ..."
  mkdir -p "$BIN"
  tmp="$(mktemp "$BIN/download.XXXXXX")"
  curl -fsSL -o "$tmp" "https://github.com/PostgREST/postgrest/releases/download/$PGRST_VERSION/$PGRST_TARBALL"
  if [ "$(sha256sum "$tmp" | cut -d' ' -f1)" != "$PGRST_SHA256" ]; then
    rm -f "$tmp"
    echo "The PostgREST download did not match its checksum." >&2
    exit 2
  fi
  tar -xJf "$tmp" -C "$BIN" postgrest
  rm -f "$tmp"
  chmod +x "$BIN/postgrest"
fi

wait_http() {
  local url="$1" label="$2"
  if ! node -e '
    const http = require("http"), url = process.argv[1], until = Date.now() + 30000;
    const poll = () => http.get(url, r => { r.resume(); if (r.statusCode < 500) process.exit(0); again(); }).on("error", again);
    const again = () => Date.now() > until ? process.exit(1) : setTimeout(poll, 200);
    poll();
  ' "$url"; then
    echo "FAIL  $label did not start" >&2
    show_logs
    exit 1
  fi
  echo "ok    $label"
}

# ------------------------------------------------------------ database
cluster_start "$PG_PORT" "max_connections = 60"
step "supabase stand-in"  "$SUPERUSER" "$ROOT/tests/db/supabase_stubs.sql"
step "schema.sql"         postgres     "$ROOT/supabase/schema.sql"
step "seed.sql"           postgres     "$ROOT/supabase/seed.sql"

# ------------------------------------------------------------ API
JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
cat >"$WORK/postgrest.conf" <<CONF
db-uri = "host=$WORK port=$PG_PORT user=authenticator dbname=postgres"
db-schemas = "public"
db-anon-role = "anon"
db-pool = 10
db-max-rows = 1000
db-extra-search-path = "public"
jwt-secret = "$JWT_SECRET"
server-host = "127.0.0.1"
server-port = $PGRST_PORT
log-level = "warn"
CONF
"$PGRST" "$WORK/postgrest.conf" >"$WORK/postgrest.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$PGRST_PORT/" "PostgREST $PGRST_VERSION on port $PGRST_PORT"

mkdir -p "$WORK/scratch"
GATEWAY_PORT="$GW_PORT" POSTGREST_URL="http://127.0.0.1:$PGRST_PORT" JWT_SECRET="$JWT_SECRET" \
  PGHOST="$WORK" PGPORT="$PG_PORT" E2E_SCRATCH_DIR="$WORK/scratch" \
  node "$HERE/gateway.js" >"$WORK/gateway.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$GW_PORT/__health" "gateway on port $GW_PORT"

export E2E_BASE_URL="http://127.0.0.1:$GW_PORT"
export PGHOST="$WORK" PGPORT="$PG_PORT"
export E2E_SCRATCH_DIR="$WORK/scratch"
export E2E_ROOT="$ROOT"

if [ "$MODE" = "serve" ]; then
  echo
  echo "BenSocial live mode: $E2E_BASE_URL"
  echo "Database: psql -h $WORK -p $PG_PORT -U $SUPERUSER postgres"
  echo "Press Ctrl-C to stop."
  wait "${PIDS[@]}" || true
  exit 0
fi

# ------------------------------------------------------------ specs
SPECS=()
case "$MODE" in
  all) SPECS=(live auth switches) ;;
  *) SPECS=("$MODE") ;;
esac

FAILED=0
for spec in "${SPECS[@]}"; do
  echo
  echo "== $spec.spec.js"
  if ! node "$HERE/$spec.spec.js"; then
    FAILED=$((FAILED + 1))
    show_logs
  fi
done

echo
if [ "$FAILED" = "0" ]; then
  echo "E2E passed: ${#SPECS[@]} spec file(s)."
  exit 0
fi
echo "E2E FAILED: $FAILED of ${#SPECS[@]} spec file(s)."
exit 1
