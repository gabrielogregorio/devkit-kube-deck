# Changelog

What changed and **why**. Releases from 2.0.0 on also get notes on GitHub (`create-tag-and-release.yml`).

## 2.0.0 - 2026-10-28

Renamed from kubelente (`kl`) to **Kube Deck** (`kd`, repo `devkit-kube-deck`), everything in English,
with the same CI, tests and release flow as the other devkit projects.

### One safety model on every cluster

The old model split clusters into "local lab" (writes allowed) and "real" (read-only, exit 3),
plus a `KL_TERMINAL` policy for the pod shell guessed from the context name (`prod`, `prd`).
A name is a weak signal, and a tool that writes in the lab teaches hands to write. Now:

- every command and screen **reads**, on any cluster;
- the **pod shell** is the only thing that runs inside a cluster, and it **asks first**: the web
  shows a confirmation dialog and the backend answers 403 without `confirm=1`; `kd sh` needs `yes`
  typed at an interactive terminal and refuses without one;
- `restart`, `scale` and `kill` are **gone**, and the `kubectl debug` fallback of `kl sh` too.
  `kd delete`, `kd scale` & co. print that they do not exist;
- `kd ui` starts k9s with `--readonly`;
- the leftover-pods notice no longer shows a delete command to copy.

### Also

- The web API and its JSON are English (`/api/network`, `/api/events`, `/api/access`, `name`,
  `state`, `error`/`hint`...). The UI has i18n: English and Brazilian Portuguese.
- `kd aws vincular`/`desvincular` became `kd aws link`/`unlink`; `kl mapa` became `kd map`.
- Config moved to `~/.config/devkit-kube-deck/profiles.json`; the old `perfis.json` is read once.
- `kd info`, `kd log` & co. stopped with an empty pod name when no pod matched; now they exit 1.
- Tests: pytest with a 100% coverage gate on the server, a CLI safety test, vitest for the UI and
  Playwright against the real server, all on a fake kubectl and a fake HOME.

## 1.x - 2026-08-12 to 2026-10-28

- First version: the `kl` CLI (add with clash detection and short aliases, map, pods, info, log,
  console) and a read-only web interface over kubectl with a verb allowlist.
- The pod terminal on the web (xterm.js over a PTY and a hand-written WebSocket).
- AWS credentials per cluster: profile links, SSO login with live output, paste parser for the
  console credentials and `aws eks update-kubeconfig`.
- Hard-failure cache per cluster (an expired credential no longer freezes every panel), quiet
  `BrokenPipe`, RBAC-aware screens that show what was denied instead of failing whole.
- Own top bar icon (`tray_icon.py`) that turns the web interface on and off.
