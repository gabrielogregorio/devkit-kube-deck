"""Server barriers and routes, against a fake kubectl and a fake HOME (see conftest.py).

If one of the safety tests fails, a barrier got weaker: fix the server, not the test."""
import base64
import json
import os
import socket
import struct
import threading
import urllib.error
import urllib.request

import pytest

from conftest import kd

MUTATING = ["delete", "apply", "create", "patch", "edit", "replace", "scale", "rollout",
            "annotate", "label", "cordon", "drain", "taint", "exec", "attach", "cp", "run",
            "set", "uncordon", "evict", "debug"]


# ------------------------------------------------------------------ allowlist
@pytest.mark.parametrize("verb", MUTATING)
def test_mutating_verb_is_refused(env, verb):
    with pytest.raises(kd.KubectlError, match="blocked verb"):
        kd.kubectl([verb, "pods"])
    assert env.calls() == []


@pytest.mark.parametrize("sub", ["set-context", "delete-context", "use-context", "rename-context",
                                 "set-credentials", "unset"])
def test_config_only_reads(env, sub):
    with pytest.raises(kd.KubectlError):
        kd.kubectl(["config", sub, "x"])
    with pytest.raises(kd.KubectlError):
        kd.kubectl_raw(["config", sub, "x"])


def test_auth_only_reads(env):
    with pytest.raises(kd.KubectlError):
        kd.kubectl(["auth", "reconcile"])
    with pytest.raises(kd.KubectlError):
        kd.kubectl(["auth"])


@pytest.mark.parametrize("arg", ["a;id", "a&&id", "a|id", "$(id)", "`id`", "a>b", "a<b", "a||b"])
def test_shell_metacharacters_refused(env, arg):
    with pytest.raises(kd.KubectlError, match="suspicious"):
        kd.kubectl(["get", "pods", arg])


def test_empty_and_non_string_arguments(env):
    with pytest.raises(kd.KubectlError, match="empty"):
        kd.kubectl([])
    with pytest.raises(kd.KubectlError, match="invalid argument"):
        kd.kubectl(["get", 3])


def test_reading_verbs_run_with_context_and_timeout(env):
    kd.kubectl(["get", "pods", "-A", "-o", "json"], ctx="staging")
    call = env.calls()[-1]
    assert call[:4] == ["--context", "staging", "--request-timeout", "25s"]
    kd.kubectl(["logs", "api-1", "-n", "default"])
    assert "--request-timeout" not in env.calls()[-1]
    assert any(c.startswith("kubectl --context staging") for c in kd.current_cmds())


# ------------------------------------------------------------------ errors
@pytest.mark.parametrize("msg, part", [
    ("Error loading SSO Token: expired", "aws sso login"),
    ("Unable to locate credentials", "no AWS profile linked"),
    ("ExpiredToken: x", "missing or expired"),
    ("dial tcp: lookup x: no such host", "VPN"),
    ("error: You must be logged in (Unauthorized)", "not authenticated"),
    ('Error from server (NotFound): pods "x" not found', "not found"),
    ("something else", ""),
])
def test_explain_error(env, msg, part):
    assert part in kd.explain_error(msg)


def test_explain_error_names_the_linked_profile(env):
    kd.save_map({"staging": "dev"})
    assert "'dev'" in kd.explain_error("Token has expired", "staging")
    assert "'dev'" in kd.explain_error("NoCredentials", "staging")


def test_forbidden_hint_and_scope(env):
    msg = 'nodes is forbidden: User "x" cannot list resource "nodes" at the cluster scope'
    hint = kd.explain_error(msg)
    assert "nodes at cluster scope" in hint and "NOT a credential problem" in hint
    assert kd.explain_error("Forbidden") .startswith("Authenticated")


def test_hard_failure_is_credential_or_network_only(env):
    for msg in ["getting credentials: exec: executable aws failed", "kubectl took too long and was stopped",
                "Unable to locate credentials", "dial tcp: no such host", "Error loading SSO Token"]:
        assert kd.hard_failure(msg), msg
    for msg in ['pods is forbidden: User "x" cannot list pods', 'pods "api" not found', "this is fine"]:
        assert not kd.hard_failure(msg), msg


def test_rbac_hint_never_becomes_a_hard_failure(env):
    """Regression: the 403 hint talks about credentials; it once poisoned the failure cache
    and a single denied `nodes` emptied every other screen of the same cluster."""
    msg = 'nodes is forbidden: User "arn:aws:sts::1:assumed-role/Read/x" cannot list resource "nodes"'
    assert not kd.hard_failure(msg, kd.explain_error(msg))


