#!/usr/bin/env bash
# Starts the Kube Deck web interface.
#
#   ./run.sh               port 8899
#   ./run.sh 9000          another port
#   ./run.sh --build       rebuilds the interface before starting
#   ./run.sh --no-browser  does not open the browser by itself
#
# Stops the previous instance, rebuilds the interface when its code changed and
# starts the server in the foreground (ctrl-c stops it). The server listens on
# 127.0.0.1 only and only reads; the pod shell is the one thing that runs inside a
# cluster, and the interface asks for a confirmation before opening it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
srv="$root/server/kube_deck.py"
dist="$root/ui/dist"

port="${KD_PORT:-8899}"
force_build=0
open=1

for a in "$@"; do
  case "$a" in
    --build)       force_build=1 ;;
    --no-browser)  open=0 ;;
    -h|--help)     sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    ''|*[!0-9]*)   echo "unknown argument: $a" >&2; exit 2 ;;
    *)             port="$a" ;;
  esac
done

msg() { printf '\033[2m>> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$srv" ] || die "server not found at $srv"
command -v python3 >/dev/null || die "python3 not found"
command -v kubectl >/dev/null || die "kubectl not found (run ./install.sh)"

# ---- stop the previous instance --------------------------------------------
# two copies only bring confusion about which port serves what
old="$(pgrep -f "$srv" 2>/dev/null || true)"
if [ -n "$old" ]; then
  msg "stopping the previous instance (pid $(echo "$old" | tr '\n' ' ' | sed 's/ $//'))"
  # shellcheck disable=SC2086
  kill $old 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$srv" >/dev/null 2>&1 || break
    sleep 0.3
  done
fi

# ---- free port? --------------------------------------------------------------
if command -v ss >/dev/null && ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN; then
  die "port $port is taken by another process. Use: ./run.sh <another-port>"
fi

# ---- interface ---------------------------------------------------------------
need_build=$force_build
if [ ! -f "$dist/index.html" ]; then
  need_build=1
  msg "interface not built yet"
elif [ -n "$(find "$root/ui/src" "$root/ui/index.html" "$root/ui/package.json" \
             -newer "$dist/index.html" -print -quit 2>/dev/null)" ]; then
  need_build=1
  msg "the interface code changed since the last build"
fi

if [ "$need_build" = 1 ]; then
  # started from the top bar icon, the PATH has no nvm: take its newest node
  if ! command -v npm >/dev/null; then
    nvm_bin="$(printf '%s\n' "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin | sort -V | tail -1)"
    [ -d "$nvm_bin" ] && PATH="$nvm_bin:$PATH"
  fi
  command -v npm >/dev/null || die "the interface needs a rebuild, but npm is not installed"
  msg "building the interface..."
  ( cd "$root/ui" && { [ -d node_modules ] || npm ci --silent; } && npm run build ) >/dev/null \
    || die "the interface build failed"
  msg "interface built"
fi

# ---- start -------------------------------------------------------------------
if [ "$open" = 1 ] && command -v xdg-open >/dev/null; then
  ( sleep 1.5; xdg-open "http://localhost:$port" >/dev/null 2>&1 ) &
fi

msg "http://localhost:$port  (ctrl-c stops)"
exec python3 "$srv" "$port"
