# =====================================================================
# Throwaway PostgreSQL 16 cluster, shared by tests/db/run.sh and
# tests/e2e/run.sh. Source this file; it defines functions and sets no traps.
#
#   cluster_start PORT [EXTRA_CONF]   initdb + start; sets WORK, DATA, LOG
#   cluster_stop                      stop the server and delete WORK
#   psql_as USER [psql args...]       psql over the unix socket in WORK
#   step LABEL USER FILE              run a SQL file, stop the script on error
#
# The server listens only on a unix socket in WORK (no TCP). Needs the
# PostgreSQL 16 server binaries (default /usr/lib/postgresql/16/bin,
# override with PGBIN). When run as root, the server runs as the "postgres"
# OS user because initdb refuses to run as root.
# =====================================================================

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
SUPERUSER="supabase_admin"
WORK=""
DATA=""
LOG=""
PORT=""
SERVER_UP=0

cluster_check_bins() {
  local bin
  for bin in initdb pg_ctl psql; do
    if [ ! -x "$PGBIN/$bin" ]; then
      echo "Missing $PGBIN/$bin. Install PostgreSQL 16 or set PGBIN." >&2
      exit 2
    fi
  done
}

as_server_user() {
  if [ "$(id -u)" = "0" ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

make_workdir() {
  local base="$1" dir
  dir="$(mktemp -d "$base/bensocial-dbtest.XXXXXX")" || return 1
  if [ "$(id -u)" = "0" ]; then
    chown postgres: "$dir"
    chmod 700 "$dir"
    if ! runuser -u postgres -- test -w "$dir"; then
      rm -rf "$dir"
      return 1
    fi
  fi
  echo "$dir"
}

# cluster_start PORT [EXTRA_CONF]
cluster_start() {
  PORT="$1"
  local extra="${2:-}"
  cluster_check_bins
  WORK="$(make_workdir "${TMPDIR:-/tmp}" 2>/dev/null || make_workdir /tmp)"
  DATA="$WORK/data"
  LOG="$WORK/server.log"

  echo "Starting throwaway PostgreSQL 16 cluster on port $PORT ..."
  as_server_user "$PGBIN/initdb" -D "$DATA" -U "$SUPERUSER" -A trust \
    --encoding=UTF8 --no-locale >"$WORK/initdb.log" 2>&1 || {
    cat "$WORK/initdb.log" >&2
    exit 2
  }
  cat >>"$DATA/postgresql.conf" <<CONF
port = $PORT
listen_addresses = ''
unix_socket_directories = '$WORK'
timezone = 'UTC'
fsync = off
synchronous_commit = off
full_page_writes = off
max_connections = 20
$extra
CONF
  as_server_user "$PGBIN/pg_ctl" -D "$DATA" -l "$LOG" -w -t 30 start >/dev/null || {
    cat "$LOG" >&2
    exit 2
  }
  SERVER_UP=1
}

cluster_stop() {
  if [ "$SERVER_UP" = "1" ]; then
    as_server_user "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
    SERVER_UP=0
  fi
  if [ -n "$WORK" ]; then
    rm -rf "$WORK"
  fi
}

psql_as() {
  local user="$1"; shift
  "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U "$user" -d postgres "$@"
}

step() {
  local label="$1" user="$2" file="$3" out
  if out="$(psql_as "$user" -f "$file" 2>&1 >/dev/null)"; then
    if printf '%s\n' "$out" | grep -q 'ERROR:'; then
      echo "FAIL  $label" >&2
      printf '%s\n' "$out" >&2
      exit 1
    fi
    echo "ok    $label"
  else
    echo "FAIL  $label" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
}
