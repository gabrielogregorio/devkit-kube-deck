# CLAUDE.md - Kube Deck

Rules and context for any agent that touches this project. Read it all before editing. This folder
is self-contained: it depends on no external repo or document.

## What it is

A light Kubernetes client: the `kd` CLI (bash + jq over kubectl) and a web interface (React build
served by a Python standard-library backend on 127.0.0.1:8899). Plus `tray_icon.py`, the top bar icon
that turns the web interface on and off.

## The safety model (do not weaken it)

1. Everything **reads**, on any cluster. There is no lab/production split and no context-name guess.
2. The **pod shell** (`kubectl exec`) is the only thing that runs inside a cluster, and it asks first:
   - web: the UI dialog, then `confirm=1`; the backend answers 403 without it (`terminal_refusal`);
   - CLI: `confirm()` in `bin/kd` reads `yes` from an interactive terminal and exits 3 without one.
     Never add a `--yes` flag or an environment variable that skips it.
3. **No** delete, scale, restart, rollout, apply, edit, patch, drain, cordon, label, annotate, taint,
   debug, attach, cp or run: not as a command, a route, a button, a flag or a copyable hint.
   `bin/kd` answers those names with "does not exist in Kube Deck".
4. The backend runs kubectl only through `check_args()` (`ALLOWED_VERBS`, `ALLOWED_CONFIG`,
   `ALLOWED_AUTH`, `SUSPICIOUS`), never with `shell=True`, and `aws` only through `aws_cmd()`.
5. Secret values never leave: only key names. AWS key values never come back through the API.
6. Local writes (kubeconfig, `~/.aws/*`, `profiles.json`) always back up first and keep mode 600;
   `write_ini_section` keeps comments and every other section byte for byte.

A test that fails on any of these means the rule got weaker: fix the code, not the test.

## Running against real clusters

Agents never run `kd sh`, `kubectl exec` or anything that writes on a real cluster. Check
`kubectl config current-context` before any command. Prefer the fake kubectl of the tests.

## Tests (no network, no real cluster)

- `./run-tests.sh`: ruff, shellcheck, pytest (`--cov=server`, gate 100%), `tests/test_cli.sh`,
  vitest (`ui/`). `RUN_E2E=1` adds Playwright (`tests/e2e/`, needs `npm --prefix ui run build`).
- `tests/fake/kubectl` answers from `tests/fixtures.py` and logs every call to `FAKE_K8S_LOG`;
  `FAKE_FORBID=<kind>` answers 403, `FAKE_FAIL=<text>` fails every cluster call. `tests/fake/aws`:
  profile `good` is valid, `missing` does not exist, anything else has an expired SSO session.
- `tests/conftest.py` patches the module paths (`KUBECTL`, `AWS`, `AWS_DIR`, `PROFILE_MAP`,
  `KUBECONFIG`, `BACKUP_DIR`) into `tmp_path`. New paths in the server must be patched there too.
- `# pragma: no cover` only on client/OS races (broken pipe, EIO timing, kill timeouts).

## Conventions

- Code, comments, docs and commits in English; UI text through `t()` with its line in `PT_BR`
  (`ui/src/i18n.js`, checked by `i18n.test.js`); tray text through `tr()` in `tray_icon.py`.
- Python: standard library only at runtime, ruff (line 120). Bash: `set -uo pipefail`, shellcheck clean.
- Commits: one line, imperative, English.
- `VERSION`, `pyproject.toml` and `ui/package.json` carry the same version; the PR must bump `VERSION`.
- No `rm` on user files: old files go to `./trash/` (git-ignored).

## Traps already paid for

- A `die` inside `$(resolve_pod ...)` only exits the subshell; check the status
  (`found=$(resolve_pod ...) || exit 1`).
- `kubectl events --for` does not exist on old kubectl; keep `|| true` where it is cosmetic.
- `auth can-i` without `-n` answers for `default`; with ns=* ask with `--all-namespaces`.
- A 403 is a valid answer, never a hard failure: the RBAC hint mentions credentials, so
  `hard_failure` checks `forbidden` first.
- `configparser.write()` drops comments; never use it on `~/.aws/*`.
- `pgrep -f` inside a `bash -c` that contains the pattern matches the shell itself; kill by PID.
- The top bar icon starts `run.sh` without the shell profile, so nvm's Node is not on the PATH.
  `run.sh` falls back to the newest `~/.nvm/versions/node/*/bin`; keep that fallback, or every `ui/`
  change leaves the icon failing with "npm is not installed". Test with the icon's PATH:
  `tr '\0' '\n' < /proc/<icon pid>/environ | grep ^PATH=`.
