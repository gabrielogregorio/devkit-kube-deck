#!/usr/bin/env bash
# Single runner for the Kube Deck test suite. Same commands the CI runs.
#
#   ./run-tests.sh            -> lint + server (pytest, 100% coverage gate) + CLI safety + web UI (vitest)
#   RUN_E2E=1 ./run-tests.sh  -> also the Playwright E2E (real server on 127.0.0.1:18899 + Chromium)
#
# Nothing here talks to a real cluster or to AWS: every layer uses tests/fake/kubectl,
# tests/fake/aws and a fake HOME. The E2E needs the built UI (cd ui && npm run build).
set -u
cd "$(dirname "$0")" || exit

PY="${PY:-.venv/bin/python}"
FAILED=0
declare -a RESULTS

bar() { printf '%s\n' "------------------------------------------------------------"; }
run_layer() {  # run_layer <name> <command...>
  local name="$1"; shift
  bar; echo ">> $name"; bar
  if "$@"; then RESULTS+=("PASS  $name"); else RESULTS+=("FAIL  $name"); FAILED=1; fi
}

# ---------- lint (ruff from the venv; shellcheck when installed) ----------
run_layer "lint     (ruff)" "$PY" -m ruff check .
if command -v shellcheck > /dev/null; then
  run_layer "lint     (shellcheck)" shellcheck --severity=warning ./*.sh bin/kd tests/*.sh
else
  RESULTS+=("SKIP  lint (shellcheck) - sudo apt install shellcheck")
fi

# ---------- server + tray icon (pytest, fake kubectl/aws, 100% gate on server/) ----------
run_layer "server   (pytest + coverage)" "$PY" -m pytest --cov=server --cov-report=term

# ---------- CLI (bash, fake kubectl: no write command exists, the shell asks first) ----------
run_layer "cli      (bin/kd safety)" ./tests/test_cli.sh

# ---------- web UI (vitest) ----------
run_layer "web      (vitest)" npm --prefix ui run --silent test

# ---------- E2E (opt-in) ----------
if [ "${RUN_E2E:-0}" = "1" ]; then
  run_layer "e2e      (Playwright, real server)" npm run --silent test:e2e -- --reporter=line
else
  RESULTS+=("SKIP  e2e (Playwright) - RUN_E2E=1 to run it")
fi

# ---------- scoreboard ----------
echo ""; bar; echo "SCOREBOARD"; bar
for r in "${RESULTS[@]}"; do echo "  $r"; done
bar
if [ "$FAILED" -eq 0 ]; then echo "ALL GREEN ✅"; else echo "FAILURES ❌"; fi
exit "$FAILED"