def test_failure_cache_short_circuits_and_clears(env, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "dial tcp: no such host")
    with pytest.raises(kd.KubectlError):
        kd.kubectl(["get", "pods"], ctx="staging")
    monkeypatch.delenv("FAKE_FAIL")
    n = len(env.calls())
    with pytest.raises(kd.KubectlError, match="no such host"):
        kd.kubectl(["get", "pods"], ctx="staging")
    assert len(env.calls()) == n                      # cached: kubectl was not called again
    kd.kubectl(["config", "current-context"], ctx="staging")   # config always goes through
    kd.clear_caches()
    assert kd.kubectl(["get", "pods", "-o", "json"], ctx="staging")


def test_timeout_is_a_hard_failure(env, monkeypatch):
    def slow(*a, **k):
        raise kd.subprocess.TimeoutExpired("kubectl", 1)
    monkeypatch.setattr(kd.subprocess, "run", slow)
    with pytest.raises(kd.KubectlError, match="too long"):
        kd.kubectl(["get", "pods"], ctx="x")
    assert "x" in kd._failures


def test_kubectl_raw_error(env, monkeypatch):
    monkeypatch.setattr(kd, "KUBECTL", "/bin/false")
    with pytest.raises(kd.KubectlError, match="kubectl failed"):
        kd.kubectl_raw(["config", "view"])


# ------------------------------------------------------------------ AWS profiles
def test_aws_profiles_never_return_key_values(env):
    kd.save_keys("secret", "ASIAZZZZZZZZEXAMPLE3", "MUST-NOT-LEAK", "SECRET-TOKEN")
    profiles = kd.aws_profiles()
    text = json.dumps(profiles)
    for word in ["MUST-NOT-LEAK", "SECRET-TOKEN", "ASIAZZZZZZZZEXAMPLE3"]:
        assert word not in text
    assert profiles["dev"]["type"] == "sso" and profiles["dev"]["account"] == "111122223333"
    assert profiles["secret"]["has_key"] and profiles["old"]["source"] == "credentials"
    assert "corp" not in profiles and profiles["default"]["region"] == "us-east-1"


def test_broken_ini_reads_as_empty(env):
    (env.home_dir / ".aws" / "config").write_text("not an ini [[[\n")
    assert "dev" not in kd.aws_profiles()


def test_save_keys_keeps_comments_backs_up_and_sets_mode(env):
    kd.save_keys("test", "ASIAZZZZZZZZEXAMPLE1", "sec/ret+1", "tok", "us-west-2")
    aws = env.home_dir / ".aws"
    cred = (aws / "credentials").read_text()
    assert "# a comment that must stay" in cred and "[old]" in cred and "ASIAZZZZZZZZEXAMPLE1" in cred
    assert list(aws.glob("credentials.bak-*"))
    assert oct(os.stat(aws / "credentials").st_mode)[-3:] == "600"
    assert "[profile test]\nregion = us-west-2" in (aws / "config").read_text()
    kd.save_keys("default", "AKIAPERMANENTEXAMPL", "s", region="sa-east-1")
    assert "region = sa-east-1" in (aws / "config").read_text().split("[default]")[1]


def test_permanent_key_drops_the_old_session_token(env):
    kd.save_keys("rotating", "ASIAZZZZZZZZEXAMPLE2", "s1", "temporary-token")
    kd.save_keys("rotating", "AKIAPERMANENTEXAMPL", "s2")
    section = (env.home_dir / ".aws" / "credentials").read_text().split("[rotating]")[1].split("[")[0]
    assert "aws_session_token" not in section and "s2" in section


@pytest.mark.parametrize("args, part", [
    (("bad profile!", "AKIAAAAAAAAAAAAAAAAA", "s"), "profile"),
    (("good", "short-key", "s"), "format"),
    (("good", "", ""), "required"),
])
def test_save_keys_refuses_garbage(env, args, part):
    with pytest.raises(kd.KubectlError, match=part):
        kd.save_keys(*args)


def test_save_keys_without_existing_file(env):
    (env.home_dir / ".aws" / "credentials").unlink()
    kd.save_keys("new", "AKIAPERMANENTEXAMPL", "s")
    assert (env.home_dir / ".aws" / "credentials").read_text().startswith("[new]")


def test_profile_map_reads_the_legacy_file_once(env):
    kd.LEGACY_PROFILE_MAP.parent.mkdir(parents=True)
    kd.LEGACY_PROFILE_MAP.write_text(json.dumps({"staging": "legacy"}))
    assert kd.load_map() == {"staging": "legacy"}
    kd.save_map({"staging": "new"})
    assert kd.load_map() == {"staging": "new"}
    assert oct(os.stat(kd.PROFILE_MAP).st_mode)[-3:] == "600"
    kd.PROFILE_MAP.write_text("[1, 2]")
    assert kd.load_map() == {}


