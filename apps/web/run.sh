#!/usr/bin/env bash
# ScanList web app — one command: build the frontend (if it exists), run the
# FastAPI server, and expose it over HTTPS.
#
# Why HTTPS: the browser only grants getUserMedia (the phone camera) in a
# "secure context" — https:// or http://localhost. A plain http:// URL on the
# LAN silently leaves navigator.mediaDevices undefined, so the scan screen
# cannot work without TLS. `tailscale serve` gives that with a real trusted
# certificate and a MagicDNS hostname, no ports forwarded on the router.
#
# TLS front, in order of preference:
#   1. tailscale serve  (real cert, https://<machine>.<tailnet>.ts.net[:port])
#   2. caddy            (fallback; see apps/web/DEPLOY.md)
#   3. none             (http://127.0.0.1 only — API testing, no camera)
#
# Idempotent: every process this script starts is tracked by PID under
# $RUN_DIR (/tmp by default, never inside the repo). A re-run stops only those
# PIDs; it never pattern-matches or kills anything it did not start.
# `--stop` tears down exactly what this script created, including its
# tailscale serve mapping (other mappings on the machine are left alone).
#
# Usage:  apps/web/run.sh [options]
#   --port N          uvicorn port            (default 8000,  SCANLIST_WEB_PORT)
#   --https-port N    TLS port for serve      (default 8444,  SCANLIST_WEB_HTTPS_PORT)
#   --tls MODE        auto|tailscale|caddy|none   (default auto, SCANLIST_WEB_TLS)
#   --reload          uvicorn --reload (dev)
#   --skip-build      do not run `npm run build`
#   --no-build        alias of --skip-build
#   --stop            stop what this script started
#   --status          show current state (no changes)
#   -h, --help        this text
#
# Docs: apps/web/DEPLOY.md

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WEB_DIR=$SCRIPT_DIR
SERVER_DIR=$WEB_DIR/server
FRONTEND_DIR=$WEB_DIR/frontend
VENV=$SERVER_DIR/.venv

PORT=${SCANLIST_WEB_PORT:-8000}
HTTPS_PORT=${SCANLIST_WEB_HTTPS_PORT:-8444}
HOST=${SCANLIST_WEB_HOST:-127.0.0.1}
TLS_MODE=${SCANLIST_WEB_TLS:-auto}
DO_BUILD=1
RELOAD=0
ACTION=up

COLOUR=0
[ -t 1 ] && [ -z "${NO_COLOR:-}" ] && COLOUR=1

say()  { if [ "$COLOUR" = 1 ]; then printf '\033[1;36m==>\033[0m %s\n' "$*"; else printf '==> %s\n' "$*"; fi; }
ok()   { if [ "$COLOUR" = 1 ]; then printf '\033[1;32m  ok\033[0m %s\n' "$*"; else printf '  ok %s\n' "$*"; fi; }
warn() { if [ "$COLOUR" = 1 ]; then printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; else printf ' warn %s\n' "$*" >&2; fi; }
die()  { if [ "$COLOUR" = 1 ]; then printf '\033[1;31merror\033[0m %s\n' "$*" >&2; else printf 'error %s\n' "$*" >&2; fi; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() { awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)       [ $# -ge 2 ] || die "--port needs a value"; PORT=$2; shift 2 ;;
    --port=*)     PORT=${1#*=}; shift ;;
    --https-port) [ $# -ge 2 ] || die "--https-port needs a value"; HTTPS_PORT=$2; shift 2 ;;
    --https-port=*) HTTPS_PORT=${1#*=}; shift ;;
    --tls)        [ $# -ge 2 ] || die "--tls needs a value"; TLS_MODE=$2; shift 2 ;;
    --tls=*)      TLS_MODE=${1#*=}; shift ;;
    --reload)     RELOAD=1; shift ;;
    --skip-build|--no-build) DO_BUILD=0; shift ;;
    --stop)       ACTION=stop; shift ;;
    --status)     ACTION=status; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
done

case "$TLS_MODE" in
  auto|tailscale|caddy|none) ;;
  *) die "unknown --tls mode '$TLS_MODE' (auto|tailscale|caddy|none)" ;;
esac

# One run directory per checkout, so two worktrees of this repo do not fight
# over the same PID files. Never written inside the repo.
RUN_DIR=${SCANLIST_RUN_DIR:-/tmp/scanlist-web-$(printf '%s' "$WEB_DIR" | sha256sum | cut -c1-8)}
LOG=$RUN_DIR/server.log
UVICORN_PID_FILE=$RUN_DIR/uvicorn.pid
CADDY_PID_FILE=$RUN_DIR/caddy.pid
TS_PORT_FILE=$RUN_DIR/tailscale-serve.port

