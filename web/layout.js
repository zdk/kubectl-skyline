
export const TREE_KINDS = new Set([
  "Deployment", "ReplicaSet", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod",
]);
export const TILE_KINDS = new Set(["ConfigMap", "Secret", "PersistentVolumeClaim"]);

export const SHAPE = {
  Pod: { w: 2.2, h: 8, sides: 4 },
  ReplicaSet: { w: 2.6, h: 1.0, sides: 4 },
  Deployment: { w: 3.0, h: 3.6, sides: 4, cap: true },
  StatefulSet: { w: 3.4, h: 3.6, sides: 6, cap: true },
  DaemonSet: { w: 3.8, h: 1.4, sides: 4, cap: true },
  Job: { w: 2.2, h: 2.2, sides: 4 },
  CronJob: { w: 2.4, h: 2.4, sides: 4, ring: true },
};
export const TILE_SHAPE = {
  ConfigMap: { w: 1.6, h: 0.12, sides: 4 },
  Secret: { w: 1.7, h: 0.14, sides: 6 },
  PersistentVolumeClaim: { w: 1.8, h: 0.9, sides: 24 },
};
export const X_GAP = 4.8, Y_GAP = 6.5, TILE_CELL = 2.8, NS_PAD = 3, NS_GAP = 9;
export const SERVICE_Z = 14, INGRESS_Z = 22, NODE_ROW_Y = -18;

