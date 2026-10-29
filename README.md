<div align="center">

# Kube Deck (`kd`)

**A light Kubernetes client that is safe by design: a CLI and a web interface over kubectl that read freely, ask before opening a pod shell and never delete anything.**

![Bash](https://img.shields.io/badge/Bash-4EAA25?style=for-the-badge&logo=gnubash&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3670A0?style=for-the-badge&logo=python&logoColor=ffdd54)
![kubectl](https://img.shields.io/badge/kubectl-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![AWS](https://img.shields.io/badge/AWS_EKS-232F3E?style=for-the-badge&logo=amazonwebservices&logoColor=white)
![pytest](https://img.shields.io/badge/pytest-0A9EDC?style=for-the-badge&logo=pytest&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=for-the-badge&logo=vitest&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)
![Coverage](https://img.shields.io/badge/server%20coverage-100%25-2E7D32?style=for-the-badge)
![Safe](https://img.shields.io/badge/never-deletes%20%7C%20scales%20%7C%20restarts-C62828?style=for-the-badge)
![Languages](https://img.shields.io/badge/UI-en%20%7C%20pt--BR-555555?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)

[![Tests](https://github.com/gabrielogregorio/devkit-kube-deck/actions/workflows/tests.yml/badge.svg)](https://github.com/gabrielogregorio/devkit-kube-deck/actions/workflows/tests.yml)
[![Lint](https://github.com/gabrielogregorio/devkit-kube-deck/actions/workflows/check-quality.yml/badge.svg)](https://github.com/gabrielogregorio/devkit-kube-deck/actions/workflows/check-quality.yml)
[![CodeQL](https://github.com/gabrielogregorio/devkit-kube-deck/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/gabrielogregorio/devkit-kube-deck/actions/workflows/codeql-analysis.yml)

</div>

## About

A Kubernetes client cut down to what matters every day: **take in a new kubeconfig, see the whole
cluster, look inside a pod.** No account, no license, no server to host. It is `kubectl` underneath,
with the rough edges sanded off.

It is **safe by design**, on any cluster, with no "production mode" to remember:

- every screen and every command **reads**;
- the **pod shell** (`kubectl exec`) is the only thing that runs inside a cluster, and it **asks first**;
- there is **no delete, scale, restart, apply, edit or patch**. Not behind a flag, not behind a
  confirmation.

The CLI runs in a terminal, so it also works over SSH on a bastion host where no GUI runs.

```bash
kd add ~/Downloads/kubeconfig.yaml --alias staging
kd map
kd web
```

## Set up on a new PC

1. System packages (`install.sh` downloads the rest by itself, with no sudo):
   ```bash
   sudo apt install curl python3 git jq
   sudo apt install nodejs npm      # only for the web interface (./run.sh); Node 18 or newer
   ```
   EKS clusters: install the AWS CLI v2 (<https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html>).
   A local lab (optional): Docker + [k3d](https://k3d.io).
2. Clone and install:
   ```bash
   git clone https://github.com/gabrielogregorio/devkit-kube-deck.git
   cd devkit-kube-deck
   ./install.sh                         # kubectl, jq, k9s, stern, fzf, kubectx in ~/.local/bin + the kd link
   export PATH="$HOME/.local/bin:$PATH" # when install.sh says so (put it in ~/.bashrc)
   kd doctor                            # checks the connection to the current context
   ```
3. Use it: `kd add <kubeconfig-file>` (see below), `kd map`, and `./run.sh` for the web interface on
   <http://localhost:8899> (the first run does `npm ci` + the interface build).

**Top bar icon (optional):** `./tray_icon.py --install`. It runs on the system python3 and needs
`sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1` (already on an Ubuntu
desktop).

**Outside the repository:**

| Path | What |
|---|---|
| `~/.kube/config` | your kubeconfig (`kd add`, `kd alias` and the AWS screen write here, always with a backup) |
| `~/.kube/kube-deck-backups/` | the kubeconfig backups |
| `~/.aws/credentials`, `~/.aws/config` | AWS keys and regions (the AWS screen writes here, with a backup) |
| `~/.config/devkit-kube-deck/profiles.json` | which AWS profile each cluster uses (mode 600) |
| `~/.config/k9s/` | the read-only k9s plugins and aliases copied by `install.sh` |
| `~/.local/bin/kd` and the tools | links and binaries from `install.sh` |
| `~/.config/autostart/devkit-kube-deck-tray.desktop` | the top bar icon at login, starting off (`./tray_icon.py --install`) |
| `~/.local/share/applications/devkit-kube-deck-tray.desktop` | the app menu shortcut of the icon |
| `~/.cache/devkit-kube-deck/` | the icon's server log, icons and lock |

`./tray_icon.py --remove` takes out both shortcuts. Moved the folder? Run `./install.sh` and
`./tray_icon.py --install` again (the links keep the path).

Coming from the old name (kubelente, `kl`): the AWS links in `~/.config/kubelente/perfis.json` are
read once and copied to `profiles.json`, and `install.sh` moves the dead `kl` link to `./trash/`.

## Available scripts

```bash
# Run
kd                     # help
kd console             # live panel in the terminal
./run.sh               # web interface on http://localhost:8899 (rebuilds when the UI code changed)
./run.sh --build       # forces the interface build
./run.sh --no-browser  # does not open the browser
./run.sh 9000          # another port

# Top bar icon (turns the web interface on and off), at every login
./tray_icon.py --install
./tray_icon.py --remove

# Install / repair
./install.sh

# Test (no network, no real cluster: fake kubectl and aws)
./run-tests.sh            # ruff + shellcheck + pytest (100% gate) + CLI safety + vitest
RUN_E2E=1 ./run-tests.sh  # + Playwright against the real server

# Interface (development)
cd ui && npm ci && npm run dev    # Vite with reload, proxies /api to :8899

# Dependencies (uv)
uv lock --upgrade-package <pkg>==<version>
uv export --only-group dev --no-hashes --format requirements-txt > requirements-dev.txt
```

## Tests

Nothing in the suite talks to a real cluster or to AWS. `tests/fake/kubectl` answers from JSON
fixtures (`tests/fixtures.py`) and logs every call, `tests/fake/aws` plays a valid and an expired
profile, and every layer runs on a fake `HOME`.

| Layer | What it locks |
|---|---|
| `tests/test_server.py` (pytest, 100% coverage of `server/`) | the kubectl verb allowlist, no route that changes the cluster, the shell needs `confirm=1`, Secret values never leave, AWS key values never come back, ini edits keep comments, every route against the fixtures, SSE logs and login, the WebSocket shell |
| `tests/test_cli.sh` (bash) | every write command is refused before kubectl, the fake log never sees a mutating verb, `kd sh` refuses without a terminal and asks through a real pty, reading works, the old link file is carried over |
| `tests/test_tray_icon.py` (pytest) | the top bar icon without GTK: icons, process checks, texts, i18n catalog, `--install` |
| `ui/src/*.test.js` (vitest) | the AWS paste parser, the i18n catalog (every `t()` key has a pt-BR line), the API helpers |
| `tests/e2e/app.spec.js` (Playwright) | the built UI against the real server: overview, pt-BR, no write button, the shell dialog runs nothing on Cancel |

## CI/CD

| Workflow | When | What |
|---|---|---|
| `tests.yml` | push and PR to `main` | unit layers, then the E2E with Chromium |
| `check-quality.yml` | push and PR to `main` | ruff, shellcheck, scripts executable, actions pinned by hash, YAML valid |
| `codeql-analysis.yml` | push, PR and weekly | CodeQL for Python, JavaScript and the workflows |
| `auto-complete-fields.yml` | PR to `main` | `VERSION` must be a new tag; assigns, labels and fills the changelog |
| `create-tag-and-release.yml` | PR merged into `main` | tag `vX.Y.Z` + release with the source tarball and `SHA256SUMS` |

Every action is pinned to a full commit hash; Dependabot proposes the bumps monthly.

### Releasing

Bump `VERSION` in the PR. Merging into `main` creates the tag and the release; a PR whose `VERSION`
already has a tag fails the "VERSION is new" check.

## Usage

### Daily commands

```bash
kd ls                  # every cluster, the current one marked
kd use                 # picker (fzf); or kd use staging
kd ns                  # namespace picker
kd doctor              # why the connection failed

kd map                 # overview of the cluster
kd pods                # every pod, problems first
kd pods -n payments    # one namespace
kd pods api            # regex on the name
kd info api            # pod summary + events
kd log api             # follows the log (several replicas match? follows them all through stern)
kd prev api            # log of the container that died
kd top                 # cpu/memory of nodes and pods
kd fw api 8080:80      # port-forward (a local tunnel, changes nothing)
kd ui                  # k9s on the current cluster, started with --readonly
kd sh api              # shell inside the pod, after you type "yes"
```

`<pod>` takes **part of the name** and looks in every namespace. When more than one matches, it
opens a picker (or follows them all, for the log).

### A new kubeconfig arrived

```bash
kd add ~/Downloads/kubeconfig.yaml --alias staging
```

What it does that plain `kubectl` does not:

1. **Validates** the file before touching your kubeconfig.
2. **Backs up** your kubeconfig to `~/.kube/kube-deck-backups/` (timestamped).
3. **Detects context name clashes.** The native merge (`kubectl config view --flatten`) drops the
   duplicate **silently**, and you think you switched clusters when you did not. Here it renames it
   to `<name>-2` and tells you. With `--force` it replaces it on purpose.
4. **Creates a short alias.** An EKS context is a 70-character ARN. It suggests a short name and adds
   an extra context pointing to the same cluster, without removing the original.

Pasting works too: `cat config.yaml | kd add - --alias dev`.

### Interactive mode (`kd console`)

```bash
kd console            # every pod, live
kd console api        # only the ones matching the regex
```

A panel that redraws itself; pick the pod by number and act on it without retyping. `a` turns on a
5 s auto refresh (any key takes control back), `/` filters, `n` switches namespace, `c` switches
cluster. With a pod open: `l` live log, `p` previous log, `i` info, `y` yaml, `d` describe, `e`
events, `f` port-forward, `s` shell (asks first).

### Web interface (`./run.sh` or `kd web`)

React in front, a Python backend (standard library only) behind, listening on `127.0.0.1` only.
`run.sh` stops the previous instance, rebuilds the interface **when its code changed since the last
build** and starts in the foreground (ctrl-c stops it).

| Screen | What it shows |
|---|---|
| **Overview** | node/pod/broken-now/leftover cards, broken pods, leftovers of dead pods, load per namespace, nodes with CPU and memory, warning events |
| **Nodes** | capacity, usage, kubelet version, cordon, and the pods of each node on click |
| **Events** | every event, warning filter, search |
| **Pods** | ready, state, restarts, CPU/mem, node, IP; text filter and "only broken now" |
| **Workloads** | Deployments, StatefulSets, DaemonSets, CronJobs and Jobs, with image and readiness |
| **Network** | Ingresses with a clickable host and Services with ports and external IP |
| **Config and Secrets** | ConfigMaps and Secrets, key names only |
| **Storage** | PVCs and PVs |
| **Access and RBAC** | who you are on the cluster and what your user can do, per screen |
| **AWS credentials** | which profile each cluster uses, SSO login, paste a new credential |

A pod opens a side panel with **Summary**, **Containers** (image, probes, requests/limits, reason of
the last death), **Logs** (live over SSE, search, container picker, previous run), **Events**,
**Describe**, **YAML** and **Terminal**.

**Broken now vs leftover of a dead pod.** A pod in phase `Failed` (`Error`, `Evicted`) already had its
containers removed from the node: it **reserves no CPU or memory** and only the object is left in
etcd. A pod in `CrashLoopBackOff` is **alive** (phase `Running`) and still holds its requests. The
screen keeps them apart, because they call for different actions.

**Every command shows on the screen.** The bottom bar lists exactly the `kubectl` calls the backend
ran to build that view, with a copy button per line. It audits what the tool does and lets you go
further in a terminal.

The cluster picker reads the contexts of your kubeconfig. Switching there **does not change** the
`current-context` of your kubeconfig; it is only the view of the screen. The interface follows the
browser language (`?lang=en` or `?lang=pt-BR` forces one, and the picker on the top bar remembers it).

### The pod shell

A real terminal (xterm.js over a PTY in the backend): ANSI colors, resize, `ctrl-c` and full-screen
programs work. Right click copies when there is a selection and pastes otherwise;
`ctrl+shift+c` / `ctrl+shift+v` work too.

Opening it runs `kubectl exec`, so it **always asks first**: the Terminal tab opens a dialog
("Open a shell in default/api-1 on staging? This runs a process inside the cluster.") and nothing
runs until you click **Open shell**. The backend enforces it too: without `confirm=1` the route answers
403 before any WebSocket upgrade. In the CLI, `kd sh` asks you to type `yes` and refuses outright
when there is no interactive terminal (a script, a pipe, an agent). What the shell can do inside the
pod is decided by the RBAC of your credential, not by this tool.

### AWS credentials: one per cluster

An EKS kubeconfig calls `aws eks get-token` **without saying which profile to use**, so it takes
whatever `AWS_PROFILE` is exported in the shell. That is how two accounts get mixed up: you export
the profile of one, switch context, and keep authenticating with the wrong account.

Kube Deck binds the credential to the cluster:

```bash
kd aws                        # which profile each cluster uses
kd aws link staging dev       # binds it (every context of the same cluster)
kd aws login                  # aws sso login of the current cluster's profile
```

Or in the interface, under **AWS credentials**: it reads `~/.aws/config`, finds the right profile
**by the AWS account of the cluster** and links it in one click; **SSO login** shows the code and the
link live. The link lives in `profiles.json`; **your kubeconfig is not changed**, and `AWS_PROFILE` is
injected only into the calls Kube Deck makes.

**Paste a new credential without editing any file.** The **Inject credentials and cluster** block
takes the raw paste from the AWS console and extracts the values:

```
aws eks update-kubeconfig --region us-west-2 --name my-cluster-prod \
  --role-arn arn:aws:iam::111122223333:role/MyEKSReadRole

export AWS_ACCESS_KEY_ID="ASIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."
```

It understands `export`, `set`, `$Env:`, the `[profile]` `.ini` block and the `aws eks
update-kubeconfig` flags. One click writes the keys to the profile (`~/.aws/credentials`, mode 600,
backup first), registers the cluster in your `~/.kube/config` and links the profile to the new
context. Key values never come back through the API once written. The `aws` CLI can only be called
with `sts get-caller-identity`, `sso login`, `sso logout`, `configure list-profiles` and
`eks update-kubeconfig`, which writes only your local kubeconfig.

## Safety

| What | CLI (`kd`) | Web interface |
|---|---|---|
| read (get, describe, logs, top, events, auth can-i) | any cluster | any cluster |
| port-forward (a local tunnel) | `kd fw` | not offered |
| pod shell (`kubectl exec`) | `kd sh`: type `yes` at an interactive terminal, never without one | dialog + `confirm=1`, or 403 |
| delete, scale, restart, apply, edit, patch, drain, cordon | does not exist (`kd delete` prints that it does not exist) | does not exist (no route; the verb allowlist refuses it) |
| your kubeconfig and AWS files | `kd add`, `kd alias`, `kd use`, `kd ns`, `kd aws link`, always with a backup | AWS screen, always with a backup |

How the web backend holds it:

- a **verb allowlist** for kubectl (`get`, `describe`, `top`, `events`, `logs`, `auth can-i/whoami`,
  `explain`, `version`, `api-resources`, `cluster-info`, `config get-contexts/view/current-context`);
- arguments with `;`, `|`, `$(`, `&&`, `>`, `<` or a backtick are refused before kubectl, and nothing
  ever goes through a shell;
- **Secret values never leave the cluster**: the screen shows only the key names;
- it listens on `127.0.0.1` only.

`kd ui` opens k9s with `--readonly`, so delete, edit and scale are off there too.
Need to write to a cluster? Use `kubectl` directly, on purpose, outside this tool.

## Architecture

```
bin/kd  ──────────────► kubectl ──► cluster        (CLI: bash + jq)
browser ─► server/kube_deck.py ─► kubectl / aws    (web: allowlist, SSE logs, WebSocket + PTY shell)
           └─ serves ui/dist (React + Vite build)
tray_icon.py ─► ./run.sh --no-browser               (top bar icon: on/off, open, log)
```

- `server/kube_deck.py`: one file, standard library only. Routes `GET /api/*` return JSON and carry
  `_cmds` (the equivalent shell commands); `/api/logs` and `/api/aws/login` stream Server-Sent
  Events; `/api/terminal` is a hand-written WebSocket over a PTY. Hard failures (expired credential,
  unreachable apiserver) are cached for 12 s per context so a screen does not wait N timeouts; a 403
  is a valid answer and never enters that cache.
- `ui/`: React 19 + Vite, xterm.js for the shell, `i18n.js` with English as the key and a `PT_BR` map.

## Project layout

```
bin/kd                    the CLI
server/kube_deck.py       the web backend
ui/                       the React interface (src/, vitest tests next to the code)
tray_icon.py              the top bar icon
run.sh                    starts the web interface
install.sh                tools + kd link + k9s config
k9s/                      read-only k9s plugins and aliases
tests/                    pytest, the CLI safety test, fixtures, fake kubectl/aws, e2e/
run-tests.sh              every test layer, same as the CI
pyproject.toml, uv.lock   dev tools (pytest, ruff); requirements-dev.txt exported from it
package.json              Playwright for the E2E
VERSION                   the release version
```

## Dependencies

- **Runtime:** `kubectl`, `jq`, `python3` (standard library only), and for the web interface Node 18+
  to build it once. Optional: `aws` CLI v2 (EKS), `k9s`, `stern`, `fzf`, `kubectx`.
- **Dev:** pytest, pytest-cov and ruff, pinned in `uv.lock`; vitest in `ui/package-lock.json`;
  Playwright in `package-lock.json`.

## Settings

| Variable | Default | What |
|---|---|---|
| `KD_PORT` | `8899` | port of the web interface (`./run.sh 9000` also works) |
| `KD_LANG` | system language | `en` or `pt-BR` for the top bar icon menu |
| `KUBECONFIG` | `~/.kube/config` | the first path is the one `kd add` writes |
| `XDG_CONFIG_HOME` | `~/.config` | where `devkit-kube-deck/profiles.json` lives |

## Limitations

- No Helm, CVE scan, GitOps, metrics history (Prometheus) or team sharing. Each has its own tool.
- The EKS paste flow is tested against fakes; the happy path of `aws eks update-kubeconfig` needs a
  real cluster to be exercised end to end.
- The top bar icon needs a GNOME session with the AppIndicator extension (Ubuntu ships it).

## License

[MIT](LICENSE)
