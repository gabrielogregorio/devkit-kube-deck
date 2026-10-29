#!/usr/bin/env bash
# Locks the safety rules of the kd CLI, with a fake kubectl (tests/fake/kubectl) and a fake HOME:
# it never touches a real cluster and needs no network.
#
#   ./tests/test_cli.sh
#
# If this file fails, a rule got weaker. Do not "fix" the test.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KD="$ROOT/bin/kd"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

passed=0; failed=0
pass() { passed=$((passed+1)); printf '  \033[32mok\033[0m    %s\n' "$1"; }
fail() { failed=$((failed+1)); printf '  \033[31mFAIL\033[0m  %s\n        %s\n' "$1" "$2"; }

# ---------------------------------------------------------------- fixtures
# the same fixtures the pytest suite uses, written by conftest.py's FIXTURES
mkdir -p "$TMP/k8s" "$TMP/home/.kube"
PYTHONPATH="$ROOT/tests" python3 - "$TMP/k8s" <<'EOF'
import json, sys
from pathlib import Path
sys.argv, out = sys.argv[:1], Path(sys.argv[1])
import fixtures as conftest
for name, obj in conftest.FIXTURES.items():
    (out / f"{name}.json").write_text(json.dumps(obj))
EOF
export FAKE_K8S_DIR="$TMP/k8s" FAKE_K8S_LOG="$TMP/kubectl.log"
export HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/home/.config" KUBECONFIG="$TMP/home/.kube/config"
export PATH="$ROOT/tests/fake:$PATH"
unset AWS_PROFILE

# runs kd with no terminal on stdin and prints only the exit code
code() { "$KD" "$@" </dev/null >"$TMP/out" 2>&1; printf '%s' "$?"; }

printf '\n\033[1mNo command changes or deletes anything in a cluster\033[0m\n'
for cmd in "restart api" "scale api 3" "kill api-1" "delete pod api-1" "del api-1" "rm api-1" \
           "apply -f x.yaml" "edit deploy/api" "patch deploy/api" "drain node-a" "cordon node-a"; do
  # shellcheck disable=SC2086
  c=$(code $cmd)
  if [ "$c" = 1 ] && grep -q "does not exist in Kube Deck" "$TMP/out"; then
    pass "kd $cmd -> refused"
  else
    fail "kd $cmd" "expected exit 1 with 'does not exist in Kube Deck', got exit $c: $(head -1 "$TMP/out")"
  fi
done
if grep -qE '"(delete|scale|rollout|apply|edit|patch|drain|cordon|label|annotate|taint)"' "$TMP/kubectl.log" 2>/dev/null; then
  fail "the fake kubectl log" "a mutating verb reached kubectl: $(cat "$TMP/kubectl.log")"
else
  pass "no mutating verb ever reached kubectl"
fi

printf '\n\033[1mThe shell asks first, and never without a terminal\033[0m\n'
c=$(code sh api-1)
if [ "$c" = 3 ] && grep -q "interactive terminal" "$TMP/out"; then
  pass "kd sh without a terminal -> refused (exit 3)"
else
  fail "kd sh without a terminal" "expected exit 3, got $c: $(cat "$TMP/out")"
fi
if grep -q '"exec"' "$TMP/kubectl.log"; then
  fail "kd sh without a terminal" "kubectl exec ran anyway"
else
  pass "kubectl exec never ran"
fi
if command -v script >/dev/null; then
  # a real pty: answering anything but "yes" cancels
  out=$(printf 'no\n' | script -qec "$KD sh api-1" /dev/null 2>&1); c=$?
  if printf '%s' "$out" | grep -q cancelled && ! grep -q '"exec"' "$TMP/kubectl.log"; then
    pass "kd sh answered 'no' -> cancelled"
  else
    fail "kd sh answered 'no'" "exit $c: $out"
  fi
  out=$(printf 'yes\nls\n' | script -qec "$KD sh api-1" /dev/null 2>&1)
  if printf '%s' "$out" | grep -q "fake shell" && grep -q '"exec"' "$TMP/kubectl.log"; then
    pass "kd sh answered 'yes' -> opens the shell"
  else
    fail "kd sh answered 'yes'" "$out"
  fi
else
  printf '  \033[2mskip  confirmation through a pty (no script command)\033[0m\n'
fi

printf '\n\033[1mReading works on any cluster\033[0m\n'
for cmd in "pods" "pods -n default" "info api-1" "yaml api-1" "prev api-1" "top" "ls" "map" "version" "help"; do
  # shellcheck disable=SC2086
  c=$(code $cmd)
  if [ "$c" = 0 ]; then pass "kd $cmd"; else fail "kd $cmd" "exit $c: $(tail -3 "$TMP/out")"; fi
done
"$KD" pods </dev/null >"$TMP/out" 2>&1
if [ "$(sed -n 2p "$TMP/out" | awk '{print $2}')" = "api-2" ]; then
  pass "kd pods lists problems first"
else
  fail "kd pods order" "$(cat "$TMP/out")"
fi
c=$(code info nothing-matches)
[ "$c" = 1 ] && grep -q "no pod matches" "$TMP/out" && pass "unknown pod -> clear error" \
  || fail "unknown pod" "exit $c: $(cat "$TMP/out")"
c=$(code nonsense)
[ "$c" = 1 ] && pass "unknown command -> exit 1" || fail "unknown command" "exit $c"

printf '\n\033[1mAWS profile links\033[0m\n'
mkdir -p "$XDG_CONFIG_HOME/kubelente"
printf '{"staging":"legacy"}' > "$XDG_CONFIG_HOME/kubelente/perfis.json"
"$KD" aws </dev/null >"$TMP/out" 2>&1
if grep -q legacy "$TMP/out" && [ -f "$XDG_CONFIG_HOME/devkit-kube-deck/profiles.json" ]; then
  pass "the old link file is carried over to profiles.json"
else
  fail "legacy link file" "$(cat "$TMP/out")"
fi
c=$(code aws link nope dev)
[ "$c" = 1 ] && pass "linking an unknown context -> refused" || fail "aws link unknown" "exit $c"
c=$(code aws bogus)
[ "$c" = 1 ] && pass "unknown aws subcommand -> usage" || fail "aws bogus" "exit $c"

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