def test_context_info_and_link(env):
    infos = {c["context"]: c for c in kd.context_info()}
    eks = infos["arn:aws:eks:us-west-2:111122223333:cluster/my-cluster-prod"]
    assert eks["uses_aws"] and eks["account"] == "111122223333"
    assert eks["role"].endswith("role/MyEKSReadRole")
    assert eks["profile"] == "pinned" and eks["profile_source"] == "kubeconfig"
    assert eks["suggested"] == ["dev", "111122223333_Read"]
    assert not infos["staging"]["uses_aws"] and infos["staging"]["profile"] == ""

    targets = kd.link_profile("staging", "dev")
    # every context of the same cluster gets the link
    assert set(targets) == {"staging", "k3d-any", "arn:aws:eks:us-west-2:111122223333:cluster/my-cluster-prod"}
    assert kd.context_info()[2]["profile_source"] == "kube-deck"
    env_vars = kd.env_of_ctx("staging")
    assert env_vars["AWS_PROFILE"] == "dev" and "AWS_SECRET_ACCESS_KEY" not in env_vars
    kd.link_profile("staging", "")
    assert kd.load_map() == {}
    assert kd.profile_of_ctx(None) == ""


def test_aws_cmd_allowlist(env, monkeypatch):
    with pytest.raises(kd.KubectlError, match="blocked aws"):
        kd.aws_cmd(["s3", "rm"])
    with pytest.raises(kd.KubectlError, match="invalid profile"):
        kd.aws_cmd(["sts", "get-caller-identity"], profile="a b")
    monkeypatch.setenv("AWS_PROFILE", "leaked")
    assert "AWS_PROFILE" not in kd.clean_aws_env()
    monkeypatch.setattr(kd, "AWS", None)
    with pytest.raises(kd.KubectlError, match="not found"):
        kd.aws_cmd(["sts", "get-caller-identity"])
    assert kd.profile_status("good") == {"valid": False, "reason": "aws CLI not found in PATH"}


def test_profile_status(env):
    assert kd.profile_status("good")["account"] == "111122223333"
    assert kd.profile_status("expired") == {"valid": False, "reason": "SSO session expired or never started"}
    assert "does not exist" in kd.profile_status("missing")["reason"]


def test_profile_status_odd_answers(env, monkeypatch):
    answers = iter([kd.subprocess.CompletedProcess([], 0, "not json", ""),
                    kd.subprocess.CompletedProcess([], 1, "", "boom happened"),
                    kd.subprocess.CompletedProcess([], 1, "", "")])
    monkeypatch.setattr(kd, "aws_cmd", lambda *a, **k: next(answers))
    assert kd.profile_status("x") == {"valid": True, "account": "", "arn": ""}
    assert kd.profile_status("x")["reason"] == "boom happened"
    assert kd.profile_status("x")["reason"] == "failed"


@pytest.mark.parametrize("kwargs, part", [
    ({"name": "x", "region": "us-west-2; rm -rf /"}, "region"),
    ({"name": "a$(id)", "region": "us-west-2"}, "cluster"),
    ({"name": "../../etc/passwd", "region": "us-west-2"}, "cluster"),
    ({"name": "x", "region": ""}, "region"),
    ({"name": "x", "region": "us-west-2", "role_arn": "arn:aws:iam::12:role/x"}, "role"),
    ({"name": "x", "region": "us-west-2", "profile": "a b;c"}, "profile"),
    ({"name": "x", "region": "us-west-2", "alias": "a b"}, "alias"),
])
def test_add_kubeconfig_refuses_garbage(env, kwargs, part):
    with pytest.raises(kd.KubectlError, match=part):
        kd.add_kubeconfig(**kwargs)


def test_add_kubeconfig_backs_up_and_links(env):
    r = kd.add_kubeconfig("my-cluster-prod", "us-west-2",
                          "arn:aws:iam::111122223333:role/MyEKSReadRole", "dev", "prod")
    assert r["ok"] and r["context"] == "prod" and r["backup"].startswith(str(kd.BACKUP_DIR))
    assert "prod" in r["linked"] and kd.load_map()["prod"] == "dev"
    r = kd.add_kubeconfig("other", "us-west-2")
    assert r["context"].endswith("cluster/other") and r["linked"] == []
    with pytest.raises(kd.KubectlError, match="No cluster found"):
        kd.add_kubeconfig("broken", "us-west-2")


