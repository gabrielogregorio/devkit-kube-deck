"""Cluster fixtures shared by the pytest suite and tests/test_cli.sh. Standard library only."""

KUBECONFIG = {
    "apiVersion": "v1",
    "kind": "Config",
    "clusters": [
        {"name": "c-local", "cluster": {"server": "https://127.0.0.1:6443"}},
        {"name": "c-remote", "cluster": {"server": "https://ABC.gr7.us-west-2.eks.amazonaws.com"}},
    ],
    "users": [
        {"name": "u", "user": {}},
        {"name": "eks-user", "user": {"exec": {
            "command": "aws",
            "args": ["eks", "get-token", "--cluster-name", "my-cluster-prod",
                     "--role-arn", "arn:aws:iam::111122223333:role/MyEKSReadRole"],
            "env": [{"name": "OTHER", "value": "x"}, {"name": "AWS_PROFILE", "value": "pinned"}]}}},
    ],
    "contexts": [
        {"name": "lab-local", "context": {"cluster": "c-local", "user": "u", "namespace": "default"}},
        {"name": "k3d-any", "context": {"cluster": "c-remote", "user": "u"}},
        {"name": "staging", "context": {"cluster": "c-remote", "user": "u", "namespace": "default"}},
        {"name": "arn:aws:eks:us-west-2:111122223333:cluster/my-cluster-prod",
         "context": {"cluster": "c-remote", "user": "eks-user"}},
    ],
    "current-context": "staging",
}


def pod(name, ns="default", phase="Running", ready=True, restarts=0, reason=None, node="node-a"):
    state = {"running": {}} if ready else {"waiting": {"reason": reason or "CrashLoopBackOff"}}
    return {
        "metadata": {"name": name, "namespace": ns, "creationTimestamp": "2026-01-01T00:00:00Z"},
        "spec": {"nodeName": node, "containers": [{"name": "app", "image": "nginx:1.27"}]},
        "status": {"phase": phase, "podIP": "10.0.0.1",
                   "containerStatuses": [{"name": "app", "ready": ready, "restartCount": restarts,
                                          "state": state}]},
    }


FIXTURES = {
    "kubeconfig": KUBECONFIG,
    "pods": {"items": [
        pod("api-1"), pod("api-2", ready=False, restarts=7),
        pod("job-old", phase="Failed", ready=False, reason="Error"),
        pod("dns-1", ns="kube-system"),
    ]},
    "nodes": {"items": [{
        "metadata": {"name": "node-a", "labels": {"zone": "a"}, "creationTimestamp": "2026-01-01T00:00:00Z"},
        "spec": {},
        "status": {"conditions": [{"type": "Ready", "status": "True"}],
                   "nodeInfo": {"kubeletVersion": "v1.30.0", "osImage": "Linux"},
                   "capacity": {"cpu": "4", "memory": "16Gi"}}}]},
    "deployments": {"items": [{
        "kind": "Deployment", "metadata": {"name": "api", "namespace": "default"},
        "spec": {"replicas": 2, "template": {"spec": {"containers": [{"image": "nginx:1.27"}]}}},
        "status": {"readyReplicas": 1}}]},
    "cronjobs": {"items": [{
        "kind": "CronJob", "metadata": {"name": "nightly", "namespace": "default"},
        "spec": {"schedule": "0 3 * * *",
                 "jobTemplate": {"spec": {"template": {"spec": {"containers": [{"image": "busybox"}]}}}}},
        "status": {}}]},
    "daemonsets": {"items": [{
        "kind": "DaemonSet", "metadata": {"name": "agent", "namespace": "kube-system"},
        "spec": {}, "status": {"numberReady": 1, "desiredNumberScheduled": 1}}]},
    "statefulsets": {"items": []},
    "jobs": {"items": [{
        "kind": "Job", "metadata": {"name": "migrate", "namespace": "default"},
        "spec": {"completions": 1}, "status": {"succeeded": 1}}]},
    "services": {"items": [{
        "metadata": {"name": "web", "namespace": "default"},
        "spec": {"type": "LoadBalancer", "clusterIP": "10.1.1.1", "selector": {"app": "web"},
                 "ports": [{"port": 80, "protocol": "TCP", "nodePort": 30080}]},
        "status": {"loadBalancer": {"ingress": [{"hostname": "lb.example.com"}]}}}]},
    "ingresses": {"items": [{
        "metadata": {"name": "web", "namespace": "default"},
        "spec": {"ingressClassName": "nginx", "tls": [{}],
                 "rules": [{"host": "app.example.com", "http": {"paths": [
                     {"path": "/", "backend": {"service": {"name": "web", "port": {"number": 80}}}}]}}]},
        "status": {}}]},
    "configmaps": {"items": [{"metadata": {"name": "cfg", "namespace": "default"}, "data": {"b": "2", "a": "1"}}]},
    "secrets": {"items": [{"metadata": {"name": "db", "namespace": "default"}, "type": "Opaque",
                           "data": {"password": "U0VDUkVULVZBTFVF"}}]},
    "pvc": {"items": [{"metadata": {"name": "data", "namespace": "default"},
                       "spec": {"volumeName": "pv-1", "storageClassName": "gp3"},
                       "status": {"phase": "Bound", "capacity": {"storage": "10Gi"}}}]},
    "pv": {"items": [{"metadata": {"name": "pv-1"},
                      "spec": {"capacity": {"storage": "10Gi"}, "storageClassName": "gp3",
                               "persistentVolumeReclaimPolicy": "Delete"},
                      "status": {"phase": "Bound"}}]},
    "events": {"items": [
        {"metadata": {"namespace": "default"}, "type": "Warning", "reason": "BackOff",
         "involvedObject": {"kind": "Pod", "name": "api-2"}, "message": "Back-off", "count": 3,
         "lastTimestamp": "2026-01-02T00:00:00Z"},
        {"metadata": {"namespace": "default"}, "type": "Normal", "reason": "Pulled",
         "involvedObject": {"kind": "Pod", "name": "api-1"}, "message": "ok",
         "eventTime": "2026-01-01T00:00:00Z"}]},
    "namespaces": {"items": [{"metadata": {"name": "default"}, "status": {"phase": "Active"}}]},
}