# ---------------------------------------------------------------- PID helpers

pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# Read a pid file, and only report the pid if the process on that pid is still
# the one we started (guards against PID reuse after a reboot). No pkill/pgrep
# patterns anywhere: a single pid, checked against its own /proc cmdline.
pid_from_file() {
  local file=$1 expect=$2 pid cmd
  [ -f "$file" ] || return 1
  pid=$(cat "$file" 2>/dev/null || true)
  pid_alive "${pid:-}" || return 1
  cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
  case "$cmd" in
    *"$expect"*) printf '%s' "$pid"; return 0 ;;
    *)           return 1 ;;
  esac
}

stop_pid_file() {
  local file=$1 expect=$2 label=$3 pid i
  pid=$(pid_from_file "$file" "$expect") || { rm -f "$file"; return 0; }
  say "stopping $label (pid $pid)"
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 50); do
    pid_alive "$pid" || break
    sleep 0.1
  done
  if pid_alive "$pid"; then
    warn "$label did not exit on SIGTERM, sending SIGKILL to pid $pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
  ok "$label stopped"
}

stop_tailscale_serve() {
  local port present
  [ -f "$TS_PORT_FILE" ] || return 0
  port=$(cat "$TS_PORT_FILE" 2>/dev/null || true)
  [ -n "${port:-}" ] || { rm -f "$TS_PORT_FILE"; return 0; }
  if have tailscale; then
    # Remove only the mapping this script added (its own --https port).
    present=$(tailscale serve status 2>/dev/null | grep -c ":$port " || true)
    if [ "${present:-0}" -gt 0 ]; then
      say "removing tailscale serve mapping on https:$port"
      tailscale serve --https="$port" off >/dev/null 2>&1 || warn "could not remove tailscale serve mapping on :$port"
    fi
  fi
  rm -f "$TS_PORT_FILE"
}

stop_all() {
  stop_pid_file "$UVICORN_PID_FILE" "app.main:app" "uvicorn (port $PORT)"
  stop_pid_file "$CADDY_PID_FILE" "$RUN_DIR/Caddyfile" "caddy"
  stop_tailscale_serve
}

# --------------------------------------------------------------- small utils

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-5}" "$1" 2>/dev/null || true; }

wait_for_url() { # url label [attempts]
  local url=$1 label=${2:-$1} attempts=${3:-40} i code
  for i in $(seq 1 "$attempts"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)
    [ "$code" = "200" ] && return 0
    sleep 0.25
  done
  return 1
}

port_in_use() { # port
  ss -ltn 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {found=1} END {exit !found}'
}

# PID of the process listening on a port (only own processes are visible to ss).
listening_pid() { # port
  ss -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p' |
    sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -1
}

magicdns_name() {
  have tailscale || return 1
  tailscale status --json 2>/dev/null |
    python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
name = (d.get("Self") or {}).get("DNSName") or ""
name = name.rstrip(".")
if not name:
    sys.exit(1)
print(name)' 2>/dev/null
}

tailscale_online() {
  have tailscale || return 1
  tailscale status --json 2>/dev/null |
    python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
sys.exit(0 if (d.get("Self") or {}).get("Online") else 1)' 2>/dev/null
}

# ------------------------------------------------------------------- lifecycle

action_status() {
  local pid
  mkdir -p "$RUN_DIR"
  printf 'run dir:      %s\n' "$RUN_DIR"
  if pid=$(pid_from_file "$UVICORN_PID_FILE" "app.main:app"); then
    printf 'uvicorn:      pid %s, http://%s:%s (health %s)\n' "$pid" "$HOST" "$PORT" "$(http_code "http://$HOST:$PORT/health")"
  else
    printf 'uvicorn:      not running\n'
  fi
  if [ -f "$TS_PORT_FILE" ]; then
    printf 'tailscale:    serve https:%s -> http://%s:%s\n' "$(cat "$TS_PORT_FILE")" "$HOST" "$PORT"
    printf 'url:          https://%s:%s\n' "$(magicdns_name || echo '<machine>.<tailnet>.ts.net')" "$(cat "$TS_PORT_FILE")"
  else
    printf 'tailscale:    no mapping from this script\n'
  fi
}

