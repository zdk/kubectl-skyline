import test from "node:test";
import assert from "node:assert/strict";
import { layout, visibleNodes, bounds, SERVICE_Z, INGRESS_Z } from "../layout.js";

const node = (kind, ns, name, extra = {}) => ({ id: `${kind}/${ns}/${name}`, kind, name, namespace: ns, status: "ok", ...extra });
const snapshot = {
  nodes: [
    node("Namespace", "", "shop"),
    node("Node", "", "worker-1"),
    node("Deployment", "shop", "web"),
    node("ReplicaSet", "shop", "web-1", { owner: "Deployment/shop/web" }),
    node("ReplicaSet", "shop", "web-0", { owner: "Deployment/shop/web", status: "idle" }),
    node("Pod", "shop", "web-1-a", { owner: "ReplicaSet/shop/web-1", clusterNode: "worker-1" }),
    node("Pod", "shop", "web-1-b", { owner: "ReplicaSet/shop/web-1", clusterNode: "worker-1" }),
    node("Service", "shop", "web"),
    node("Ingress", "shop", "web"),
    node("ConfigMap", "shop", "web-config"),
    node("ConfigMap", "shop", "kube-root-ca.crt"),
  ],
  edges: [
    { from: "Deployment/shop/web", to: "ReplicaSet/shop/web-1", kind: "owner" },
    { from: "Deployment/shop/web", to: "ReplicaSet/shop/web-0", kind: "owner" },
    { from: "ReplicaSet/shop/web-1", to: "Pod/shop/web-1-a", kind: "owner" },
    { from: "ReplicaSet/shop/web-1", to: "Pod/shop/web-1-b", kind: "owner" },
    { from: "Service/shop/web", to: "Pod/shop/web-1-a", kind: "select" },
    { from: "Service/shop/web", to: "Pod/shop/web-1-b", kind: "select" },
    { from: "Ingress/shop/web", to: "Service/shop/web", kind: "route" },
    { from: "Pod/shop/web-1-a", to: "ConfigMap/shop/web-config", kind: "mount" },
  ],
};
const opts = { namespace: "", hiddenKinds: new Set(), showIdle: false, showUnused: false };

test("idle replicasets and unused configmaps are hidden by default", () => {
  const ids = visibleNodes(snapshot, opts).map((n) => n.id);
  assert.ok(!ids.includes("ReplicaSet/shop/web-0"));
  assert.ok(!ids.includes("ConfigMap/shop/kube-root-ca.crt"));
  assert.ok(ids.includes("ConfigMap/shop/web-config"));
  const all = visibleNodes(snapshot, { ...opts, showIdle: true, showUnused: true }).map((n) => n.id);
  assert.ok(all.includes("ReplicaSet/shop/web-0") && all.includes("ConfigMap/shop/kube-root-ca.crt"));
});

test("owner tree places children one row further from their parent", () => {
  const lay = layout(snapshot, visibleNodes(snapshot, opts));
  const dep = lay.pos.get("Deployment/shop/web"), rs = lay.pos.get("ReplicaSet/shop/web-1");
  const a = lay.pos.get("Pod/shop/web-1-a"), b = lay.pos.get("Pod/shop/web-1-b");
  assert.ok(rs.y > dep.y && a.y > rs.y && b.y > rs.y);
  assert.notEqual(a.x, b.x);
  assert.equal(lay.parent.get("Pod/shop/web-1-a"), "ReplicaSet/shop/web-1");
  const r = lay.ns.get("shop");
  for (const id of ["Deployment/shop/web", "Pod/shop/web-1-b", "ConfigMap/shop/web-config"]) {
    const p = lay.pos.get(id);
    assert.ok(p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h, id);
  }
});

test("services float above their pods and ingresses above services", () => {
  const lay = layout(snapshot, visibleNodes(snapshot, opts));
  const svc = lay.pos.get("Service/shop/web"), ing = lay.pos.get("Ingress/shop/web");
  assert.equal(svc.z, SERVICE_Z);
  assert.equal(ing.z, INGRESS_Z);
  const a = lay.pos.get("Pod/shop/web-1-a"), b = lay.pos.get("Pod/shop/web-1-b");
  assert.ok(Math.abs(svc.x - (a.x + b.x) / 2) <= 3);
  assert.ok(lay.nodes.has("worker-1"));
  const bb = bounds(lay.pos);
  assert.ok(bb.maxZ >= INGRESS_Z);
});

test("layout is deterministic and stable across identical snapshots", () => {
  const v = visibleNodes(snapshot, opts);
  const a = layout(snapshot, v), b = layout(snapshot, v);
  assert.deepEqual([...a.pos], [...b.pos]);
});

test("diffLines marks removed and added lines", async () => {
  const { diffLines } = await import("../common.js");
  const d = diffLines(["a", "replicas: 1", "c"], ["a", "replicas: 2", "c", "d"]);
  assert.deepEqual(d.map(([op, l]) => op + l), [" a", "-replicas: 1", "+replicas: 2", " c", "+d"]);
});

test("statusDots gives one dot per pod container", async () => {
  const { statusDots } = await import("../common.js");
  const pod = { kind: "Pod", status: "error", containers: [
    { name: "app", state: "running", ready: true },
    { name: "side", state: "waiting", reason: "CrashLoopBackOff" },
  ] };
  assert.deepEqual([...statusDots(pod).matchAll(/st-(\w+)/g)].map((m) => m[1]), ["ok", "error"]);
  assert.match(statusDots({ kind: "Service", status: "warn" }), /st-warn/);
});

test("execCommandFor builds a pasteable kubectl exec", async () => {
  const { execCommandFor } = await import("../common.js");
  assert.equal(execCommandFor("prod", "shop", "web-1", "app"), "kubectl exec -it --context prod -n shop web-1 -c app -- sh");
  assert.equal(execCommandFor("", "shop", "web-1", "app"), "kubectl exec -it -n shop web-1 -c app -- sh");
  assert.match(execCommandFor("my ctx", "shop", "web-1", "app"), /--context 'my ctx' /);
});
