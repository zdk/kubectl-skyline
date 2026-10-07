
export const STATUS_COLOR = {
  ok: 0x4bd6bf, warn: 0xe8b452, error: 0xff5a6e, done: 0x7fa3a8, idle: 0x2b4a52, unknown: 0x5a7a80,
};
export const KIND_COLOR = {
  Pod: 0x4bd6bf, ReplicaSet: 0x347d91, Deployment: 0x5ddad4, StatefulSet: 0xab8add, DaemonSet: 0x6cda92,
  Job: 0xe0c070, CronJob: 0xc9a0ff, Service: 0x68baff, Ingress: 0xb48cff, ConfigMap: 0xe2d5a0,
  Secret: 0xe9a78a, PersistentVolumeClaim: 0x9fcbe6, Node: 0x7fa3a8, Namespace: 0x72d6c3,
};
export const CONTAINER_COLOR = { running: 0x3fb8c4, waiting: 0xd9a441, terminated: 0x4a6c7a, failed: 0xd14c5a, unknown: 0x5a7a80 };
export const SHORT = {
  Pod: "pod", ReplicaSet: "rs", Deployment: "deploy", StatefulSet: "sts", DaemonSet: "ds", Job: "job",
  CronJob: "cj", Service: "svc", Ingress: "ing", ConfigMap: "cm", Secret: "secret",
  PersistentVolumeClaim: "pvc", Node: "node", Namespace: "ns",
};
export const KINDS = Object.keys(SHORT);

export const hex = (n) => "#" + n.toString(16).padStart(6, "0");

export function nodeHue(index) {
  return (index * 137.508) % 360;
}
export function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

export function age(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const parseId = (id) => {
  const [kind, namespace, name] = id.split("/");
  return { kind, namespace, name };
};
export const detailURL = (id) => `/detail?id=${encodeURIComponent(id)}`;
export const focusURL = (id) => `/?focus=${encodeURIComponent(id)}`;

export function connect(handlers) {
  const es = new EventSource("/api/events");
  es.addEventListener("snapshot", (e) => handlers.snapshot?.(JSON.parse(e.data)));
  es.addEventListener("event", (e) => handlers.event?.(JSON.parse(e.data)));
  es.addEventListener("metrics", (e) => handlers.metrics?.(JSON.parse(e.data)));
  es.onopen = () => handlers.status?.("live");
  es.onerror = () => handlers.status?.("reconnecting");
  return es;
}

export function containerColor(c) {
  if (c.state === "terminated") return c.reason === "Completed" || c.init ? CONTAINER_COLOR.terminated : CONTAINER_COLOR.failed;
  return CONTAINER_COLOR[c.state] || CONTAINER_COLOR.unknown;
}
