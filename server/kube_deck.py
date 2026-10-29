#!/usr/bin/env python3
"""
Kube Deck web - backend that is safe by design.

Project rules:
  - Standard library only. No pip install to run it.
  - Every cluster access goes through kubectl with a STRICT verb allowlist.
    No route of this server can create, edit, scale, restart or delete anything
    inside a cluster.
  - The pod terminal (kubectl exec) is the only route that runs a process inside a
    cluster, and it only opens after an explicit confirmation from the user.
  - It writes only to the user's local files, always with a backup first:
    ~/.aws/credentials (aws/keys route) and ~/.kube/config (aws/kubeconfig route).
    Neither touches any resource of the cluster.
  - Never uses shell=True. Arguments go as a list.
  - Listens on 127.0.0.1 only.
  - Never returns a Secret value. Only the key names.
"""
import base64
import configparser
import fcntl
import hashlib
import json
import os
import pty
import re
import select
import shlex
import shutil
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "ui" / "dist"
DEFAULT_PORT = 8899
TIMEOUT = 30
CACHE_TTL = 8.0

# verbs the server accepts to run. Anything else is refused.
ALLOWED_VERBS = {
    "get", "describe", "top", "events", "api-resources",
    "cluster-info", "version", "auth", "explain", "logs", "config",
}
# config subcommands that only read
ALLOWED_CONFIG = {"get-contexts", "view", "current-context"}
ALLOWED_AUTH = {"can-i", "whoami"}
SUSPICIOUS = ("`", "$(", "&&", "||", ";", "|", ">", "<")

KUBECTL = shutil.which("kubectl") or "/usr/bin/kubectl"
AWS = shutil.which("aws")
AWS_DIR = Path.home() / ".aws"
CONFIG_HOME = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
CONFIG_DIR = CONFIG_HOME / "devkit-kube-deck"
PROFILE_MAP = CONFIG_DIR / "profiles.json"
# file of the old name of the project, read once while the new one does not exist
LEGACY_PROFILE_MAP = CONFIG_HOME / "kubelente" / "perfis.json"
RE_PROFILE = re.compile(r"^[A-Za-z0-9._@-]{1,64}$")
RE_ACCOUNT = re.compile(r"(?:^|\D)(\d{12})(?!\d)")
# validation of the `aws eks update-kubeconfig` arguments (it writes the local
# ~/.kube/config, never the cluster - see add_kubeconfig)
RE_REGION = re.compile(r"^[a-z]{2}(-[a-z]+){1,2}-\d{1,2}$")
RE_CLUSTER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$")
RE_ROLE = re.compile(r"^arn:aws[a-z-]*:iam::\d{12}:role/[A-Za-z0-9+=,.@_/-]{1,200}$")
RE_ALIAS = re.compile(r"^[A-Za-z0-9._@:/-]{1,120}$")
RE_ACCESS_KEY = re.compile(r"^[A-Z0-9]{16,32}$")
KUBECONFIG = Path((os.environ.get("KUBECONFIG") or "").split(":")[0]
                  or (Path.home() / ".kube" / "config"))
BACKUP_DIR = Path.home() / ".kube" / "kube-deck-backups"
AWS_ENV_KEYS = ("AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")

# a cluster running on this machine: k3d, kind, minikube, docker desktop. Shown as info only.
RE_LOCAL_CTX = re.compile(r"^(k3d-|kind-|minikube|docker-desktop|rancher-desktop)")
RE_LOCAL_SERVER = re.compile(r"127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]")
# k8s object name (RFC 1123). Used for ns, pod and container.
RE_K8S_NAME = re.compile(r"^[a-z0-9]([-a-z0-9.]{0,251})$")
WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_cache = {}
_cache_lock = threading.Lock()
_state = {"context": None}
# recent "hard" failure per context (expired credential, unreachable cluster).
# A screen fires several calls at once; without this each one waits the whole
# timeout and the interface hangs for minutes repeating the same error.
_failures = {}
FAILURE_TTL = 12.0

# commands run by the current request, so the UI can show them for copying
_local = threading.local()


def clear_caches():
    """Reset the data and failure caches. Call it whenever the credential or the
    context changes, or the old error outlives the fix."""
    with _cache_lock:
        _cache.clear()
        _failures.clear()


def record_cmd(parts):
    if not hasattr(_local, "cmds"):
        _local.cmds = []
    line = shlex.join(parts)
    if line not in _local.cmds:
        _local.cmds.append(line)


def current_cmds():
    return list(getattr(_local, "cmds", []))


# --------------------------------------------------------------- kubectl
class KubectlError(Exception):
    def __init__(self, msg, hint=""):
        super().__init__(msg)
        self.msg = msg
        self.hint = hint


def explain_error(txt, ctx=None):
    t = txt.lower()
    profile = profile_of_ctx(ctx) if ctx else ""
    if "token has expired" in t or re.search(r"\bsso\b", t):
        if profile:
            return (f"The SSO session of profile '{profile}' expired. Open AWS credentials and "
                    f"click 'SSO login', or run: aws sso login --profile {profile}")
        return "SSO session expired. Log in under AWS credentials, or run: aws sso login --profile <profile>"
    if "nocredentials" in t or "unable to locate credentials" in t:
        if not profile:
            return ("This cluster has no AWS profile linked and there is no credential in the "
                    "environment. Open AWS credentials and link the profile of the right account.")
        return f"Profile '{profile}' has no valid credential. Do the SSO login under AWS credentials."
    if "expiredtoken" in t or "getting credentials" in t:
        return "The cloud credential is missing or expired. Fix it under AWS credentials."
    if "no such host" in t or "i/o timeout" in t or "connection refused" in t:
        return "The apiserver does not answer from here. Check the network or VPN."
    if "unauthorized" in t:
        return "Your user is not authenticated on this cluster."
    if "forbidden" in t:
        found = re.search(r'"?([a-z0-9.-]+)"? is forbidden', txt)
        target = found.group(1) if found else "this resource"
        scope = " at cluster scope" if "cluster scope" in t else ""
        return (f"Authenticated, but RBAC does not allow reading {target}{scope}. "
                f"This is NOT a credential problem: your login is valid. "
                f"See Access and RBAC for what your user can do.")
    if "not found" in t:
        return "Resource not found."
    return ""


def hard_failure(msg, hint=""):
    """An error that is pointless to retry right now: expired credential or an
    unreachable apiserver. Missing RBAC does NOT count - that is a valid answer."""
    t = f"{msg} {hint}".lower()
    # 403 is a valid answer of the cluster, not a connection failure. It must come
    # first: the RBAC hint itself mentions credentials ("NOT a credential problem"),
    # and without this exit a denied resource poisoned the failure cache and took
    # down every other screen of the same cluster.
    if "forbidden" in t or "rbac does not allow" in t:
        return False
    return bool(re.search(r"\bsso\b", t)) or any(s in t for s in (
        "getting credentials", "expiredtoken", "token has expired",
        "unable to locate credentials", "nocredentials", "you must be logged in",
        "took too long", "no such host", "i/o timeout", "connection refused",
        "cloud credential", "does not answer from here"))


