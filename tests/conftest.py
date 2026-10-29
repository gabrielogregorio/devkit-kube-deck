"""Shared fixtures: a fake HOME, a fake kubeconfig and fake kubectl/aws binaries.

Nothing here talks to a real cluster or to AWS."""
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FAKE_BIN = Path(__file__).resolve().parent / "fake"
sys.path.insert(0, str(ROOT / "server"))

import kube_deck as kd  # noqa: E402
from fixtures import FIXTURES, KUBECONFIG  # noqa: E402


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated HOME + fake binaries; returns helpers to read the kubectl call log."""
    data = tmp_path / "k8s"
    data.mkdir()
    for name, obj in FIXTURES.items():
        (data / f"{name}.json").write_text(json.dumps(obj))
    home = tmp_path / "home"
    (home / ".kube").mkdir(parents=True)
    (home / ".kube" / "config").write_text(json.dumps(KUBECONFIG))
    (home / ".aws").mkdir()
    (home / ".aws" / "credentials").write_text(
        "# a comment that must stay\n[old]\naws_access_key_id = AKIAOLDOLDOLDOLDOLD1\n")
    (home / ".aws" / "config").write_text(
        "[profile dev]\nsso_session = corp\nsso_account_id = 111122223333\nsso_role_name = Read\n"
        "region = us-west-2\n\n[profile 111122223333_Read]\nsso_start_url = https://x\n"
        "sso_account_id = 111122223333\n\n[sso-session corp]\nsso_start_url = https://x\n\n"
        "[default]\nregion = us-east-1\n")
    log = tmp_path / "kubectl.log"
    monkeypatch.setenv("FAKE_K8S_DIR", str(data))
    monkeypatch.setenv("FAKE_K8S_LOG", str(log))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", f"{FAKE_BIN}{os.pathsep}{os.environ['PATH']}")
    for k in ("AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
              "FAKE_FORBID", "FAKE_FAIL"):
        monkeypatch.delenv(k, raising=False)
    cfg = home / ".config"
    patches = {
        "KUBECTL": str(FAKE_BIN / "kubectl"), "AWS": str(FAKE_BIN / "aws"),
        "AWS_DIR": home / ".aws", "CONFIG_DIR": cfg / "devkit-kube-deck",
        "PROFILE_MAP": cfg / "devkit-kube-deck" / "profiles.json",
        "LEGACY_PROFILE_MAP": cfg / "kubelente" / "perfis.json",
        "KUBECONFIG": home / ".kube" / "config", "BACKUP_DIR": home / ".kube" / "kube-deck-backups",
    }
    for k, v in patches.items():
        monkeypatch.setattr(kd, k, v)
    kd.clear_caches()
    kd._state["context"] = "staging"
    kd._local.cmds = []

    class Env:
        root = tmp_path
        home_dir = home

        @staticmethod
        def calls():
            if not log.exists():
                return []
            return [json.loads(line) for line in log.read_text().splitlines()]

    return Env