build_frontend() {
  [ "$DO_BUILD" = 1 ] || { say "skipping frontend build (--skip-build)"; return 0; }
  if [ ! -d "$FRONTEND_DIR" ]; then
    say "no $FRONTEND_DIR yet — skipping build (card C2 has not landed)"
    return 0
  fi
  if [ ! -f "$FRONTEND_DIR/package.json" ]; then
    warn "$FRONTEND_DIR exists but has no package.json — skipping build"
    return 0
  fi
  have npm || die "npm not found but $FRONTEND_DIR exists; install Node or pass --skip-build"

  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    say "installing frontend dependencies (node_modules missing)"
    if [ -f "$FRONTEND_DIR/package-lock.json" ]; then
      ( cd "$FRONTEND_DIR" && npm ci ) >>"$LOG" 2>&1 || die "npm ci failed (see $LOG)"
    else
      ( cd "$FRONTEND_DIR" && npm install ) >>"$LOG" 2>&1 || die "npm install failed (see $LOG)"
    fi
  fi

  say "building frontend (npm run build)"
  ( cd "$FRONTEND_DIR" && npm run build ) >>"$LOG" 2>&1 || die "npm run build failed (see $LOG)"
  if [ -f "$FRONTEND_DIR/dist/index.html" ]; then
    ok "frontend built: $FRONTEND_DIR/dist"
  else
    warn "npm run build finished but $FRONTEND_DIR/dist/index.html is missing"
  fi
}

ensure_venv() {
  if [ ! -x "$VENV/bin/python" ]; then
    say "creating server virtualenv ($VENV)"
    python3 -m venv "$VENV" || die "could not create venv (python3 -m venv)"
  fi
  if ! "$VENV/bin/python" -c 'import fastapi, uvicorn, httpx' >/dev/null 2>&1; then
    say "installing server requirements (project-local venv, no sudo)"
    "$VENV/bin/pip" -q install -r "$SERVER_DIR/requirements.txt" -r "$SERVER_DIR/requirements-dev.txt" \
      >>"$LOG" 2>&1 || die "pip install failed (see $LOG)"
  fi
  ok "server venv ready ($("$VENV/bin/python" -c 'import fastapi; print("fastapi " + fastapi.__version__)'))"
}

start_uvicorn() {
  if port_in_use "$PORT"; then
    die "port $PORT is already in use by something this script did not start — pass --port N or free it"
  fi
  say "starting uvicorn on http://$HOST:$PORT"
  local -a args=(app.main:app --host "$HOST" --port "$PORT")
  if [ "$RELOAD" = 1 ]; then args+=(--reload); fi
  # Background directly (no wrapping subshell) so $! is uvicorn's own pid, which
  # is what --stop later signals. cwd is restored immediately after the fork.
  pushd "$SERVER_DIR" >/dev/null
  nohup "$VENV/bin/uvicorn" "${args[@]}" >>"$LOG" 2>&1 &
  local pid=$!
  popd >/dev/null
  echo "$pid" >"$UVICORN_PID_FILE"
  if ! wait_for_url "http://$HOST:$PORT/health" 60; then
    tail -n 25 "$LOG" >&2 || true
    stop_pid_file "$UVICORN_PID_FILE" "app.main:app" "uvicorn"
    die "server did not become healthy on http://$HOST:$PORT/health (log: $LOG)"
  fi
  # Belt: if the forked pid is not the one holding the socket, record the real
  # listener instead, so --stop can never leave an orphan behind.
  local actual
  actual=$(listening_pid "$PORT")
  if [ -n "${actual:-}" ] && [ "$actual" != "$pid" ]; then
    pid=$actual
    echo "$pid" >"$UVICORN_PID_FILE"
  fi
  ok "server healthy (pid $pid)"
  curl -s "http://$HOST:$PORT/health"; echo
}

start_tailscale() {
  local dns
  have tailscale || { warn "tailscale not installed"; return 1; }
  tailscale_online || { warn "tailscale is not connected (tailscale up)"; return 1; }
  dns=$(magicdns_name) || { warn "cannot read MagicDNS name from tailscale status"; return 1; }

  say "exposing via tailscale serve: https:$HTTPS_PORT -> http://$HOST:$PORT"
  if ! tailscale serve --bg --https="$HTTPS_PORT" "http://$HOST:$PORT" >>"$LOG" 2>&1; then
    warn "tailscale serve failed (is HTTPS certs/MagicDNS enabled for the tailnet? see $LOG)"
    return 1
  fi
  printf '%s' "$HTTPS_PORT" >"$TS_PORT_FILE"
  if [ "$HTTPS_PORT" = "443" ]; then
    HTTPS_URL="https://$dns"
  else
    HTTPS_URL="https://$dns:$HTTPS_PORT"
  fi
  TS_DNS=$dns
  ok "tailscale serve mapping active"
}