def check_args(args):
    """Raise KubectlError when the kubectl call is not on the allowlist."""
    if not args:
        raise KubectlError("empty command")
    verb = args[0]
    if verb not in ALLOWED_VERBS:
        raise KubectlError(f"blocked verb: {verb}")
    if verb == "config" and (len(args) < 2 or args[1] not in ALLOWED_CONFIG):
        raise KubectlError("blocked config subcommand")
    if verb == "auth" and (len(args) < 2 or args[1] not in ALLOWED_AUTH):
        raise KubectlError("blocked auth subcommand")
    for a in args:
        if not isinstance(a, str):
            raise KubectlError("invalid argument")
        # no redirection or chaining; we do not use a shell, this is belt and braces
        if any(c in a for c in SUSPICIOUS):
            raise KubectlError("suspicious argument refused")
    return verb


def kubectl(args, ctx=None, timeout=TIMEOUT):
    """Run kubectl through the allowlist. Returns stdout as text."""
    verb = check_args(args)
    cmd = [KUBECTL]
    if ctx:
        cmd += ["--context", ctx]
    cmd += ["--request-timeout", f"{timeout - 5}s"] if verb != "logs" else []
    cmd += args
    record_cmd(["kubectl"] + cmd[1:])

    # did the cluster just fail on credential/network? there is no point in every
    # panel of the screen spending 30 s more to get the same error. `config` reads a
    # local file, it always goes through.
    key = ctx or ""
    if verb != "config":
        with _cache_lock:
            f = _failures.get(key)
            if f and time.time() - f[0] < FAILURE_TTL:
                raise KubectlError(f[1], f[2])

    def note(msg, hint):
        if verb != "config" and hard_failure(msg, hint):
            with _cache_lock:
                _failures[key] = (time.time(), msg, hint)

    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           env=env_of_ctx(ctx))
    except subprocess.TimeoutExpired:
        note("kubectl took too long and was stopped", "slow or unreachable cluster")
        raise KubectlError("kubectl took too long and was stopped",
                           "slow or unreachable cluster") from None
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "").strip()
        msg, hint = (err.splitlines()[-1] if err else "kubectl failed"), explain_error(err, ctx)
        note(msg, hint)
        raise KubectlError(msg, hint)
    with _cache_lock:
        _failures.pop(key, None)          # it answers again
    return p.stdout


def kubectl_raw(args):
    """kubectl without the allowlist, used only to read the local kubeconfig."""
    if not args or args[0] != "config" or len(args) < 2 or args[1] not in ALLOWED_CONFIG:
        raise KubectlError("kubectl_raw only reads the local kubeconfig")
    record_cmd(["kubectl"] + args)
    p = subprocess.run([KUBECTL] + args, capture_output=True, text=True, timeout=20)
    if p.returncode != 0:
        raise KubectlError(((p.stderr or "").strip() or "kubectl failed").splitlines()[-1])
    return p.stdout


# =====================================================================
# AWS credentials: one profile per cluster, independent of what is exported
# =====================================================================
def _ini(path):
    c = configparser.ConfigParser()
    try:
        c.read(path)
    except configparser.Error:
        pass
    return c


def aws_profiles():
    """Read ~/.aws/config and ~/.aws/credentials. NEVER returns a key value."""
    out = {}
    cfg = _ini(AWS_DIR / "config")
    for sec in cfg.sections():
        if sec.startswith("profile "):
            name = sec[8:]
        elif sec == "default":
            name = "default"
        else:
            continue  # sso-session and the like
        d = cfg[sec]
        out[name] = {
            "name": name,
            "type": "sso" if (d.get("sso_session") or d.get("sso_start_url")) else "static",
            "account": d.get("sso_account_id", ""),
            "role": d.get("sso_role_name", ""),
            "region": d.get("region", ""),
            "sso_session": d.get("sso_session", ""),
            "source": "config",
        }
    cred = _ini(AWS_DIR / "credentials")
    for sec in cred.sections():
        p = out.setdefault(sec, {"name": sec, "type": "static", "account": "",
                                 "role": "", "region": "", "sso_session": "", "source": ""})
        p["type"] = "static"
        p["source"] = (p["source"] + "+credentials").strip("+")
        p["has_key"] = bool(cred[sec].get("aws_access_key_id"))
    return out


def load_map():
    for path in (PROFILE_MAP, LEGACY_PROFILE_MAP):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        return data if isinstance(data, dict) else {}
    return {}


def save_map(m):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    PROFILE_MAP.write_text(json.dumps(m, indent=2, ensure_ascii=False))
    os.chmod(PROFILE_MAP, 0o600)


def context_info():
    """For each context: whether it uses aws, which account, which profile is linked."""
    data = json.loads(kubectl_raw(["config", "view", "-o", "json"]))
    users = {u["name"]: u.get("user", {}) for u in data.get("users") or []}
    links = load_map()
    profiles = aws_profiles()
    out = []
    for c in data.get("contexts") or []:
        name = c["name"]
        u = users.get(c["context"].get("user"), {})
        ex = u.get("exec") or {}
        uses_aws = ex.get("command") == "aws"
        text = " ".join([name, c["context"].get("cluster", "")] + (ex.get("args") or []))
        found = RE_ACCOUNT.search(text)
        account = found.group(1) if found else ""
        # profile already pinned inside the kubeconfig itself?
        in_kubeconfig = ""
        for e in ex.get("env") or []:
            if e.get("name") == "AWS_PROFILE":
                in_kubeconfig = e.get("value", "")
        # a profile with a named sso_session and a short name tends to be the "real" one;
        # the ones generated by Identity Center (account_role) come after
        suggested = [p["name"] for p in sorted(
            [p for p in profiles.values() if account and p.get("account") == account],
            key=lambda p: (not p.get("sso_session"), p["name"].startswith(account), len(p["name"])))]
        out.append({
            "context": name,
            "cluster": c["context"].get("cluster", ""),
            "uses_aws": uses_aws,
            "account": account,
            "role": next((a for a in (ex.get("args") or []) if a.startswith("arn:aws:iam::")), ""),
            "profile": links.get(name, "") or in_kubeconfig,
            "profile_source": "kube-deck" if links.get(name) else ("kubeconfig" if in_kubeconfig else ""),
            "suggested": suggested,
        })
    return out


def profile_of_ctx(ctx):
    if not ctx:
        return ""
    return load_map().get(ctx, "")


def env_of_ctx(ctx):
    """Subprocess environment with the AWS_PROFILE of the cluster, when one is linked."""
    env = os.environ.copy()
    p = profile_of_ctx(ctx)
    if p:
        env["AWS_PROFILE"] = p
        # the linked profile wins; a loose credential in the shell must not
        for k in AWS_ENV_KEYS[1:]:
            env.pop(k, None)
    return env


def clean_aws_env():
    env = os.environ.copy()
    for k in AWS_ENV_KEYS:
        env.pop(k, None)
    return env