def test_add_kubeconfig_without_kubeconfig_and_failed_link(env, monkeypatch):
    kd.KUBECONFIG.unlink()
    monkeypatch.setattr(kd, "link_profile", lambda *a: (_ for _ in ()).throw(OSError("disk")))
    r = kd.add_kubeconfig("c", "us-west-2", profile="dev", alias="c")
    assert r["backup"] == "" and r["linked"] == []


# ------------------------------------------------------------------ ini editing
def test_write_ini_section_new_file_and_obsolete_key(env, tmp_path):
    p = tmp_path / "x.ini"
    kd.write_ini_section(p, "a", {"k": "1"})
    kd.write_ini_section(p, "b", {"k": "2"})
    kd.write_ini_section(p, "a", {"k": "3", "n": "4"}, remove=("old",))
    p.write_text(p.read_text().replace("[b]", "old = x\n[b]"))
    kd.write_ini_section(p, "a", {"k": "5"}, remove=("old",))
    text = p.read_text()
    assert "old" not in text and "k = 5" in text and "n = 4" in text and "[b]\nk = 2" in text


# ------------------------------------------------------------------ helpers
def test_age_and_pod_summary(env):
    assert kd.age("") == "" and kd.age("garbage") == ""
    assert kd.age("2020-01-01T00:00:00Z").endswith("d")
    now = kd.time.time()
    for delta, unit in ((10, "s"), (600, "m"), (7200, "h")):
        ts = kd.time.strftime("%Y-%m-%dT%H:%M:%SZ", kd.time.gmtime(now - delta))
        assert kd.age(ts).endswith(unit)
    gone = {"metadata": {"deletionTimestamp": "x", "name": "p", "namespace": "d"}, "status": {}}
    assert kd.pod_state(gone) == "Terminating"
    assert kd.pod_state({"status": {"phase": "Pending"}}) == "Pending"


def test_ws_frame_sizes():
    assert kd.ws_frame(b"a")[:2] == b"\x82\x01"
    assert kd.ws_frame(b"a" * 200)[1] == 126
    assert kd.ws_frame(b"a" * 70000)[1] == 127


class Reader:
    def __init__(self, data):
        self.data = data

    def read(self, n):
        out, self.data = self.data[:n], self.data[n:]
        return out


def masked(op, payload):
    key = b"abcd"
    n = len(payload)
    head = bytes([0x80 | op])
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack(">Q", n)
    return head + key + bytes(b ^ key[i % 4] for i, b in enumerate(payload))


def test_ws_read():
    assert kd.ws_read(Reader(masked(1, b"hi"))) == (1, b"hi")
    assert kd.ws_read(Reader(masked(2, b"x" * 300))) == (2, b"x" * 300)
    assert kd.ws_read(Reader(masked(2, b"y" * 70000))) == (2, b"y" * 70000)
    assert kd.ws_read(Reader(b"\x81\x02ok")) == (1, b"ok")
    assert kd.ws_read(Reader(b"")) == (None, None)
    huge = b"\x82\x7f" + struct.pack(">Q", 10**9)
    assert kd.ws_read(Reader(huge)) == (None, None)
    assert kd.ws_read(Reader(b"\x82\x7e\x00")) == (None, None)


def test_resize_ignores_garbage():
    r, w = os.pipe()
    kd.resize(r, "x", None)          # no exception
    kd.resize(r, 80, 24)             # a pipe is not a tty: ioctl fails quietly
    os.close(r)
    os.close(w)


def test_logs_and_terminal_commands():
    cmd = kd.logs_command("c", "ns", "p", "", False, 99999)
    assert cmd[1:] == ["--context", "c", "logs", "p", "-n", "ns", "--tail", "5000",
                       "--all-containers", "--prefix", "-f"]
    cmd = kd.logs_command(None, "ns", "p", "app", True, 0)
    assert cmd[1:] == ["logs", "p", "-n", "ns", "--tail", "1", "-c", "app", "--previous"]
    t = kd.terminal_command("c", "ns", "p", "app")
    assert t[1:9] == ["--context", "c", "exec", "-i", "-t", "-n", "ns", "p"] and "-c" in t
    assert "-c" not in kd.terminal_command(None, "ns", "p", "")[:8]


def test_k8s_name_pattern():
    for good in ["api", "api-6cb58f4f4b-cnqzk", "kube-system", "a.b.c"]:
        assert kd.RE_K8S_NAME.match(good)
    for bad in ["../etc", "a;id", "A-Upper", "-starts-with-dash", "", "a b", "$(id)", "a/b"]:
        assert not kd.RE_K8S_NAME.match(bad)


