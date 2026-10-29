#!/usr/bin/env bash
# Kube Deck installer. No sudo, nothing system-wide: everything goes to ~/.local/bin and
# ~/.config. Safe to run again, it is idempotent.
#
#   ./install.sh    installs kubectl, jq, k9s, stern and fzf when missing, links kd and the k9s config
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64) ARCH=amd64; ARCH_ALT=x86_64 ;;
  aarch64|arm64) ARCH=arm64; ARCH_ALT=arm64 ;;
  *) echo "unsupported architecture: $ARCH_RAW" >&2; exit 1 ;;
esac

mkdir -p "$BIN" "$CFG/devkit-kube-deck" "$CFG/k9s"

ok()   { printf '\e[32m✓\e[0m %s\n' "$*"; }
info() { printf '\e[2m·\e[0m %s\n' "$*"; }
has()  { command -v "$1" >/dev/null 2>&1; }

latest_tag() { curl -fsSL "https://api.github.com/repos/$1/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4; }

fetch_tgz() { # fetch_tgz <url> <binary-inside-the-tar> <destination>
  local url="$1" target="$2" dest="$3" tmp
  tmp=$(mktemp -d)
  curl -fsSL "$url" -o "$tmp/pkg.tgz"
  tar xzf "$tmp/pkg.tgz" -C "$tmp"
  install -m755 "$tmp/$target" "$BIN/$dest"
  rm -rf "$tmp"
}

# old trash goes to ./trash, never deleted
to_trash() { mkdir -p "$ROOT/trash"; mv "$1" "$ROOT/trash/$(basename "$(dirname "$1")")-$(basename "$1")"; }

# ---------------------------------------------------------------- kubectl
if ! has kubectl; then
  info "installing kubectl"
  v=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
  curl -fsSL "https://dl.k8s.io/release/$v/bin/linux/$ARCH/kubectl" -o "$BIN/kubectl"
  chmod +x "$BIN/kubectl"
  ok "kubectl $v"
else
  ok "kubectl already there"
fi

# ---------------------------------------------------------------- jq (required)
if ! has jq; then
  info "installing jq"
  curl -fsSL "https://github.com/jqlang/jq/releases/latest/download/jq-linux-$ARCH" -o "$BIN/jq"
  chmod +x "$BIN/jq"
  ok "jq"
else
  ok "jq already there"
fi

# ---------------------------------------------------------------- k9s, stern, fzf (optional)
if ! has k9s; then
  info "installing k9s"
  t=$(latest_tag derailed/k9s)
  fetch_tgz "https://github.com/derailed/k9s/releases/download/$t/k9s_Linux_$ARCH.tar.gz" k9s k9s
  ok "k9s $t"
else ok "k9s already there"; fi

if ! has stern; then
  info "installing stern"
  t=$(latest_tag stern/stern); tn=${t#v}
  fetch_tgz "https://github.com/stern/stern/releases/download/$t/stern_${tn}_linux_$ARCH.tar.gz" stern stern
  ok "stern $t"
else ok "stern already there"; fi

if ! has fzf; then
  info "installing fzf"
  t=$(latest_tag junegunn/fzf); tn=${t#v}
  fetch_tgz "https://github.com/junegunn/fzf/releases/download/$t/fzf-${tn}-linux_$ARCH.tar.gz" fzf fzf
  ok "fzf $t"
else ok "fzf already there"; fi

for prog in kubectx kubens; do
  if ! has "$prog"; then
    info "installing $prog"
    t=$(latest_tag ahmetb/kubectx)
    fetch_tgz "https://github.com/ahmetb/kubectx/releases/download/$t/${prog}_${t}_linux_${ARCH_ALT}.tar.gz" "$prog" "$prog" || true
  fi
done

# ---------------------------------------------------------------- kd
# the link of the old name (kl -> .../bin/kl) is dead after the rename
if [ -L "$BIN/kl" ] && [[ "$(readlink "$BIN/kl")" == */bin/kl ]]; then
  to_trash "$BIN/kl"
  info "old kl link moved to $ROOT/trash/"
fi
ln -sf "$ROOT/bin/kd" "$BIN/kd"
ok "kd -> $ROOT/bin/kd"

# ---------------------------------------------------------------- k9s config
for f in plugins.yaml aliases.yaml; do
  if [ -f "$CFG/k9s/$f" ] && ! cmp -s "$ROOT/k9s/$f" "$CFG/k9s/$f"; then
    cp "$CFG/k9s/$f" "$CFG/k9s/$f.bak-$(date +%Y%m%d-%H%M%S)"
    info "old k9s config saved as $f.bak-*"
  fi
  cp "$ROOT/k9s/$f" "$CFG/k9s/$f"
done
ok "k9s config in $CFG/k9s"

# ---------------------------------------------------------------- PATH
case ":$PATH:" in
  *":$BIN:"*) ok "$BIN is in the PATH" ;;
  *) printf '\e[33m!\e[0m add to ~/.bashrc:  export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac

cat <<TXT

ready. Quick start:

  kd add ~/Downloads/kubeconfig.yaml --alias staging
  kd use staging
  kd map
  kd web       # the interface in the browser

optional, shows cluster and namespace in the prompt (paste into ~/.bashrc):

  kd_ps1() { local c n; c=\$(kubectl config current-context 2>/dev/null) || return
             n=\$(kubectl config view --minify -o jsonpath='{..namespace}' 2>/dev/null)
             printf '\\[\\e[36m\\](%s|%s)\\[\\e[0m\\] ' "\$c" "\${n:-default}"; }
  PS1='\$(kd_ps1)'\$PS1

TXT