def aws_cmd(args, profile=None, timeout=25):
    """Run the aws CLI through a narrow allowlist. No free verbs."""
    if not AWS:
        raise KubectlError("aws CLI not found in PATH")
    allowed = (("sts", "get-caller-identity"), ("sso", "login"), ("sso", "logout"),
               ("configure", "list-profiles"), ("eks", "update-kubeconfig"))
    if tuple(args[:2]) not in allowed:
        raise KubectlError(f"blocked aws command: {' '.join(args[:2])}")
    if profile and not RE_PROFILE.match(profile):
        raise KubectlError("invalid profile name")
    cmd = [AWS] + list(args) + (["--profile", profile] if profile else [])
    record_cmd(["aws"] + cmd[1:])
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=clean_aws_env())


def profile_status(profile):
    """Is the session of this profile valid right now?"""
    try:
        p = aws_cmd(["sts", "get-caller-identity", "--output", "json"], profile=profile, timeout=20)
    except (KubectlError, OSError, subprocess.TimeoutExpired) as e:
        return {"valid": False, "reason": getattr(e, "msg", str(e))}
    if p.returncode == 0:
        try:
            d = json.loads(p.stdout)
        except ValueError:
            d = {}
        return {"valid": True, "account": d.get("Account", ""), "arn": d.get("Arn", "")}
    txt = (p.stderr or p.stdout or "").strip()
    low = txt.lower()
    if "could not be found" in low or "not found" in low:
        reason = "profile does not exist in ~/.aws/config"
    elif "sso" in low or "expired" in low or "token" in low:
        reason = "SSO session expired or never started"
    else:
        reason = txt.splitlines()[-1][:160] if txt else "failed"
    return {"valid": False, "reason": reason}


def write_ini_section(path, section, fields, remove=()):
    """Edit one section of an .ini file KEEPING the rest of the file byte for byte.

    configparser.write() rewrites everything and **drops comments and formatting** -
    that once cost all the comments of a user's ~/.aws/credentials.
    Here only the target section is touched.
    """
    text = path.read_text() if path.exists() else ""
    lines = text.splitlines()
    target = f"[{section}]"
    start = next((i for i, line in enumerate(lines) if line.strip() == target), None)

    if start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(target)
        lines += [f"{k} = {v}" for k, v in fields.items()]
        lines.append("")
    else:
        end = len(lines)
        for j in range(start + 1, len(lines)):
            if lines[j].lstrip().startswith("["):
                end = j
                break
        body, seen = [], set()
        for line in lines[start + 1:end]:
            bare = line.strip()
            key = (bare.split("=", 1)[0].strip().lower()
                   if "=" in bare and not bare.startswith(("#", ";")) else None)
            if key in fields:
                body.append(f"{key} = {fields[key]}")
                seen.add(key)
            elif key in remove:
                continue                      # the obsolete key goes away
            else:
                body.append(line)             # comments and the rest stay intact
        body += [f"{k} = {v}" for k, v in fields.items() if k not in seen]
        lines[start + 1:end] = body

    path.write_text("\n".join(lines).rstrip("\n") + "\n")
    os.chmod(path, 0o600)