def test_terminal_refusal_rules(env):
    q = lambda **k: {key: [v] for key, v in k.items()}  # noqa: E731
    assert kd.terminal_refusal(q(ctx="staging", ns="default", pod="api-1"))[0] == 403
    assert kd.terminal_refusal(q(ctx="staging", ns="default", pod="a;id", confirm="1"))[0] == 400
    assert kd.terminal_refusal(q(ctx="staging", ns="default", pod="api", container="X", confirm="1"))[0] == 400
    assert kd.terminal_refusal(q(ctx="invented", ns="default", pod="api", confirm="1"))[0] == 400
    assert kd.terminal_refusal(q(ctx="staging", ns="default", pod="api", confirm="1")) is None


# ------------------------------------------------------------------ routes
def test_route_contexts(env):
    d = kd.route_contexts()
    by = {c["name"]: c for c in d["contexts"]}
    assert by["lab-local"]["local"] and by["k3d-any"]["local"] and not by["staging"]["local"]
    assert d["current"] == "staging" and d["kubeconfig_current"] == "staging"
    assert "prod" not in by["staging"] and "terminal_ok" not in by["staging"]


def test_route_overview(env):
    d = kd.route_overview("staging")
    assert d["server_version"] == "v1.30.0" and d["nodes"][0]["name"] == "node-a"
    assert d["pods_total"] == 4 and d["pods_ok"] == 2 and d["pods_alive"] == 3
    assert [p["name"] for p in d["problems"]] == ["api-2"]
    assert [p["name"] for p in d["leftovers"]] == ["job-old"]
    assert d["leftovers_by_node"] == [["node-a", 1]] or d["leftovers_by_node"] == [("node-a", 1)]
    assert d["namespaces"][0] == {"ns": "default", "pods": 3, "problems": 1, "leftovers": 1, "restarts": 7}
    n = len(env.calls())
    kd.route_overview("staging")
    assert len(env.calls()) == n              # served from the cache
    assert kd.current_cmds()                  # and the commands are still shown


def test_route_overview_survives_denied_nodes(env, monkeypatch):
    monkeypatch.setenv("FAKE_FORBID", "nodes")
    d = kd.route_overview("staging")
    assert d["nodes"] == [] and d["denied"][0]["resource"] == "nodes" and d["pods_total"] == 4


def test_collector_reraises_non_rbac(env, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "dial tcp: i/o timeout")
    with pytest.raises(kd.KubectlError):
        kd.route_overview("staging")


def test_route_pods_and_namespaces(env):
    assert len(kd.route_pods("staging", "*")["pods"]) == 4
    kd.route_pods("staging", "default")
    assert env.calls()[-1][-4:] == ["-n", "default", "-o", "json"]
    assert kd.route_namespaces("staging")["namespaces"][0]["status"] == "Active"


def test_route_workloads(env):
    rows = {w["name"]: w for w in kd.route_workloads("staging", "*")["workloads"]}
    assert rows["api"]["ready"] == "1/2" and not rows["api"]["healthy"]
    assert rows["nightly"]["ready"] == "0 3 * * *" and rows["nightly"]["images"] == ["busybox"]
    assert rows["agent"]["healthy"] and rows["migrate"]["ready"] == "1/1"


def test_route_workloads_retries_kind_by_kind_on_403(env, monkeypatch):
    monkeypatch.setenv("FAKE_FORBID", "cronjobs")
    d = kd.route_workloads("staging", "default")
    assert {x["resource"] for x in d["denied"]} == {"cronjobs"}
    assert "api" in {w["name"] for w in d["workloads"]}


def test_route_workloads_reraises_other_errors(env, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "connection refused")
    with pytest.raises(kd.KubectlError):
        kd.route_workloads("staging", "*")


def test_route_network(env):
    d = kd.route_network("staging", "*")
    svc = d["services"][0]
    assert svc["external"] == "lb.example.com" and svc["ports"] == ["80/TCP→30080"]
    ing = d["ingresses"][0]
    assert ing["class"] == "nginx" and ing["tls"] and ing["rules"][0]["service"] == "web"


def test_route_network_without_ingress(env, monkeypatch):
    real = kd.kjson

    def no_ingress(args, ctx=None, timeout=kd.TIMEOUT):
        if args[1] == "ingresses":
            raise kd.KubectlError("the server doesn't have a resource type ingresses")
        return real(args, ctx, timeout)
    monkeypatch.setattr(kd, "kjson", no_ingress)
    assert kd.route_network("staging", "*")["ingresses"] == []


def test_route_config_never_returns_secret_values(env):
    d = kd.route_config("staging", "*")
    assert d["configmaps"][0]["keys"] == ["a", "b"]
    assert d["secrets"][0]["keys"] == ["password"]
    assert "U0VDUkVULVZBTFVF" not in json.dumps(d)