const byName = (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

export function visibleNodes(snapshot, opts) {
  const referenced = new Set();
  for (const e of snapshot.edges) if (e.kind === "mount") referenced.add(e.to);
  const out = [];
  for (const n of snapshot.nodes) {
    if (opts.namespace && n.namespace && n.namespace !== opts.namespace) continue;
    if (opts.namespace && n.kind === "Namespace" && n.name !== opts.namespace) continue;
    if (opts.hiddenKinds.has(n.kind)) continue;
    if (!opts.showIdle && n.kind === "ReplicaSet" && n.status === "idle") continue;
    if (!opts.showUnused && (n.kind === "ConfigMap" || n.kind === "Secret") && !referenced.has(n.id)) continue;
    out.push(n);
  }
  return out;
}

function pack(layouts, gap, rowGap = gap) {
  if (!layouts.length) return { positions: new Map(), width: 0, height: 0 };
  const area = layouts.reduce((s, l) => s + (l.width + gap) * (l.height + rowGap), 0);
  const target = Math.max(40, ...layouts.map((l) => l.width), Math.sqrt(area) * 1.4);
  const positions = new Map();
  let cx = 0, cy = 0, rowH = 0, width = 0;
  for (const l of layouts) {
    if (cx && cx + l.width > target) {
      cx = 0;
      cy += rowH + rowGap;
      rowH = 0;
    }
    for (const [id, p] of l.positions) positions.set(id, { ...p, x: p.x + cx, y: p.y + cy });
    cx += l.width + gap;
    width = Math.max(width, cx - gap);
    rowH = Math.max(rowH, l.height);
  }
  return { positions, width, height: cy + rowH };
}

const ROW_H = 1;
function buildTree(id, children, depth = 0) {
  const kids = children.get(id) || [];
  const packed = pack(kids.map((c) => buildTree(c, children, depth + 1)), 0, Y_GAP - ROW_H);
  const width = Math.max(X_GAP, packed.width);
  const offsetX = (width - packed.width) / 2;
  const positions = new Map([[id, { x: width / 2, y: 0, depth }]]);
  for (const [cid, p] of packed.positions) positions.set(cid, { ...p, x: p.x + offsetX, y: p.y + Y_GAP });
  return { positions, width, height: ROW_H + (kids.length ? Y_GAP - ROW_H + packed.height : 0) };
}

export function layout(snapshot, visible) {
  const byId = new Map(visible.map((n) => [n.id, n]));
  const edges = snapshot.edges.filter((e) => byId.has(e.from) && byId.has(e.to));

  const parent = new Map();
  for (const n of visible) {
    if (!TREE_KINDS.has(n.kind)) continue;
    const p = n.owner && byId.get(n.owner);
    parent.set(n.id, p && TREE_KINDS.has(p.kind) ? p.id : null);
  }
  const children = new Map();
  for (const [id, p] of parent) {
    if (!children.has(id)) children.set(id, []);
    if (p) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(id);
    }
  }
  for (const list of children.values()) list.sort((a, b) => byName(byId.get(a), byId.get(b)));

  const namespaces = new Map();
  const nsNode = (name) => {
    if (!namespaces.has(name)) namespaces.set(name, { roots: [], tiles: [], services: [], ingresses: [], pods: [] });
    return namespaces.get(name);
  };
  for (const n of visible) {
    if (n.kind === "Namespace") nsNode(n.name);
    else if (!n.namespace) continue;
    else if (TREE_KINDS.has(n.kind)) {
      if (!parent.get(n.id)) nsNode(n.namespace).roots.push(n);
    } else if (TILE_KINDS.has(n.kind)) nsNode(n.namespace).tiles.push(n);
    else if (n.kind === "Service") nsNode(n.namespace).services.push(n);
    else if (n.kind === "Ingress") nsNode(n.namespace).ingresses.push(n);
  }

  const pos = new Map();
  const nsLayouts = [];
  for (const [name, ns] of [...namespaces].sort(([a], [b]) => a.localeCompare(b))) {
    ns.roots.sort(byName);
    ns.tiles.sort(byName);
    const tree = pack(ns.roots.map((r) => buildTree(r.id, children)), 1, Y_GAP - ROW_H);
    const treeW = ns.roots.length ? tree.width : 0;
    const treeH = ns.roots.length ? tree.height + 1 : 0;
    const positions = new Map();
    for (const [id, p] of tree.positions) positions.set(id, { x: p.x, y: p.y + 1, z: 0 });
    let width = treeW, height = treeH;
    if (ns.tiles.length) {
      const cols = Math.min(4, Math.ceil(Math.sqrt(ns.tiles.length)));
      const rows = Math.ceil(ns.tiles.length / cols);
      const x0 = treeW ? treeW + 3 : 0;
      ns.tiles.forEach((t, i) => {
        positions.set(t.id, { x: x0 + (i % cols) * TILE_CELL + TILE_CELL / 2, y: Math.floor(i / cols) * TILE_CELL + 1, z: 0 });
      });
      width = x0 + cols * TILE_CELL;
      height = Math.max(height, rows * TILE_CELL);
    }
    width = Math.max(width, 10);
    height = Math.max(height, 6);
    nsLayouts.push({ name, positions, width: width + NS_PAD * 2, height: height + NS_PAD * 2, ns });
  }
  const packedNS = pack(
    nsLayouts.map((l) => {
      const positions = new Map();
      for (const [id, p] of l.positions) positions.set(id, { ...p, x: p.x + NS_PAD, y: p.y + NS_PAD });
      positions.set("__ns__" + l.name, { x: 0, y: 0, z: 0 });
      return { positions, width: l.width, height: l.height };
    }),
    NS_GAP,
  );
  const nsRects = new Map();
  for (const l of nsLayouts) {
    const origin = packedNS.positions.get("__ns__" + l.name);
    nsRects.set(l.name, { x: origin.x, y: origin.y, w: l.width, h: l.height });
    pos.set("Namespace//" + l.name, { x: origin.x, y: origin.y, z: 0 });
  }
  for (const [id, p] of packedNS.positions) if (!id.startsWith("__ns__")) pos.set(id, p);

  const occupied = new Set();
  const cell = (p) => `${p.x}:${p.y}:${p.z}`;
  const place = (origin, z) => {
    for (let layer = 0; ; layer++)
      for (let slot = 0; slot < 9; slot++) {
        const p = {
          x: Math.round(origin.x / 3) * 3 + ((slot % 3) - 1) * 3,
          y: Math.round(origin.y / 3) * 3 + (Math.floor(slot / 3) - 1) * 3,
          z: z + layer * 3,
        };
        if (occupied.has(cell(p))) continue;
        occupied.add(cell(p));
        return p;
      }
  };
  const targets = new Map();
  for (const e of edges) {
    if (e.kind !== "select" && e.kind !== "route") continue;
    if (!targets.has(e.from)) targets.set(e.from, []);
    targets.get(e.from).push(e.to);
  }
  const centroid = (ids, fallback) => {
    const pts = ids.map((id) => pos.get(id)).filter(Boolean);
    if (!pts.length) return fallback;
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  };
  for (const l of nsLayouts) {
    const r = nsRects.get(l.name);
    l.ns.services.sort(byName).forEach((s, i) => {
      pos.set(s.id, place(centroid(targets.get(s.id) || [], { x: r.x + 2, y: r.y + 2 + i * 3 }), SERVICE_Z));
    });
  }
  for (const l of nsLayouts) {
    const r = nsRects.get(l.name);
    l.ns.ingresses.sort(byName).forEach((s, i) => {
      pos.set(s.id, place(centroid(targets.get(s.id) || [], { x: r.x + 2, y: r.y + 2 + i * 3 }), INGRESS_Z));
    });
  }

  const clusterNodes = visible.filter((n) => n.kind === "Node").sort(byName);
  const nodeRects = new Map();
  clusterNodes.forEach((n, i) => {
    const rect = { x: i * 16, y: NODE_ROW_Y, w: 12, h: 4 };
    nodeRects.set(n.name, rect);
    pos.set(n.id, { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, z: 0 });
  });

  return { pos, ns: nsRects, nodes: nodeRects, edges, byId, parent };
}

export function bounds(pos) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = 0;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    maxZ = Math.max(maxZ, p.z);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 10, maxY: 10, maxZ: 8 };
  return { minX, minY, maxX, maxY, maxZ: Math.max(maxZ, 8) };
}