def save_keys(profile, access_key, secret_key, session_token="", region=""):
    """Write static keys to ~/.aws/credentials. Never logs the value."""
    if not RE_PROFILE.match(profile or ""):
        raise KubectlError("invalid profile name (use letters, digits, dot, dash)")
    if not access_key or not secret_key:
        raise KubectlError("access key and secret key are required")
    if not RE_ACCESS_KEY.match(access_key.strip()):
        raise KubectlError("the access key id does not have the expected format (AKIA... or ASIA...)")
    path = AWS_DIR / "credentials"
    AWS_DIR.mkdir(mode=0o700, exist_ok=True)
    if path.exists():
        bkp = path.with_name(f"credentials.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(path, bkp)
        os.chmod(bkp, 0o600)
    fields = {"aws_access_key_id": access_key.strip(),
              "aws_secret_access_key": secret_key.strip()}
    if session_token.strip():
        fields["aws_session_token"] = session_token.strip()
    write_ini_section(path, profile, fields,
                      remove=() if session_token.strip() else ("aws_session_token",))
    if region.strip():
        sec = "default" if profile == "default" else f"profile {profile}"
        write_ini_section(AWS_DIR / "config", sec, {"region": region.strip()})
    return {"ok": True, "profile": profile}


def link_profile(ctx, profile):
    """Bind the profile to the cluster of the context, for EVERY context of the same
    cluster (the long ARN and the short alias point to the same place; linking only
    one would leave the other picking a loose credential from the shell)."""
    m = load_map()
    infos = context_info()
    cluster = next((c["cluster"] for c in infos if c["context"] == ctx), None)
    targets = [c["context"] for c in infos if cluster and c["cluster"] == cluster] or [ctx]
    for t in targets:
        if profile:
            m[t] = profile
        else:
            m.pop(t, None)                    # unlink
    save_map(m)
    return targets


def backup_kubeconfig():
    if not KUBECONFIG.exists():
        return ""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    target = BACKUP_DIR / f"config-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(KUBECONFIG, target)
    os.chmod(target, 0o600)
    return str(target)


def add_kubeconfig(name, region, role_arn="", profile="", alias=""):
    """Register an EKS cluster in ~/.kube/config through `aws eks update-kubeconfig`.

    THIS DOES NOT WRITE TO THE CLUSTER. `update-kubeconfig` only touches the local
    ~/.kube/config file - the same kind of operation as `kd add`. No mutating kubectl
    verb is allowed, and `--role-arn` only says which role to assume; what it may do
    is decided by the RBAC of the cluster.

    Every argument is validated by format and goes as a list item (never a shell),
    so `;`, `$(` and the like cannot escape into a command.
    """
    name, region = (name or "").strip(), (region or "").strip()
    role_arn, profile, alias = (role_arn or "").strip(), (profile or "").strip(), (alias or "").strip()
    if not RE_CLUSTER.match(name):
        raise KubectlError("invalid cluster name")
    if not RE_REGION.match(region):
        raise KubectlError(f"invalid region: {region!r} (expected something like us-west-2)")
    if role_arn and not RE_ROLE.match(role_arn):
        raise KubectlError("invalid role-arn (expected arn:aws:iam::<12 digits>:role/<name>)")
    if profile and not RE_PROFILE.match(profile):
        raise KubectlError("invalid profile name")
    if alias and not RE_ALIAS.match(alias):
        raise KubectlError("invalid alias")

    bkp = backup_kubeconfig()
    args = ["eks", "update-kubeconfig", "--region", region, "--name", name]
    if role_arn:
        args += ["--role-arn", role_arn]
    if alias:
        args += ["--alias", alias]
    p = aws_cmd(args, profile=profile or None, timeout=60)
    output = ((p.stdout or "") + (p.stderr or "")).strip()
    if p.returncode != 0:
        line = output.splitlines()[-1] if output else "aws eks update-kubeconfig failed"
        raise KubectlError(line[:300], "Check the cluster name, the region and whether the "
                                       "credential of this profile is valid ('test' button).")

    # "Added new context X to /home/.../config" or "Updated context X in /home/.../config"
    found = re.search(r"context (\S+) (?:to|in) ", output)
    ctx = found.group(1) if found else alias

    linked = []
    clear_caches()
    if ctx and profile:
        # without this the generated kubeconfig would pick the loose AWS_PROFILE of
        # the shell - exactly the dev/prod mix-up this tool exists to kill
        try:
            linked = link_profile(ctx, profile)
        except (KubectlError, OSError, ValueError):
            linked = []
    return {"ok": True, "context": ctx, "output": output[:500], "backup": bkp,
            "linked": linked, "profile": profile}


# =====================================================================
# pod terminal: WebSocket + PTY
#
# THIS IS THE ONLY ROUTE OF THE SERVER THAT RUNS A PROCESS INSIDE A CLUSTER.
# It opens on any cluster, but only with confirm=1, which the UI sends after the
# user accepts the confirmation dialog. What the shell can do inside the pod is up
# to the RBAC of the cluster: without `pods/exec`, kubectl refuses on the other side.
# =====================================================================
def is_local(name, server):
    return bool(RE_LOCAL_SERVER.search(server or "")) or bool(RE_LOCAL_CTX.match(name or ""))


def ws_frame(data, opcode=0x2):
    n = len(data)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack(">H", n)
    else:
        head += bytes([127]) + struct.pack(">Q", n)
    return head + data


def ws_read(rf):
    """Read one client frame. Returns (opcode, payload); (None, None) when closed."""
    try:
        head = rf.read(2)
        if not head or len(head) < 2:
            return None, None
        op = head[0] & 0x0F
        masked = head[1] & 0x80
        n = head[1] & 0x7F
        if n == 126:
            n = struct.unpack(">H", rf.read(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", rf.read(8))[0]
        if n > 4 * 1024 * 1024:          # absurd frame: drop it instead of allocating
            return None, None
        key = rf.read(4) if masked else b""
        data = rf.read(n) if n else b""
        if masked and data:
            data = bytes(b ^ key[i % 4] for i, b in enumerate(data))
        return op, data
    except (OSError, struct.error, IndexError):
        return None, None


def resize(fd, cols, rows):
    try:
        cols = max(2, min(int(cols), 500))
        rows = max(2, min(int(rows), 300))
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except (OSError, ValueError, TypeError):
        pass


def kjson(args, ctx=None, timeout=TIMEOUT):
    out = kubectl(args + ["-o", "json"], ctx=ctx, timeout=timeout)
    return json.loads(out) if out.strip() else {}


def collector():
    """Return (attempt, denied). A resource denied by RBAC must not take the whole
    screen down: restricted read profiles (common in production) do not see nodes,
    secrets or pv, but they see pods and workloads - and that is what the person
    opened the tool to look at. An error that is NOT a 403 still goes up."""
    denied = []

    def attempt(label, fn, default):
        try:
            return fn()
        except KubectlError as e:
            low = f"{e.msg} {e.hint}".lower()
            if "forbidden" in low or "rbac" in low:
                denied.append({"resource": label, "reason": e.hint or e.msg})
                return default
            raise

    return attempt, denied


def cached(key, fn, ttl=CACHE_TTL):
    now = time.time()
    with _cache_lock:
        v = _cache.get(key)
        if v and now - v[0] < ttl:
            for c in v[2]:            # show again the commands that produced the data
                record_cmd(shlex.split(c))
            return v[1]
    mark = len(current_cmds())
    data = fn()
    new = current_cmds()[mark:]
    with _cache_lock:
        _cache[key] = (now, data, new)
    return data


# --------------------------------------------------------------- helpers
def age(ts):
    if not ts:
        return ""
    try:
        t = time.mktime(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")) - time.timezone
    except (ValueError, TypeError):
        return ""
    s = int(time.time() - t)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def pod_state(p):
    st = p.get("status", {})
    if p.get("metadata", {}).get("deletionTimestamp"):
        return "Terminating"
    for cs in st.get("containerStatuses") or []:
        if cs.get("ready"):
            continue
        for v in (cs.get("state") or {}).values():
            r = v.get("reason")
            if r:
                return r
    return st.get("phase", "?")


def summarize_pod(p):
    st = p.get("status", {})
    css = st.get("containerStatuses") or []
    ready = sum(1 for c in css if c.get("ready"))
    containers = p.get("spec", {}).get("containers") or []
    total = len(containers)
    phase = st.get("phase", "?")
    # terminal phase = the containers are already dead. The scheduler ignores these
    # pods when it sums the requests of the node, so they do NOT reserve cpu or memory.
    terminal = phase in ("Failed", "Succeeded")
    return {
        "ns": p["metadata"]["namespace"],
        "name": p["metadata"]["name"],
        "ready": ready,
        "total": total,
        "state": pod_state(p),
        "phase": phase,
        "terminal": terminal,
        "leftover": phase == "Failed",   # dead and not cleaned: it only takes etcd and your attention
        "end_reason": st.get("reason", ""),
        "end_message": st.get("message", ""),
        "restarts": sum(c.get("restartCount", 0) for c in css),
        "node": p.get("spec", {}).get("nodeName", "-"),
        "ip": st.get("podIP", "-"),
        "age": age(p["metadata"].get("creationTimestamp")),
        "created": p["metadata"].get("creationTimestamp"),
        "images": [c.get("image") for c in containers],
        "containers": [c.get("name") for c in containers],
        "ok": phase == "Succeeded" or (ready == total and phase == "Running"),
    }


def ns_args(ns):
    return ["-n", ns] if ns and ns != "*" else ["-A"]


# --------------------------------------------------------------- routes
def route_contexts():
    data = kjson(["config", "view"])
    current = kubectl(["config", "current-context"]).strip()
    servers = {c["name"]: (c.get("cluster") or {}).get("server", "")
               for c in data.get("clusters") or []}
    ctxs = []
    for c in data.get("contexts") or []:
        name = c["name"]
        cluster = c["context"].get("cluster", "")
        srv = servers.get(cluster, "")
        ctxs.append({
            "name": name,
            "cluster": cluster,
            "server": srv,
            "local": is_local(name, srv),
            "namespace": c["context"].get("namespace", "default"),
        })
    ctxs.sort(key=lambda x: x["name"])
    return {"contexts": ctxs, "current": _state["context"] or current,
            "kubeconfig_current": current}


def route_overview(ctx):
    def calc():
        attempt, denied = collector()
        nodes = attempt("nodes", lambda: kjson(["get", "nodes"], ctx), {"items": []})
        pods = attempt("pods", lambda: kjson(["get", "pods", "-A"], ctx), {"items": []})
        ver = attempt("version", lambda: kjson(["version"], ctx), {}) \
            .get("serverVersion", {}).get("gitVersion", "?")

        node_list = []
        for n in nodes.get("items", []):
            cond = {c["type"]: c["status"] for c in n["status"].get("conditions", [])}
            node_list.append({
                "name": n["metadata"]["name"],
                "ready": cond.get("Ready") == "True",
                "version": n["status"]["nodeInfo"]["kubeletVersion"],
                "cpu": n["status"]["capacity"]["cpu"],
                "memory": n["status"]["capacity"]["memory"],
                "cordoned": bool(n["spec"].get("unschedulable")),
                "os": n["status"]["nodeInfo"].get("osImage", ""),
                "labels": n["metadata"].get("labels", {}),
                "age": age(n["metadata"].get("creationTimestamp")),
                "created": n["metadata"].get("creationTimestamp"),
            })

        ps = [summarize_pod(p) for p in pods.get("items", [])]
        by_ns = {}
        for p in ps:
            d = by_ns.setdefault(p["ns"], {"ns": p["ns"], "pods": 0, "problems": 0,
                                           "leftovers": 0, "restarts": 0})
            d["pods"] += 1
            d["restarts"] += p["restarts"]
            if p["leftover"]:
                d["leftovers"] += 1
            elif not p["ok"]:
                d["problems"] += 1

        # what is broken NOW (uses resources) vs what is left of a dead pod
        problems = [p for p in ps if not p["ok"] and not p["terminal"]]
        leftovers = [p for p in ps if p["leftover"]]
        by_node = {}
        for p in leftovers:
            by_node[p["node"]] = by_node.get(p["node"], 0) + 1
        return {
            "server_version": ver,
            "denied": denied,
            "nodes": node_list,
            "namespaces": sorted(by_ns.values(), key=lambda x: (-x["problems"], x["ns"])),
            "pods_total": len(ps),
            "pods_ok": sum(1 for p in ps if p["ok"]),
            "pods_alive": sum(1 for p in ps if not p["terminal"]),
            "restarts_total": sum(p["restarts"] for p in ps),
            "problems": problems,
            "leftovers": leftovers,
            "leftovers_by_node": sorted(by_node.items(), key=lambda x: -x[1]),
        }
    return cached(("overview", ctx), calc)


def route_pods(ctx, ns):
    def calc():
        data = kjson(["get", "pods"] + ns_args(ns), ctx)
        return {"pods": [summarize_pod(p) for p in data.get("items", [])]}
    return cached(("pods", ctx, ns), calc)


def workload_row(it):
    kind = it.get("kind", "")
    st = it.get("status", {})
    spec = it.get("spec", {})
    if kind in ("Deployment", "StatefulSet"):
        ready = f"{st.get('readyReplicas', 0)}/{spec.get('replicas', 0)}"
        healthy = st.get("readyReplicas", 0) == (spec.get("replicas") or 0)
    elif kind == "DaemonSet":
        ready = f"{st.get('numberReady', 0)}/{st.get('desiredNumberScheduled', 0)}"
        healthy = st.get("numberReady", 0) == st.get("desiredNumberScheduled", 0)
    elif kind == "CronJob":
        ready = spec.get("schedule", "")
        healthy = not spec.get("suspend")
    else:
        ready = f"{st.get('succeeded', 0)}/{spec.get('completions', 1)}"
        healthy = bool(st.get("succeeded"))
    template = (spec.get("template", {}).get("spec", {}).get("containers")
                or spec.get("jobTemplate", {}).get("spec", {}).get("template", {})
                .get("spec", {}).get("containers") or [])
    return {
        "kind": kind,
        "ns": it["metadata"]["namespace"],
        "name": it["metadata"]["name"],
        "ready": ready,
        "healthy": healthy,
        "age": age(it["metadata"].get("creationTimestamp")),
        "images": [c.get("image") for c in template],
    }


def route_workloads(ctx, ns):
    def calc():
        kinds = ["deployments", "statefulsets", "daemonsets", "cronjobs", "jobs"]
        args_ns = ns_args(ns)
        attempt, denied = collector()
        # a `get a,b,c` fails whole if RBAC denies ONE of the kinds. Try them together
        # (1 call, the normal case) and, on a 403, redo kind by kind so we lose only
        # what the credential really cannot reach.
        try:
            data = kjson(["get", ",".join(kinds)] + args_ns, ctx)
        except KubectlError as e:
            if "forbidden" not in f"{e.msg} {e.hint}".lower():
                raise
            data = {"items": []}
            for k in kinds:
                d = attempt(k, lambda k=k: kjson(["get", k] + args_ns, ctx), {"items": []})
                data["items"] += d.get("items", [])
        out = [workload_row(it) for it in data.get("items", [])]
        out.sort(key=lambda x: (x["healthy"], x["ns"], x["name"]))
        return {"workloads": out, "denied": denied}
    return cached(("workloads", ctx, ns), calc)


def lb_address(obj):
    lb = obj.get("status", {}).get("loadBalancer", {}).get("ingress") or []
    return ", ".join(filter(None, [i.get("hostname") or i.get("ip") for i in lb]))


def route_network(ctx, ns):
    def calc():
        args_ns = ns_args(ns)
        attempt, denied = collector()
        svcs = attempt("services", lambda: kjson(["get", "services"] + args_ns, ctx),
                       {"items": []})
        try:
            ings = kjson(["get", "ingresses"] + args_ns, ctx)
        except KubectlError:
            ings = {"items": []}   # a cluster without an ingress controller lands here too
        services = []
        for s in svcs.get("items", []):
            sp = s.get("spec", {})
            services.append({
                "ns": s["metadata"]["namespace"],
                "name": s["metadata"]["name"],
                "type": sp.get("type", "ClusterIP"),
                "clusterIP": sp.get("clusterIP", ""),
                "external": lb_address(s),
                "ports": [f"{p.get('port')}{'/' + p['protocol'] if p.get('protocol') else ''}"
                          f"{'→' + str(p['nodePort']) if p.get('nodePort') else ''}"
                          for p in sp.get("ports", [])],
                "selector": sp.get("selector") or {},
            })
        ingresses = []
        for i in ings.get("items", []):
            rules = []
            for r in i.get("spec", {}).get("rules", []):
                host = r.get("host", "*")
                for pth in (r.get("http", {}) or {}).get("paths", []):
                    b = pth.get("backend", {}).get("service", {})
                    rules.append({
                        "host": host, "path": pth.get("path", "/"),
                        "service": b.get("name", ""),
                        "port": (b.get("port") or {}).get("number", ""),
                    })
            ingresses.append({
                "ns": i["metadata"]["namespace"],
                "name": i["metadata"]["name"],
                "class": i.get("spec", {}).get("ingressClassName", ""),
                "address": lb_address(i),
                "rules": rules,
                "tls": bool(i.get("spec", {}).get("tls")),
            })
        return {"services": services, "ingresses": ingresses, "denied": denied}
    return cached(("network", ctx, ns), calc)


def route_config(ctx, ns):
    """ConfigMaps and Secrets. For a Secret it returns ONLY the key names, never the value."""
    def calc():
        args_ns = ns_args(ns)
        attempt, denied = collector()
        cms = attempt("configmaps", lambda: kjson(["get", "configmaps"] + args_ns, ctx),
                      {"items": []})
        secs = attempt("secrets", lambda: kjson(["get", "secrets"] + args_ns, ctx),
                       {"items": []})
        return {
            "denied": denied,
            "configmaps": [{
                "ns": c["metadata"]["namespace"], "name": c["metadata"]["name"],
                "keys": sorted((c.get("data") or {}).keys()),
                "age": age(c["metadata"].get("creationTimestamp")),
            } for c in cms.get("items", [])],
            "secrets": [{
                "ns": s["metadata"]["namespace"], "name": s["metadata"]["name"],
                "type": s.get("type", ""),
                "keys": sorted((s.get("data") or {}).keys()),  # ONLY THE KEYS
                "age": age(s["metadata"].get("creationTimestamp")),
            } for s in secs.get("items", [])],
        }
    return cached(("config", ctx, ns), calc)


def route_storage(ctx, ns):
    def calc():
        attempt, denied = collector()
        pvcs = attempt("pvc", lambda: kjson(["get", "pvc"] + ns_args(ns), ctx), {"items": []})
        pvs = attempt("pv", lambda: kjson(["get", "pv"], ctx), {"items": []})
        return {
            "denied": denied,
            "pvcs": [{
                "ns": p["metadata"]["namespace"], "name": p["metadata"]["name"],
                "status": p.get("status", {}).get("phase", ""),
                "volume": p.get("spec", {}).get("volumeName", ""),
                "capacity": (p.get("status", {}).get("capacity") or {}).get("storage", ""),
                "class": p.get("spec", {}).get("storageClassName", ""),
                "age": age(p["metadata"].get("creationTimestamp")),
            } for p in pvcs.get("items", [])],
            "pvs": [{
                "name": p["metadata"]["name"],
                "status": p.get("status", {}).get("phase", ""),
                "capacity": (p.get("spec", {}).get("capacity") or {}).get("storage", ""),
                "class": p.get("spec", {}).get("storageClassName", ""),
                "policy": p.get("spec", {}).get("persistentVolumeReclaimPolicy", ""),
                "age": age(p["metadata"].get("creationTimestamp")),
            } for p in pvs.get("items", [])],
        }
    return cached(("storage", ctx, ns), calc)


def event_row(e):
    return {
        "type": e.get("type", ""),
        "reason": e.get("reason", ""),
        "message": e.get("message", ""),
        "count": e.get("count", 1),
        "when": e.get("lastTimestamp") or e.get("eventTime") or "",
    }


def route_events(ctx, ns):
    def calc():
        data = kjson(["get", "events"] + ns_args(ns), ctx)
        evs = []
        for e in data.get("items", []):
            obj = e.get("involvedObject", {})
            evs.append({"ns": e["metadata"].get("namespace", ""),
                        "object": f"{obj.get('kind', '')}/{obj.get('name', '')}",
                        **event_row(e)})
        evs.sort(key=lambda x: x["when"] or "", reverse=True)
        return {"events": evs[:400]}
    return cached(("events", ctx, ns), calc, ttl=5)


def route_top(ctx, ns):
    def calc():
        res = {"nodes": {}, "pods": {}}
        try:
            txt = kubectl(["top", "nodes", "--no-headers"], ctx)
            for line in txt.strip().splitlines():
                c = line.split()
                if len(c) >= 5:
                    res["nodes"][c[0]] = {"cpu": c[1], "cpu_pct": c[2], "mem": c[3], "mem_pct": c[4]}
        except KubectlError:
            pass
        try:
            txt = kubectl(["top", "pod", "--no-headers"] + ns_args(ns), ctx)
            for line in txt.strip().splitlines():
                c = line.split()
                if len(c) == 4:
                    res["pods"][f"{c[0]}/{c[1]}"] = {"cpu": c[2], "mem": c[3]}
                elif len(c) == 3:
                    res["pods"][c[0]] = {"cpu": c[1], "mem": c[2]}
        except KubectlError:
            pass
        return res
    return cached(("top", ctx, ns), calc, ttl=12)


def route_pod_detail(ctx, ns, name):
    pod = kjson(["get", "pod", name, "-n", ns], ctx)
    try:
        evs = kjson(["get", "events", "-n", ns,
                     "--field-selector", f"involvedObject.name={name}"], ctx)
        events = sorted([event_row(e) for e in evs.get("items", [])],
                        key=lambda x: x["when"] or "", reverse=True)
    except KubectlError:
        events = []
    pod.get("metadata", {}).pop("managedFields", None)
    return {"pod": pod, "summary": summarize_pod(pod), "events": events}


def route_yaml(ctx, kind, ns, name):
    args = ["get", kind, name] + (["-n", ns] if ns and ns != "*" else [])
    data = kjson(args, ctx)
    data.get("metadata", {}).pop("managedFields", None)
    return {"object": data}


def route_describe(ctx, kind, ns, name):
    args = ["describe", kind, name] + (["-n", ns] if ns and ns != "*" else [])
    return {"text": kubectl(args, ctx)}


def route_namespaces(ctx):
    def calc():
        d = kjson(["get", "namespaces"], ctx)
        return {"namespaces": [{
            "name": n["metadata"]["name"],
            "status": n.get("status", {}).get("phase", ""),
            "age": age(n["metadata"].get("creationTimestamp")),
        } for n in d.get("items", [])]}
    return cached(("ns", ctx), calc, ttl=30)


# What each screen of Kube Deck needs to read. It explains WHY a screen came back
# empty, instead of listing loose verbs.
ACCESS_CHECKS = [
    ("list", "pods", "Pods, Overview"),
    ("get", "pods/log", "Pod logs"),
    ("create", "pods/exec", "Pod terminal"),
    ("list", "nodes", "Nodes, Overview"),
    ("list", "namespaces", "Namespace picker"),
    ("list", "deployments", "Workloads"),
    ("list", "statefulsets", "Workloads"),
    ("list", "daemonsets", "Workloads"),
    ("list", "jobs", "Workloads"),
    ("list", "cronjobs", "Workloads"),
    ("list", "services", "Network"),
    ("list", "ingresses", "Network"),
    ("list", "configmaps", "Config and Secrets"),
    ("list", "secrets", "Config and Secrets"),
    ("list", "persistentvolumeclaims", "Storage"),
    ("list", "persistentvolumes", "Storage"),
    ("list", "events", "Events"),
    # writes: Kube Deck never calls them, but knowing the credential CAN changes
    # the risk reading of whoever holds this kubeconfig
    ("delete", "pods", "(write, Kube Deck never uses it)"),
    ("create", "deployments", "(write, Kube Deck never uses it)"),
]


def route_access(ctx, ns):
    """Who am I and what can I do here. Pure reading.

    The scope matters: `auth can-i` without `-n` answers for the `default` namespace,
    which misleads whoever is looking at the whole cluster. With ns=* we ask with
    --all-namespaces, which is exactly the scope the screens use."""
    def calc():
        scope = "all namespaces" if (not ns or ns == "*") else f"namespace {ns}"
        out = {"user": "?", "groups": [], "scope": scope,
               "allowed": [], "denied": [], "checks": []}
        try:
            w = kjson(["auth", "whoami"], ctx)
            info = w.get("status", {}).get("userInfo", {})
            out["user"] = info.get("username", "?")
            out["groups"] = info.get("groups", [])
        except KubectlError:
            pass
        for verb, res, screen in ACCESS_CHECKS:
            args = ["auth", "can-i", verb, res]
            args += ["-n", ns] if (ns and ns != "*") else ["--all-namespaces"]
            try:
                r = kubectl(args, ctx).strip().splitlines()[-1].strip()
            except (KubectlError, IndexError):
                r = "no"
            allowed = r == "yes"
            out["checks"].append({"verb": verb, "resource": res,
                                  "screen": screen, "allowed": allowed})
            (out["allowed"] if allowed else out["denied"]).append(f"{verb} {res}")
        return out
    return cached(("access", ctx, ns), calc, ttl=30)


def logs_command(ctx, ns, name, container, previous, tail):
    args = [KUBECTL] + (["--context", ctx] if ctx else [])
    args += ["logs", name, "-n", ns, "--tail", str(max(1, min(tail, 5000)))]
    args += ["-c", container] if container else ["--all-containers", "--prefix"]
    args += ["--previous"] if previous else ["-f"]
    return args


def terminal_command(ctx, ns, pod, container):
    cmd = [KUBECTL] + (["--context", ctx] if ctx else [])
    cmd += ["exec", "-i", "-t", "-n", ns, pod]
    if container:
        cmd += ["-c", container]
    return cmd + ["--", "sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"]


def terminal_refusal(q):
    """Why the terminal cannot open, or None. Checked before the WebSocket upgrade."""
    ctx = (q.get("ctx") or [""])[0]
    ns = (q.get("ns") or [""])[0]
    pod = (q.get("pod") or [""])[0]
    cont = (q.get("container") or [""])[0]
    if (q.get("confirm") or [""])[0] != "1":
        return 403, {"error": "the shell needs a confirmation",
                     "hint": "Opening a shell runs a process inside the cluster. Confirm it in the dialog."}
    if not (RE_K8S_NAME.match(ns) and RE_K8S_NAME.match(pod)):
        return 400, {"error": "invalid namespace or pod"}
    if cont and not RE_K8S_NAME.match(cont):
        return 400, {"error": "invalid container"}
    try:
        known = {c["name"] for c in json.loads(
            kubectl_raw(["config", "view", "-o", "json"])).get("contexts") or []}
    except (KubectlError, ValueError):
        known = set()
    if ctx and ctx not in known:
        return 400, {"error": "unknown context"}
    return None


# --------------------------------------------------------------- HTTP
def _get_routes(q, ctx, ns):
    g = lambda k, d=None: (q.get(k) or [d])[0]  # noqa: E731
    return {
        "/api/contexts": lambda: route_contexts(),
        "/api/overview": lambda: route_overview(ctx),
        "/api/pods": lambda: route_pods(ctx, ns),
        "/api/workloads": lambda: route_workloads(ctx, ns),
        "/api/network": lambda: route_network(ctx, ns),
        "/api/config": lambda: route_config(ctx, ns),
        "/api/storage": lambda: route_storage(ctx, ns),
        "/api/events": lambda: route_events(ctx, ns),
        "/api/top": lambda: route_top(ctx, ns),
        "/api/namespaces": lambda: route_namespaces(ctx),
        "/api/access": lambda: route_access(ctx, ns),
        "/api/pod": lambda: route_pod_detail(ctx, ns, g("name")),
        "/api/yaml": lambda: route_yaml(ctx, g("kind", "pod"), ns, g("name")),
        "/api/describe": lambda: route_describe(ctx, g("kind", "pod"), ns, g("name")),
        "/api/aws": lambda: {
            "contexts": context_info(),
            "profiles": sorted(aws_profiles().values(), key=lambda x: x["name"]),
            "aws_available": bool(AWS),
        },
        "/api/aws/status": lambda: profile_status(g("profile")),
        "/api/select": lambda: select_context(g("name")),
    }


def select_context(name):
    _state["context"] = name
    clear_caches()
    return {"ok": True, "context": _state["context"]}


def post_route(path, body):
    if path == "/api/aws/link":
        ctx, profile = body.get("context"), body.get("profile", "")
        if not ctx:
            return 400, {"error": "missing context"}
        if profile and not RE_PROFILE.match(profile):
            return 200, {"error": "invalid profile name"}
        targets = link_profile(ctx, profile)
        clear_caches()
        return 200, {"ok": True, "contexts": targets, "profile": profile}
    if path == "/api/aws/keys":
        r = save_keys(body.get("profile", ""), body.get("access_key", ""),
                      body.get("secret_key", ""), body.get("session_token", ""),
                      body.get("region", ""))
        clear_caches()
        return 200, r
    if path == "/api/aws/kubeconfig":
        # writes the local ~/.kube/config, NOT the cluster. See add_kubeconfig
        return 200, add_kubeconfig(body.get("name", ""), body.get("region", ""),
                                   body.get("role_arn", ""), body.get("profile", ""),
                                   body.get("alias", ""))
    return 404, {"error": "no such route"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "kube-deck"

    def log_message(self, *a):
        pass  # quiet; the terminal belongs to the user

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, dict) and "_cmds" not in body:
            c = current_cmds()
            if c:
                body = {**body, "_cmds": c}
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        else:
            body = body.encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):  # pragma: no cover - client race
            # the browser gave up before the answer (refresh, tab change, slow request
            # cancelled). Not our error, and it does not become noise.
            self.close_connection = True

    def _error(self, e):
        self._send(200, {"error": getattr(e, "msg", str(e)), "hint": getattr(e, "hint", "")})

    def do_GET(self):
        _local.cmds = []
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        g = lambda k, d=None: (q.get(k) or [d])[0]  # noqa: E731
        ctx = g("ctx") or _state["context"]
        ns = g("ns", "*")
        p = u.path
        if not p.startswith("/api/"):
            return self._static(p)
        try:
            if p == "/api/terminal":
                return self._terminal(q)
            if p == "/api/logs":
                return self._logs(ctx, ns, g("name"), g("container"),
                                  g("previous") == "1", int(g("tail", "300")))
            if p == "/api/aws/login":
                return self._sso_login(g("profile"))
            route = _get_routes(q, ctx, ns).get(p)
            if route is None:
                return self._send(404, {"error": "no such route"})
            return self._send(200, route())
        except KubectlError as e:
            return self._error(e)
        except Exception as e:  # noqa: BLE001 - the UI shows any failure as text
            return self._send(200, {"error": f"{type(e).__name__}: {e}"})

    def do_POST(self):
        _local.cmds = []
        u = urllib.parse.urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or "{}") if n else {}
            if not isinstance(body, dict):
                raise ValueError("body is not an object")
        except ValueError:
            return self._send(400, {"error": "invalid body"})
        try:
            code, out = post_route(u.path, body)
            return self._send(code, out)
        except KubectlError as e:
            return self._error(e)
        except Exception as e:  # noqa: BLE001
            return self._send(200, {"error": f"{type(e).__name__}: {e}"})

    def _sse_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

    def _sse(self, obj):
        self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode())
        self.wfile.flush()

    # ---- pod terminal (WebSocket + PTY), only after confirmation ----
    def _terminal(self, q):
        refusal = terminal_refusal(q)
        if refusal:
            return self._send(*refusal)
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._send(400, {"error": "this is a WebSocket endpoint"})

        accept = base64.b64encode(hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.close_connection = True

        g = lambda k: (q.get(k) or [""])[0]  # noqa: E731
        ctx = g("ctx")
        cmd = terminal_command(ctx, g("ns"), g("pod"), g("container"))
        master, slave = pty.openpty()
        resize(master, 80, 24)
        proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave,
                                start_new_session=True, close_fds=True, env=env_of_ctx(ctx))
        os.close(slave)
        self._pump_terminal(master, proc)

    def _pump_terminal(self, master, proc):
        lock = threading.Lock()
        alive = threading.Event()
        alive.set()

        def send(data, op=0x2):
            with lock:
                try:
                    self.wfile.write(ws_frame(data, op))
                    self.wfile.flush()
                except OSError:  # pragma: no cover - browser went away mid-frame
                    alive.clear()

        def pump():
            """pty -> browser"""
            while alive.is_set():  # pragma: no branch - ends by break or by the reader loop
                try:
                    ready, _, _ = select.select([master], [], [], 0.2)
                    if not ready:  # pragma: no cover - timing: an idle shell
                        continue
                    out = os.read(master, 65536)
                    if not out:  # pragma: no cover - Linux raises EIO instead
                        break
                    send(out)
                except OSError:                    # EIO = the pty closed, the normal end
                    break
            alive.clear()
            send(b"", 0x8)                         # close

        t = threading.Thread(target=pump, daemon=True)
        t.start()
        try:
            while alive.is_set():  # pragma: no branch - ends by break or by the pump
                op, data = ws_read(self.rfile)
                if op is None or op == 0x8:        # closed
                    break
                if op == 0x9:                      # ping -> pong
                    send(data, 0xA)
                elif op == 0x1:                    # text = control (json)
                    try:
                        m = json.loads(data.decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if isinstance(m, dict) and m.get("type") == "resize":
                        resize(master, m.get("cols", 80), m.get("rows", 24))
                elif op == 0x2 and data:  # pragma: no branch - binary = keyboard; others are ignored
                    try:
                        os.write(master, data)
                    except OSError:  # pragma: no cover - the shell ended mid-keystroke
                        break
        finally:
            alive.clear()
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGHUP)
            except OSError:  # pragma: no cover - the group already ended
                pass
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:  # pragma: no cover - a shell that ignores SIGHUP
                proc.kill()
            os.close(master)

    # ---- SSO login with live output (SSE) ----
    def _sso_login(self, profile):
        if not profile or not RE_PROFILE.match(profile):
            return self._send(400, {"error": "invalid profile"})
        if not AWS:
            return self._send(200, {"error": "aws CLI not found"})
        self._sse_start()
        proc = subprocess.Popen([AWS, "sso", "login", "--profile", profile],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1, env=clean_aws_env())
        try:
            self._sse({"cmd": f"aws sso login --profile {profile}"})
            for line in proc.stdout:
                self._sse({"line": line.rstrip("\n")})
            proc.wait(timeout=180)
            clear_caches()          # new credential: the previous error died here
            self._sse({"done": True, "code": proc.returncode, "status": profile_status(profile)})
        except (BrokenPipeError, ConnectionResetError):  # pragma: no cover - tab closed mid-stream
            pass
        except subprocess.TimeoutExpired:
            try:
                self._sse({"done": True, "code": -1,
                           "status": {"valid": False, "reason": "login took too long"}})
            except OSError:  # pragma: no cover - the browser left too
                pass
        finally:
            if proc.poll() is None:  # pragma: no cover - only after a timeout or a closed tab
                proc.terminate()

    # ---- streaming logs (SSE) ----
    def _logs(self, ctx, ns, name, container, previous, tail):
        if not name or not ns:
            return self._send(400, {"error": "missing ns/name"})
        args = logs_command(ctx, ns, name, container, previous, tail)
        self._sse_start()
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, bufsize=1, env=env_of_ctx(ctx))
        try:
            self._sse({"cmd": shlex.join(["kubectl"] + args[1:])})
            for line in proc.stdout:
                self._sse({"line": line.rstrip("\n")})
        except (BrokenPipeError, ConnectionResetError):  # pragma: no cover - tab closed mid-stream
            pass
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:  # pragma: no cover - kubectl ignoring SIGTERM
                proc.kill()

    # ---- static files of the React build ----
    def _static(self, p):
        if p in ("/", ""):
            p = "/index.html"
        target = (WEB / p.lstrip("/")).resolve()
        if not str(target).startswith(str(WEB.resolve())) or not target.is_file():
            target = WEB / "index.html"          # SPA: an unknown route falls into the app
            if not target.is_file():
                return self._send(503, "<h1>UI not built</h1>"
                                       "<p>run: cd ui && npm install && npm run build</p>",
                                  "text/html; charset=utf-8")
        types = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                 ".svg": "image/svg+xml", ".json": "application/json",
                 ".woff2": "font/woff2", ".ico": "image/x-icon"}
        ctype = types.get(target.suffix, "application/octet-stream")
        data = target.read_bytes()
        try:
            self.send_response(200)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8" if ctype.startswith("text") else ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):  # pragma: no cover - client race
            self.close_connection = True


class Server(ThreadingHTTPServer):
    """Only exists so the console does not become a wall of tracebacks.

    A client that closes the connection midway (refresh, tab change, a panel React
    unmounted) arrives here as BrokenPipe. That is routine, not a defect. A real
    error still shows - in one readable line."""
    daemon_threads = True

    def handle_error(self, request, client_address):
        e = sys.exc_info()[1]
        if isinstance(e, (BrokenPipeError, ConnectionResetError,
                          ConnectionAbortedError, TimeoutError)):
            return
        print(f"kube-deck: {type(e).__name__}: {e}", file=sys.stderr)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    port = int(argv[0]) if argv else int(os.environ.get("KD_PORT", DEFAULT_PORT))
    if not shutil.which("kubectl"):
        print("kubectl not found in PATH", file=sys.stderr)
        return 1
    try:
        _state["context"] = kubectl(["config", "current-context"]).strip()
    except KubectlError:
        _state["context"] = None
    srv = Server(("127.0.0.1", port), Handler)
    print(f"Kube Deck web on http://localhost:{port}   (reads freely, the shell asks first)")
    print(f"initial context: {_state['context']}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