def test_route_storage_events_top(env):
    s = kd.route_storage("staging", "*")
    assert s["pvcs"][0]["capacity"] == "10Gi" and s["pvs"][0]["policy"] == "Delete"
    ev = kd.route_events("staging", "*")["events"]
    assert ev[0]["reason"] == "BackOff" and ev[0]["object"] == "Pod/api-2" and ev[1]["count"] == 1
    top = kd.route_top("staging", "*")
    assert top["nodes"]["node-a"]["cpu_pct"] == "12%" and top["pods"]["default/api-1"]["mem"] == "64Mi"


def test_route_top_without_metrics_server(env, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "Metrics API not available")
    assert kd.route_top("staging", "*") == {"nodes": {}, "pods": {}}


def test_route_top_single_namespace_format(env, monkeypatch):
    real = kd.kubectl
    monkeypatch.setattr(kd, "kubectl", lambda args, ctx=None, timeout=30:
                        "api-1 5m 64Mi" if args[:2] == ["top", "pod"] else real(args, ctx, timeout))
    assert kd.route_top("staging", "default")["pods"] == {"api-1": {"cpu": "5m", "mem": "64Mi"}}


def test_route_pod_detail_yaml_describe(env):
    d = kd.route_pod_detail("staging", "default", "api-1")
    assert d["summary"]["name"] == "api-1" and d["events"][0]["reason"] == "BackOff"
    assert kd.route_yaml("staging", "pod", "default", "api-1")["object"]["metadata"]["name"] == "api-1"
    assert kd.route_yaml("staging", "pod", "*", "api-1")
    assert kd.route_describe("staging", "pod", "default", "api-1")["text"].startswith("Name: api-1")
    assert kd.route_describe("staging", "pod", "*", "api-1")


def test_route_pod_detail_without_events(env, monkeypatch):
    monkeypatch.setenv("FAKE_FORBID", "events")
    assert kd.route_pod_detail("staging", "default", "api-1")["events"] == []


def test_route_access(env):
    d = kd.route_access("staging", "*")
    assert d["user"] == "tester" and d["groups"] == ["devs"] and d["scope"] == "all namespaces"
    checks = {(c["verb"], c["resource"]): c["allowed"] for c in d["checks"]}
    assert checks[("list", "pods")] and not checks[("delete", "pods")]
    assert "--all-namespaces" in env.calls()[-1]
    kd.route_access("staging", "default")
    assert env.calls()[-1][-2:] == ["-n", "default"]


def test_route_access_when_everything_fails(env, monkeypatch):
    monkeypatch.setenv("FAKE_FORBID", "x")
    monkeypatch.setattr(kd, "kubectl", lambda *a, **k: (_ for _ in ()).throw(kd.KubectlError("no")))
    d = kd.route_access("other", "*")
    assert d["user"] == "?" and d["allowed"] == []


# ------------------------------------------------------------------ HTTP
@pytest.fixture
def http(env, tmp_path, monkeypatch):
    web = tmp_path / "dist"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<html>app</html>")
    (web / "assets" / "a.js").write_text("console.log(1)")
    monkeypatch.setattr(kd, "WEB", web)
    srv = kd.Server(("127.0.0.1", 0), kd.Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    class H:
        port = srv.server_address[1]
        dist = web

        @staticmethod
        def get(path, raw=False):
            try:
                with urllib.request.urlopen(base + path, timeout=15) as r:
                    body = r.read()
                    return r.status, (body if raw else json.loads(body or b"{}")), r.headers
            except urllib.error.HTTPError as e:
                body = e.read()
                return e.code, (body if raw else json.loads(body or b"{}")), e.headers

        @staticmethod
        def post(path, body, raw=None):
            data = raw if raw is not None else json.dumps(body).encode()
            req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=15) as r:
                    return r.status, json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")

    yield H
    srv.shutdown()
    srv.server_close()


@pytest.mark.parametrize("path, key", [
    ("/api/contexts", "contexts"), ("/api/overview", "nodes"), ("/api/pods?ns=*", "pods"),
    ("/api/workloads", "workloads"), ("/api/network", "services"), ("/api/config", "secrets"),
    ("/api/storage", "pvcs"), ("/api/events", "events"), ("/api/top", "nodes"),
    ("/api/namespaces", "namespaces"), ("/api/access", "checks"),
    ("/api/pod?ns=default&name=api-1", "summary"), ("/api/yaml?ns=default&name=api-1", "object"),
    ("/api/describe?ns=default&name=api-1", "text"), ("/api/aws", "profiles"),
    ("/api/aws/status?profile=good", "valid"),
])
def test_get_routes(http, path, key):
    st, d, _ = http.get(path)
    assert st == 200 and key in d, d
    if path != "/api/aws/status?profile=good":
        assert d.get("_cmds")


