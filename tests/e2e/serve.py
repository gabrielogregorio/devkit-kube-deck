"""Starts the real Kube Deck server for the Playwright E2E, against the fake kubectl and a fake
HOME under test-results/ (git-ignored). It never sees the developer's kubeconfig or AWS files."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "tests"), str(ROOT / "server")]
from fixtures import FIXTURES, KUBECONFIG  # noqa: E402

work = ROOT / "test-results" / "e2e"
data, home = work / "k8s", work / "home"
for d in (data, home / ".kube", home / ".aws"):
    d.mkdir(parents=True, exist_ok=True)
for name, obj in FIXTURES.items():
    (data / f"{name}.json").write_text(json.dumps(obj))
(home / ".kube" / "config").write_text(json.dumps(KUBECONFIG))
os.environ.update({
    "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"), "KUBECONFIG": str(home / ".kube" / "config"),
    "FAKE_K8S_DIR": str(data), "FAKE_K8S_LOG": str(work / "kubectl.log"),
    "PATH": f"{ROOT / 'tests' / 'fake'}{os.pathsep}{os.environ['PATH']}",
})
for k in ("AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
    os.environ.pop(k, None)
(work / "kubectl.log").write_text("")

import kube_deck  # noqa: E402  (after HOME moved, so every path lands in test-results/)

sys.exit(kube_deck.main([os.environ.get("KD_E2E_PORT", "18899")]))