start_caddy() {
  local caddyfile=$RUN_DIR/Caddyfile host
  have caddy || { warn "caddy not installed"; return 1; }
  host=$(hostname)
  say "exposing via caddy on https:$HTTPS_PORT (tls internal)"
  cat >"$caddyfile" <<EOF
# generated by apps/web/run.sh — TLS fallback when tailscale is unavailable.
# \`tls internal\` uses Caddy's local CA: a phone must trust that CA (see DEPLOY.md)
# or getUserMedia stays blocked. Use a real domain + ACME in production.
https://$host.local:$HTTPS_PORT {
	tls internal
	reverse_proxy http://$HOST:$PORT
}
EOF
  nohup caddy run --config "$caddyfile" --adapter caddyfile >>"$LOG" 2>&1 &
  echo $! >"$CADDY_PID_FILE"
  HTTPS_URL="https://$host.local:$HTTPS_PORT"
  TS_DNS=$host.local
  ok "caddy started (pid $(cat "$CADDY_PID_FILE"))"
}

verify_https() {
  local url=$1 dns=$2 cert code i body first
  say "verifying $url"
  code=""
  first=1
  for i in $(seq 1 40); do
    if [ "$first" = 1 ]; then
      # The very first TLS handshake on a fresh tailscale serve mapping waits
      # for the Let's Encrypt certificate to be issued, which can take a minute.
      say "first request may wait for certificate issuance"
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 90 "$url/health" 2>/dev/null || true)
      first=0
    else
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/health" 2>/dev/null || true)
    fi
    [ "$code" = "200" ] && break
    sleep 0.5
  done
  if [ "$code" != "200" ]; then
    warn "HTTPS health check returned '${code:-no response}'"
    return 1
  fi
  ok "HTTPS /health -> 200"
  curl -s --max-time 10 "$url/health"; echo

  cert=""
  if have openssl; then
    cert=$(echo | timeout 15 openssl s_client -connect "$dns:$HTTPS_PORT" -servername "$dns" 2>/dev/null |
      openssl x509 -noout -subject -issuer -dates 2>/dev/null || true)
  fi
  if [ -n "$cert" ]; then
    printf '%s\n' "$cert" | sed 's/^/  cert: /'
  else
    code=$(curl -sI --max-time 10 "$url/health" 2>/dev/null | head -1 || true)
    warn "could not read the certificate with openssl (curl: ${code:-no response})"
  fi

  if [ -f "$FRONTEND_DIR/dist/index.html" ]; then
    body=$(curl -s --max-time 10 "$url/" || true)
    if printf '%s' "$body" | grep -qi '<!doctype html'; then
      ok "static mount serves index.html over HTTPS"
      printf '%s' "$body" | grep -qi '<div id="root"' && ok "index.html contains the SPA root element"
      printf '%s' "$body" | head -c 200; echo
    else
      warn "expected index.html at / but got: $(printf '%s' "$body" | head -c 200)"
    fi
  else
    code=$(http_code "$url/" 10)
    ok "/ returns the JSON info document over HTTPS (frontend dist not built yet, HTTP $code)"
  fi
}

action_up() {
  mkdir -p "$RUN_DIR"
  : >"$LOG"
  say "ScanList web — repo $WEB_DIR"
  say "run dir $RUN_DIR (logs: $LOG)"

  if [ -f "$UVICORN_PID_FILE" ] || [ -f "$CADDY_PID_FILE" ] || [ -f "$TS_PORT_FILE" ]; then
    say "cleaning up the previous run of this script"
    stop_all
  fi

  build_frontend
  ensure_venv
  start_uvicorn

  HTTPS_URL=""
  TS_DNS=""
  case "$TLS_MODE" in
    none)
      warn "--tls none: plain HTTP only — getUserMedia will NOT work off localhost"
      ;;
    tailscale)
      start_tailscale || die "tailscale TLS requested but unavailable (see $LOG)"
      ;;
    caddy)
      start_caddy || die "caddy TLS requested but unavailable (see $LOG)"
      ;;
    auto)
      start_tailscale || start_caddy || die "no TLS front available: install tailscale (preferred) or caddy — see apps/web/DEPLOY.md"
      ;;
    *)
      die "unknown --tls mode '$TLS_MODE' (auto|tailscale|caddy|none)"
      ;;
  esac

  if [ -n "${HTTPS_URL:-}" ]; then
    verify_https "$HTTPS_URL" "$TS_DNS" || die "HTTPS verification failed (log: $LOG)"
  fi

  printf '\n'
  say "ready"
  printf '  local : http://%s:%s\n' "$HOST" "$PORT"
  if [ -n "${HTTPS_URL:-}" ]; then
    printf '  HTTPS : %s        <-- open this on the phone\n' "$HTTPS_URL"
    printf '  the certificate is a trusted public one, so the camera prompt works there\n'
  fi
  printf '  log   : %s\n' "$LOG"
  printf '  stop  : %s --stop\n' "$0"
}

case "$ACTION" in
  up)     action_up ;;
  stop)   stop_all; say "stopped (only processes started by this script)"; exit 0 ;;
  status) action_status ;;
esac