def test_select_route_switches_context(http):
    st, d, _ = http.get("/api/select?name=lab-local")
    assert d == {"ok": True, "context": "lab-local", "_cmds": d.get("_cmds", [])} or d["ok"]
    assert kd._state["context"] == "lab-local"


def test_errors_are_json(http, monkeypatch):
    st, d, _ = http.get("/api/pod?ns=default&name=nope")
    assert st == 200 and "not found" in d["error"] and d["hint"] == "Resource not found."
    monkeypatch.setattr(kd, "route_pods", lambda *a: 1 / 0)
    st, d, _ = http.get("/api/pods")
    assert d["error"].startswith("ZeroDivisionError")
    st, d, _ = http.get("/api/does-not-exist")
    assert st == 404


def test_static_files_and_spa_fallback(http):
    st, body, h = http.get("/", raw=True)
    assert st == 200 and b"app" in body and h["Content-Type"].startswith("text/html")
    st, body, h = http.get("/assets/a.js", raw=True)
    assert h["Content-Type"].startswith("text/javascript")
    st, body, _ = http.get("/some/page", raw=True)
    assert b"app" in body
    st, body, _ = http.get("/../../etc/passwd", raw=True)
    assert b"root:" not in body


def test_static_without_build(http):
    (http.dist / "index.html").unlink()
    st, body, _ = http.get("/", raw=True)
    assert st == 503 and b"not built" in body


def test_post_routes(http):
    st, d = http.post("/api/aws/link", {"context": "staging", "profile": "dev"})
    assert d["ok"] and "staging" in d["contexts"]
    assert http.post("/api/aws/link", {"profile": "dev"})[0] == 400
    assert "invalid" in http.post("/api/aws/link", {"context": "staging", "profile": "a b"})[1]["error"]
    st, d = http.post("/api/aws/keys", {"profile": "p1", "access_key": "AKIAPERMANENTEXAMPL", "secret_key": "s"})
    assert d == {"ok": True, "profile": "p1"} or d["ok"]
    st, d = http.post("/api/aws/kubeconfig", {"name": "c1", "region": "us-west-2", "alias": "c1"})
    assert d["context"] == "c1"
    st, d = http.post("/api/aws/kubeconfig", {"name": "bad name", "region": "us-west-2"})
    assert "invalid cluster" in d["error"]


def test_post_bad_body_and_crash(http, monkeypatch):
    assert http.post("/api/aws/link", None, raw=b"{not json")[0] == 400
    assert http.post("/api/aws/link", None, raw=b"[1]")[0] == 400
    monkeypatch.setattr(kd, "post_route", lambda *a: 1 / 0)
    assert http.post("/api/aws/link", {})[1]["error"].startswith("ZeroDivisionError")


@pytest.mark.parametrize("path", ["/api/scale", "/api/restart", "/api/delete", "/api/exec",
                                  "/api/apply", "/api/pod/delete", "/api/pods/delete"])
def test_there_is_no_route_that_changes_the_cluster(http, path):
    assert http.post(path, {"name": "x"})[0] == 404


def sse(http, path):
    with urllib.request.urlopen(f"http://127.0.0.1:{http.port}{path}", timeout=15) as r:
        return [json.loads(line[6:]) for line in r.read().decode().splitlines() if line.startswith("data: ")]


def test_logs_stream(http):
    events = sse(http, "/api/logs?ns=default&name=api-1&tail=10")
    assert events[0]["cmd"].startswith("kubectl --context staging logs api-1")
    assert [e["line"] for e in events[1:]] == ["line one", "line two"]
    assert http.get("/api/logs?ns=default")[0] == 400


def test_sso_login_stream(http, monkeypatch):
    events = sse(http, "/api/aws/login?profile=good")
    assert events[0] == {"cmd": "aws sso login --profile good"}
    assert events[-1]["done"] and events[-1]["code"] == 0 and events[-1]["status"]["valid"]
    assert http.get("/api/aws/login?profile=a%20b")[0] == 400
    monkeypatch.setattr(kd, "AWS", None)
    assert "not found" in http.get("/api/aws/login?profile=good")[1]["error"]


def test_terminal_needs_confirmation(http):
    st, d, _ = http.get("/api/terminal?ctx=staging&ns=default&pod=api-1")
    assert st == 403 and "confirmation" in d["error"]
    st, d, _ = http.get("/api/terminal?ctx=staging&ns=default&pod=api-1&confirm=1")
    assert st == 400 and "WebSocket" in d["error"]


def ws_handshake(port, query):
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    key = base64.b64encode(b"0123456789abcdef").decode()
    s.sendall((f"GET /api/terminal?{query} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        head += s.recv(1)
    return s, head


def test_terminal_websocket_runs_the_shell(http, env):
    s, head = ws_handshake(http.port, "ctx=staging&ns=default&pod=api-1&confirm=1")
    assert head.startswith(b"HTTP/1.1 101")
    s.sendall(masked(0x1, json.dumps({"type": "resize", "cols": 100, "rows": 30}).encode()))
    s.sendall(masked(0x1, b"not json"))
    s.sendall(masked(0x9, b"ping"))
    s.sendall(masked(0x2, b"ls\n"))
    data = b""
    while b"fake shell" not in data:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    s.sendall(masked(0x8, b""))
    s.close()
    assert b"fake shell" in data
    exec_call = next(c for c in env.calls() if "exec" in c)
    assert exec_call[:4] == ["--context", "staging", "exec", "-i"]


def test_server_quiet_on_broken_pipe(capsys):
    srv = kd.Server.__new__(kd.Server)
    try:
        raise BrokenPipeError()
    except BrokenPipeError:
        srv.handle_error(None, None)
    try:
        raise ValueError("real")
    except ValueError:
        srv.handle_error(None, None)
    assert capsys.readouterr().err == "kube-deck: ValueError: real\n"


def test_main_without_kubectl(env, monkeypatch, capsys):
    monkeypatch.setattr(kd.shutil, "which", lambda name: None)
    assert kd.main(["0"]) == 1
    assert "kubectl not found" in capsys.readouterr().err


def test_main_starts_and_stops(env, monkeypatch, capsys):
    class Fake:
        def __init__(self, addr, handler):
            assert addr == ("127.0.0.1", 9123)

        def serve_forever(self):
            raise KeyboardInterrupt
    monkeypatch.setattr(kd, "Server", Fake)
    monkeypatch.setenv("KD_PORT", "9123")
    assert kd.main([]) == 0
    out = capsys.readouterr().out
    assert "http://localhost:9123" in out and "initial context: staging" in out
    monkeypatch.setenv("FAKE_K8S_DIR", "/nonexistent")
    monkeypatch.setattr(kd, "KUBECTL", "/bin/false")
    assert kd.main(["9123"]) == 0


# ------------------------------------------------------------------ odd inputs
def test_record_cmd_in_a_fresh_thread():
    out = []
    t = threading.Thread(target=lambda: (kd.record_cmd(["kubectl", "get"]), out.append(kd.current_cmds())))
    t.start()
    t.join()
    assert out == [["kubectl get"]]


def test_pod_state_running_but_not_ready():
    p = {"metadata": {}, "status": {"phase": "Running",
                                    "containerStatuses": [{"ready": False, "state": {"running": {}}}]}}
    assert kd.pod_state(p) == "Running"


def test_route_top_skips_odd_lines(env, monkeypatch):
    monkeypatch.setattr(kd, "kubectl", lambda args, ctx=None, timeout=30: "short line\n\na b c d e f g")
    assert kd.route_top("x", "*") == {"nodes": {"short": None} if False else {"a": {
        "cpu": "b", "cpu_pct": "c", "mem": "d", "mem_pct": "e"}}, "pods": {}}


def test_terminal_refusal_when_the_kubeconfig_is_unreadable(env, monkeypatch):
    monkeypatch.setattr(kd, "KUBECTL", "/bin/false")
    assert kd.terminal_refusal({"ctx": ["staging"], "ns": ["d"], "pod": ["p"], "confirm": ["1"]})[0] == 400


def test_terminal_ignores_non_object_control_messages(http):
    s, head = ws_handshake(http.port, "ctx=staging&ns=default&pod=api-1&confirm=1")
    assert head.startswith(b"HTTP/1.1 101")
    for frame in (masked(0x1, b"[1]"), masked(0x1, b"not json"), masked(0x9, b"p"),
                  masked(0x1, json.dumps({"type": "resize", "cols": 90, "rows": 20}).encode())):
        s.sendall(frame)
    data = b""
    while b"\x8a" not in data:            # the pong comes back while the shell still waits
        data += s.recv(4096)
    s.sendall(masked(0x2, b"go\n"))
    while b"fake shell" not in data:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    s.close()
    assert b"fake shell" in data


def test_sso_login_timeout(http, monkeypatch):
    class Slow:
        stdout = iter(["waiting\n"])

        def wait(self, timeout):
            raise kd.subprocess.TimeoutExpired("aws", timeout)

        def poll(self):
            return 0
    monkeypatch.setattr(kd.subprocess, "Popen", lambda *a, **k: Slow())
    events = sse(http, "/api/aws/login?profile=good")
    assert events[-1]["status"]["reason"] == "login took too long"
