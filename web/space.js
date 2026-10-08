import * as T from "/vendor/three.module.js";
import { OrbitControls } from "/vendor/OrbitControls.js";
import { layout, visibleNodes, bounds, SHAPE, TILE_SHAPE, TREE_KINDS, TILE_KINDS } from "./layout.js";
import {
  STATUS_COLOR, KIND_COLOR, SHORT, KINDS, hex, nodeHue, hslToHex, age, esc, connect, containerColor, detailURL, statusDots,
} from "./common.js";

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: ${id}`);
  return el;
};
const canvas = $("world"), labelCanvas = $("labels");
const ctx2d = labelCanvas.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const renderer = new T.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x03090e);
renderer.outputColorSpace = T.SRGBColorSpace;
const scene = new T.Scene();
scene.fog = new T.FogExp2(0x03090e, 0.0015);
const camera = new T.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1500);
camera.up.set(0, 0, 1);
camera.position.set(65, -85, 70);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.screenSpacePanning = false;
controls.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.PAN };
controls.target.set(40, 30, 0);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

const grid = new T.GridHelper(2000, 200, 0x0c1f26, 0x08161c);
grid.rotation.x = Math.PI / 2;
grid.position.z = -0.1;
scene.add(grid);

const group = new T.Group();
scene.add(group);

let snapshot = null;
let visible = [];
let lay = null;
let selected = null, hovered = null;
let firstView = true;
const hiddenKinds = new Set();
let nsFilter = "", showIdle = false, showUnused = false;
const glows = new Map();
const usage = new Map();
let particles = [];
const PARTICLE_CAP = 3000;
let prevIds = new Set();
let prevPos = new Map();
let nodeHues = new Map();
let fly = null;

let picks = [];
let labels = [];
let lineSets = [];
let towerIds = [], basePlate = null, glowPlate = null, haloPlate = null, towerPos = new Map();
let selectionBox = null, relationLines = null, relationFlows = [], lastFlow = 0;
let labelFocus = new Set();
let arrows = [];
const REL_LINE = { owner: 0x2a6a66, select: 0x2f7fa0, route: 0x6f5fa8, mount: 0x7a6a45 };
let pickedContainer = null;
const dummy = new T.Object3D();

const pg = new T.BufferGeometry();
const pPos = new Float32Array(PARTICLE_CAP * 3), pCol = new Float32Array(PARTICLE_CAP * 3);
pg.setAttribute("position", new T.BufferAttribute(pPos, 3));
pg.setAttribute("color", new T.BufferAttribute(pCol, 3));
pg.setDrawRange(0, 0);
const points = new T.Points(pg, new T.PointsMaterial({ size: 0.45, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true }));
points.frustumCulled = false;
scene.add(points);

const statusColor = (n) => STATUS_COLOR[n.status] || STATUS_COLOR.unknown;
const shape = (n) => SHAPE[n.kind] || TILE_SHAPE[n.kind] || SHAPE.Pod;
const GLYPH = {
  Pod: "▮", ReplicaSet: "▭", Deployment: "▬", StatefulSet: "⬢", DaemonSet: "▰", Job: "■", CronJob: "◷",
  Service: "◆", Ingress: "◯", ConfigMap: "▱", Secret: "⬣", PersistentVolumeClaim: "●", Node: "▭", Namespace: "⬚",
};
const geometries = new Map();
function geomFor(sides) {
  if (!geometries.has(sides)) {
    const g = sides === 4 ? new T.BoxGeometry(1, 1, 1) : new T.CylinderGeometry(0.5, 0.5, 1, sides).rotateX(Math.PI / 2).rotateZ(Math.PI / sides);
    geometries.set(sides, g);
  }
  return geometries.get(sides);
}
function instanced(sides, items, material) {
  const mesh = new T.InstancedMesh(geomFor(sides), material, Math.max(1, items.length));
  mesh.count = items.length;
  items.forEach((it, i) => {
    dummy.position.set(it.x, it.y, it.z); dummy.scale.set(it.sx, it.sy, Math.max(0.0001, it.sz)); dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, new T.Color(it.color ?? 0xffffff));
  });
  mesh.frustumCulled = false;
  group.add(mesh);
  return mesh;
}
function topOf(id) {
  const p = lay.pos.get(id), n = lay.byId.get(id);
  if (!p || !n) return null;
  const h = TREE_KINDS.has(n.kind) || TILE_KINDS.has(n.kind) ? shape(n).h : n.kind === "Node" ? 0.8 : 0;
  return new T.Vector3(p.x, p.y, p.z + h);
}

class LineBuilder {
  constructor(opacity = 0.7) {
    this.pos = []; this.col = []; this.segs = []; this.opacity = opacity;
  }
  add(a, b, color, ids = null) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    const c = new T.Color(color);
    this.col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    this.segs.push(ids);
  }
  build(renderOrder = 0) {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(this.pos, 3));
    const col = new T.Float32BufferAttribute(this.col, 3);
    g.setAttribute("color", col);
    const lines = new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: this.opacity, depthWrite: false }));
    lines.renderOrder = renderOrder;
    lines.frustumCulled = false;
    group.add(lines);
    lineSets.push({ lines, base: Float32Array.from(this.col), segs: this.segs });
    return lines;
  }
}

function polygon(sides, r) {
  const pts = [];
  for (let j = 0; j < sides; j++) {
    const a = (j / sides) * Math.PI * 2 + (sides === 4 ? Math.PI / 4 : Math.PI / sides + Math.PI / 2);
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}
function prismEdges(lb, x, y, z0, w, h, sides, ringColor, postColor, ids) {
  const r = sides === 4 ? w / Math.SQRT2 : w / 2;
  const c = polygon(sides, r);
  for (const z of [z0, z0 + h])
    for (let j = 0; j < sides; j++) lb.add([x + c[j][0], y + c[j][1], z], [x + c[(j + 1) % sides][0], y + c[(j + 1) % sides][1], z], ringColor, ids);
  const step = sides > 8 ? sides / 4 : 1;
  for (let j = 0; j < sides; j += step) lb.add([x + c[j][0], y + c[j][1], z0], [x + c[j][0], y + c[j][1], z0 + h], postColor, ids);
}
function circleEdges(lb, x, y, z, r, color, ids, segments = 24) {
  const c = polygon(segments, r);
  for (let j = 0; j < segments; j++) lb.add([x + c[j][0], y + c[j][1], z], [x + c[(j + 1) % segments][0], y + c[(j + 1) % segments][1], z], color, ids);
}
const boxEdges = (lb, x, y, z0, w, h, ringColor, postColor, ids) => prismEdges(lb, x, y, z0, w, h, 4, ringColor, postColor, ids);
function octaEdges(lb, p, r, color, ids) {
  const v = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]].map(([x, y, z]) => [p.x + x, p.y + y, p.z + z]);
  const pairs = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]];
  for (const [a, b] of pairs) lb.add(v[a], v[b], color, ids);
}
function rectEdges(lb, r, z, color, ids) {
  const c = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  for (let j = 0; j < 4; j++) lb.add([c[j][0], c[j][1], z], [c[(j + 1) % 4][0], c[(j + 1) % 4][1], z], color, ids);
}

function disposeGroup() {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  group.clear();
  picks = []; labels = []; lineSets = []; towerIds = []; towerPos = new Map(); arrows = [];
  basePlate = glowPlate = haloPlate = null;
  selectionBox = null; relationLines = null; relationFlows = [];
}

function rebuild() {
  if (!snapshot) return;
  visible = visibleNodes(snapshot, { namespace: nsFilter, hiddenKinds, showIdle, showUnused });
  lay = layout(snapshot, visible);
  const nodeNames = [...new Set(snapshot.nodes.filter((n) => n.kind === "Node").map((n) => n.name))].sort();
  nodeHues = new Map(nodeNames.map((name, i) => [name, hslToHex(nodeHue(i) + 170, 55, 48)]));
  buildScene();
  animateChanges();
  updateCounts();
  if (firstView && visible.length) {
    fit();
    firstView = false;
    const focus = new URLSearchParams(location.search).get("focus");
    if (focus && lay.byId.has(focus)) select(focus, true);
  }
  if (selected && !lay.byId.has(selected)) clearSelection();
  else if (selected) { showDetails(selected); updateSelection(); }
}

function buildScene() {
  disposeGroup();
  const frame = new LineBuilder(0.75);
  const floor = new LineBuilder(0.55);
  const links = new LineBuilder(0.6);

  for (const [name, r] of lay.ns) {
    const id = "Namespace//" + name;
    const n = lay.byId.get(id);
    const plane = new T.Mesh(new T.PlaneGeometry(r.w, r.h), new T.MeshBasicMaterial({ color: 0x4bd6bf, transparent: true, opacity: 0.035, depthWrite: false, side: T.DoubleSide }));
    plane.position.set(r.x + r.w / 2, r.y + r.h / 2, -0.03);
    group.add(plane);
    picks.push({ object: plane, ids: [id] });
    const col = n && n.status === "warn" ? 0x8a6a2a : 0x1c4a52;
    rectEdges(frame, r, 0.02, col, [id, id]);
    const L = Math.min(2.5, r.w / 4, r.h / 4);
    for (const [cx, cy, sx, sy] of [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1], [r.x + r.w, r.y + r.h, -1, -1], [r.x, r.y + r.h, 1, -1]]) {
      frame.add([cx, cy, 0.04], [cx + sx * L, cy, 0.04], 0x3f9a92, [id, id]);
      frame.add([cx, cy, 0.04], [cx, cy + sy * L, 0.04], 0x3f9a92, [id, id]);
    }
    labels.push({ id, x: r.x + 0.4, y: r.y + 0.2, z: 0, text: name, kind: "Namespace", prio: 2, anchor: "corner" });
  }

  const towers = visible.filter((n) => TREE_KINDS.has(n.kind) && lay.pos.has(n.id));
  towerIds = towers.map((n) => n.id);
  const count = Math.max(1, towers.length);
  const hulls = new Map();
  const mkPlate = (opacity, blending) => {
    const m = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false, blending }), count);
    m.count = towers.length; m.frustumCulled = false;
    return m;
  };
  basePlate = mkPlate(0.9, T.NormalBlending);
  glowPlate = mkPlate(0.95, T.AdditiveBlending);
  haloPlate = mkPlate(0.32, T.AdditiveBlending);
  const layersList = [], caps = [];
  towers.forEach((n, i) => {
    const p = lay.pos.get(n.id), s = shape(n);
    towerPos.set(n.id, p);
    if (!hulls.has(s.sides)) hulls.set(s.sides, { items: [], ids: [] });
    hulls.get(s.sides).items.push({ x: p.x, y: p.y, z: s.h / 2, sx: s.w, sy: s.w, sz: s.h, color: 0x4bd6bf });
    hulls.get(s.sides).ids.push(n.id);
    dummy.position.set(p.x, p.y, -0.035); dummy.scale.set(s.w + 0.08, s.w + 0.08, 0.07); dummy.updateMatrix();
    basePlate.setMatrixAt(i, dummy.matrix);
    glowPlate.setMatrixAt(i, dummy.matrix);
    glowPlate.setColorAt(i, new T.Color(0));
    dummy.position.z = -0.075; dummy.scale.set(s.w + 0.95, s.w + 0.95, 0.025); dummy.updateMatrix();
    haloPlate.setMatrixAt(i, dummy.matrix);
    haloPlate.setColorAt(i, new T.Color(0));
    const nodeColor = n.kind === "Pod" && n.clusterNode && nodeHues.has(n.clusterNode) ? nodeHues.get(n.clusterNode) : 0x0d2630;
    basePlate.setColorAt(i, new T.Color(nodeColor).multiplyScalar(n.kind === "Pod" ? 0.55 : 1));
    const ring = statusColor(n), post = KIND_COLOR[n.kind] || 0x4bd6bf;
    const dim = n.status === "idle" || n.status === "done";
    prismEdges(frame, p.x, p.y, 0, s.w, s.h, s.sides, ring, dim ? 0x2b4a52 : post, [n.id, n.id]);
    if (s.ring) {
      circleEdges(frame, p.x, p.y, s.h + 0.35, s.w * 0.42, dim ? 0x2b4a52 : post, [n.id, n.id]);
      frame.add([p.x, p.y, s.h + 0.35], [p.x, p.y + s.w * 0.3, s.h + 0.35], post, [n.id, n.id]);
      frame.add([p.x, p.y, s.h + 0.35], [p.x + s.w * 0.18, p.y, s.h + 0.35], post, [n.id, n.id]);
    }
    if (n.kind === "Pod") {
      const cs = n.containers?.length ? n.containers : [{ state: "unknown" }];
      const usable = s.h - 0.8, gap = 0.18;
      const lh = (usable - gap * (cs.length - 1)) / cs.length;
      cs.forEach((c, j) => {
        const z = 0.4 + j * (lh + gap);
        layersList.push({ id: c.name ? n.id + "#" + c.name : null, x: p.x, y: p.y, z, h: lh, w: s.w - 0.08, color: containerColor(c), init: !!c.init });
        if (c.name) labels.push({ id: n.id, x: p.x, y: p.y, z: z + lh / 2, text: (c.init ? "init " : "") + c.name, kind: "Container", prio: 8, color: containerColor(c) });
      });
    } else {
      if (s.cap) caps.push({ x: p.x, y: p.y, z: s.h, sx: s.w - 0.3, sy: s.w - 0.3, sz: 0.1, sides: s.sides, color: new T.Color(dim ? 0x2b4a52 : post).multiplyScalar(0.6).getHex() });
      const desired = Math.min(Math.max(n.desired || 0, 0), 64), ready = Math.min(Math.max(n.ready || 0, 0), desired);
      if (desired > 0) {
        const bh = Math.min(0.6, (s.h - 0.6) / desired), bw = s.w - 0.6;
        for (let k = 0; k < desired; k++) layersList.push({ x: p.x, y: p.y, z: 0.3 + k * (bh + 0.1), h: bh, w: bw, sides: s.sides, color: k < ready ? post : 0x2b4a52 });
      }
    }
    const parent = lay.parent.get(n.id);
    if (parent && lay.pos.has(parent)) {
      const pp = lay.pos.get(parent);
      floor.add([pp.x, pp.y, 0.06], [p.x, p.y, 0.06], REL_LINE.owner, [parent, n.id]);
      arrows.push({ from: [pp.x, pp.y, 0.06], to: [p.x, p.y, 0.06], back: s.w / 2 + 0.2, color: REL_LINE.owner });
    }
    labels.push({ id: n.id, x: p.x, y: p.y, z: s.h + 0.3, text: n.name, kind: n.kind, prio: n.kind === "Pod" ? 6 : 5 });
  });
  for (const m of [basePlate, haloPlate, glowPlate]) m.frustumCulled = false;
  group.add(basePlate, haloPlate, glowPlate);
  for (const [sides, h] of hulls) {
    const mesh = instanced(sides, h.items, new T.MeshBasicMaterial({ transparent: true, opacity: 0.03, depthWrite: false }));
    picks.push({ object: mesh, ids: h.ids });
  }
  const bySides = (list) => {
    const m = new Map();
    for (const it of list) { const k = it.sides || 4; if (!m.has(k)) m.set(k, []); m.get(k).push(it); }
    return m;
  };
  for (const [sides, list] of bySides(layersList)) {
    const mesh = instanced(sides, list.map((l) => ({ x: l.x, y: l.y, z: l.z + l.h / 2, sx: l.w, sy: l.w, sz: l.h, color: l.color })), new T.MeshBasicMaterial({ transparent: true, opacity: 0.28, depthWrite: true }));
    picks.push({ object: mesh, ids: list.map((l) => l.id) });
  }
  for (const [sides, list] of bySides(caps)) instanced(sides, list, new T.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false, blending: T.AdditiveBlending }));

  const markers = (kind, geometry, radius, baseColor, edges) => {
    const list = visible.filter((n) => n.kind === kind && lay.pos.has(n.id));
    const mesh = new T.InstancedMesh(geometry, new T.MeshBasicMaterial({ transparent: true, opacity: 0.28, depthWrite: false }), Math.max(1, list.length));
    mesh.count = list.length;
    list.forEach((n, i) => {
      const p = lay.pos.get(n.id);
      dummy.position.set(p.x, p.y, p.z); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const col = n.status === "warn" ? STATUS_COLOR.warn : n.status === "idle" ? 0x3a5a6a : baseColor;
      mesh.setColorAt(i, new T.Color(col));
      edges(p, col, [n.id, n.id]);
      floor.add([p.x, p.y, 0.06], [p.x, p.y, p.z - radius], 0x16343a, [n.id, n.id]);
      labels.push({ id: n.id, x: p.x, y: p.y, z: p.z + radius + 0.3, text: n.name, kind, prio: kind === "Ingress" ? 3 : 4 });
    });
    mesh.frustumCulled = false;
    group.add(mesh);
    picks.push({ object: mesh, ids: list.map((n) => n.id) });
  };
  markers("Service", new T.OctahedronGeometry(1.0, 0), 1.0, KIND_COLOR.Service, (p, col, ids) => octaEdges(frame, p, 1.0, col, ids));
  markers("Ingress", new T.TorusGeometry(1.4, 0.28, 8, 24), 0.3, KIND_COLOR.Ingress, (p, col, ids) => {
    circleEdges(frame, p.x, p.y, p.z, 1.7, col, ids);
    circleEdges(frame, p.x, p.y, p.z, 1.1, col, ids);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) frame.add([p.x + dx * 1.1, p.y + dy * 1.1, p.z], [p.x + dx * 1.7, p.y + dy * 1.7, p.z], col, ids);
  });

  const tiles = visible.filter((n) => TILE_KINDS.has(n.kind) && lay.pos.has(n.id));
  const tileItems = new Map();
  for (const n of tiles) {
    const p = lay.pos.get(n.id), s = shape(n);
    const col = n.status === "error" ? STATUS_COLOR.error : n.status === "warn" ? STATUS_COLOR.warn : KIND_COLOR[n.kind];
    if (!tileItems.has(s.sides)) tileItems.set(s.sides, { items: [], ids: [] });
    tileItems.get(s.sides).items.push({ x: p.x, y: p.y, z: s.h / 2, sx: s.w, sy: s.w, sz: s.h, color: col });
    tileItems.get(s.sides).ids.push(n.id);
    prismEdges(frame, p.x, p.y, 0, s.w, s.h, s.sides, col, col, [n.id, n.id]);
    labels.push({ id: n.id, x: p.x, y: p.y, z: s.h + 0.25, text: n.name, kind: n.kind, prio: 7 });
  }
  for (const [sides, t] of tileItems) {
    const mesh = instanced(sides, t.items, new T.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: true }));
    picks.push({ object: mesh, ids: t.ids });
  }

  const cnodes = visible.filter((n) => n.kind === "Node" && lay.nodes.has(n.name));
  const slab = new T.InstancedMesh(new T.BoxGeometry(1, 1, 1), new T.MeshBasicMaterial({ transparent: true, opacity: 0.12, depthWrite: false }), Math.max(1, cnodes.length));
  slab.count = cnodes.length;
  cnodes.forEach((n, i) => {
    const r = lay.nodes.get(n.name);
    dummy.position.set(r.x + r.w / 2, r.y + r.h / 2, 0.4); dummy.scale.set(r.w, r.h, 0.8); dummy.updateMatrix();
    slab.setMatrixAt(i, dummy.matrix);
    const hue = nodeHues.get(n.name) || 0x7fa3a8;
    slab.setColorAt(i, new T.Color(hue));
    const ring = n.status === "ok" ? hue : statusColor(n);
    const hw = r.w / 2, hh = r.h / 2, cx = r.x + hw, cy = r.y + hh;
    const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    for (const z of [0, 0.8]) for (let j = 0; j < 4; j++) frame.add([cx + c[j][0], cy + c[j][1], z], [cx + c[(j + 1) % 4][0], cy + c[(j + 1) % 4][1], z], ring, [n.id, n.id]);
    for (const [x, y] of c) frame.add([cx + x, cy + y, 0], [cx + x, cy + y, 0.8], hue, [n.id, n.id]);
    labels.push({ id: n.id, x: cx, y: cy, z: 1.1, text: n.name, kind: "Node", prio: 2 });
  });
  slab.frustumCulled = false;
  group.add(slab);
  picks.push({ object: slab, ids: cnodes.map((n) => n.id) });

  for (const e of lay.edges) {
    const a = lay.pos.get(e.from), b = lay.pos.get(e.to);
    if (!a || !b) continue;
    if (e.kind === "select") {
      const t = topOf(e.to);
      links.add([a.x, a.y, a.z - 1], [t.x, t.y, t.z], REL_LINE.select, [e.from, e.to]);
      arrows.push({ from: [a.x, a.y, a.z - 1], to: [t.x, t.y, t.z], back: 0.5, color: REL_LINE.select });
    } else if (e.kind === "route") {
      links.add([a.x, a.y, a.z - 0.3], [b.x, b.y, b.z + 1], REL_LINE.route, [e.from, e.to]);
      arrows.push({ from: [a.x, a.y, a.z - 0.3], to: [b.x, b.y, b.z + 1], back: 0.5, color: REL_LINE.route });
    } else if (e.kind === "mount") {
      links.add([a.x, a.y, 0.12], [b.x, b.y, 0.12], REL_LINE.mount, [e.from, e.to]);
      arrows.push({ from: [a.x, a.y, 0.12], to: [b.x, b.y, 0.12], back: shape(lay.byId.get(e.to)).w / 2 + 0.3, color: REL_LINE.mount });
    }
  }
  floor.build(-1);
  links.build(-1);
  frame.build(0);
  const cone = new T.InstancedMesh(new T.ConeGeometry(0.18, 0.55, 6), new T.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }), Math.max(1, arrows.length));
  cone.count = arrows.length;
  const up = new T.Vector3(0, 1, 0), dir = new T.Vector3(), tip = new T.Vector3();
  arrows.forEach((ar, i) => {
    const a = new T.Vector3(...ar.from), b = new T.Vector3(...ar.to);
    dir.subVectors(b, a);
    const len = dir.length();
    if (len < ar.back + 0.6) { dummy.scale.set(0, 0, 0); dummy.updateMatrix(); cone.setMatrixAt(i, dummy.matrix); return; }
    dir.normalize();
    tip.copy(b).addScaledVector(dir, -ar.back);
    dummy.position.copy(tip).addScaledVector(dir, -0.27);
    dummy.quaternion.setFromUnitVectors(up, dir);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    cone.setMatrixAt(i, dummy.matrix);
    cone.setColorAt(i, new T.Color(ar.color).multiplyScalar(1.6));
  });
  dummy.quaternion.identity();
  cone.frustumCulled = false;
  group.add(cone);

  const b = bounds(lay.pos);
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY, 40);
  camera.far = Math.max(1500, extent * 4);
  camera.updateProjectionMatrix();
  scene.fog.density = Math.min(0.0015, 0.8 / extent);
  updateSelection();
}

function animateChanges() {
  const now = performance.now();
  const ids = new Set(lay.pos.keys());
  if (prevIds.size && !reduced) {
    for (const id of ids) {
      if (prevIds.has(id)) continue;
      const p = lay.pos.get(id), parent = lay.parent?.get(id);
      const n = lay.byId.get(id);
      if (!n) continue;
      const top = topOf(id) || new T.Vector3(p.x, p.y, p.z);
      if (parent && lay.pos.has(parent)) {
        const pp = lay.pos.get(parent);
        const curve = new T.QuadraticBezierCurve3(new T.Vector3(pp.x, pp.y, 0.3), new T.Vector3((pp.x + p.x) / 2, (pp.y + p.y) / 2, 3), new T.Vector3(p.x, p.y, 0.3));
        for (let k = 0; k < 4; k++) particles.push({ start: now + k * 90, duration: 1400, curve, color: 0xd6fff4 });
      }
      spark(top, 0x9ff5e0, 6, now);
      glows.set(id, { t0: now, warn: false });
    }
    for (const id of prevIds) {
      if (ids.has(id)) continue;
      const p = prevPos.get(id);
      if (p) spark(new T.Vector3(p.x, p.y, p.z + 1), 0xff6e7a, 8, now, -1);
    }
  }
  prevIds = ids;
  prevPos = new Map(lay.pos);
}
function spark(at, color, count, now, dir = 1) {
  for (let k = 0; k < count; k++) {
    const a = Math.random() * Math.PI * 2, r = 0.3 + Math.random() * 0.9;
    const end = at.clone().add(new T.Vector3(Math.cos(a) * r, Math.sin(a) * r, dir * (3 + Math.random() * 4)));
    particles.push({ start: now + Math.random() * 200, duration: 1200 + Math.random() * 600, curve: new T.LineCurve3(at.clone(), end), color });
  }
  if (particles.length > PARTICLE_CAP) particles = particles.slice(-PARTICLE_CAP);
}

const REL_COLOR = { owner: 0x7ff5d8, child: 0x7ff5d8, select: 0x7fc4ff, route: 0xc9a8ff, mount: 0xf0dca0, node: 0x9fc9c2, namespace: 0x72d6c3 };
function anchorOf(id) {
  const n = lay.byId.get(id);
  if (!n) return null;
  if (n.kind === "Namespace" || n.kind === "Node") return centerOf(n).setZ(n.kind === "Node" ? 0.8 : 0.1);
  const t = topOf(id);
  if (!t) return null;
  if (n.kind === "Service" || n.kind === "Ingress") t.z -= n.kind === "Ingress" ? 1.4 : 1;
  return t;
}
function updateSelection() {
  if (selectionBox) { group.remove(selectionBox); selectionBox.geometry.dispose(); selectionBox = null; }
  if (relationLines) { group.remove(relationLines); relationLines.geometry.dispose(); relationLines = null; }
  relationFlows = [];
  const active = new Set();
  const relations = [];
  if (selected && lay?.byId.has(selected)) {
    const n = lay.byId.get(selected), p = lay.pos.get(selected);
    let geo;
    if (TREE_KINDS.has(n.kind)) {
      const s = shape(n); geo = new T.BoxGeometry(s.w + 0.4, s.w + 0.4, s.h + 0.4); dummy.position.set(p.x, p.y, s.h / 2);
    } else if (n.kind === "Service") {
      geo = new T.OctahedronGeometry(1.4, 0); dummy.position.set(p.x, p.y, p.z);
    } else if (n.kind === "Ingress") {
      geo = new T.BoxGeometry(3.8, 3.8, 1.0); dummy.position.set(p.x, p.y, p.z);
    } else if (TILE_KINDS.has(n.kind)) {
      const s = shape(n); geo = new T.BoxGeometry(s.w + 0.4, s.w + 0.4, s.h + 0.4); dummy.position.set(p.x, p.y, s.h / 2);
    } else if (n.kind === "Node") {
      const r = lay.nodes.get(n.name); geo = new T.BoxGeometry(r.w + 0.6, r.h + 0.6, 1.4); dummy.position.set(r.x + r.w / 2, r.y + r.h / 2, 0.4);
    } else if (n.kind === "Namespace") {
      const r = lay.ns.get(n.name); geo = new T.BoxGeometry(r.w + 0.4, r.h + 0.4, 0.3); dummy.position.set(r.x + r.w / 2, r.y + r.h / 2, 0.1);
    }
    if (geo) {
      selectionBox = new T.LineSegments(new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: 0xd1ffce, transparent: true, opacity: 0.9, depthWrite: false }));
      selectionBox.position.copy(dummy.position);
      selectionBox.renderOrder = 2;
      group.add(selectionBox);
      geo.dispose();
    }
    active.add(selected);
    for (const e of lay.edges) {
      if (e.from === selected) { active.add(e.to); relations.push({ id: e.to, kind: e.kind, from: selected, to: e.to }); }
      if (e.to === selected) { active.add(e.from); relations.push({ id: e.from, kind: e.kind, from: e.from, to: selected }); }
    }
    if (n.clusterNode && lay.pos.has("Node//" + n.clusterNode)) {
      active.add("Node//" + n.clusterNode); relations.push({ id: "Node//" + n.clusterNode, kind: "node", from: selected, to: "Node//" + n.clusterNode });
    }
    if (n.namespace && lay.pos.has("Namespace//" + n.namespace)) {
      active.add("Namespace//" + n.namespace); relations.push({ id: "Namespace//" + n.namespace, kind: "namespace", from: "Namespace//" + n.namespace, to: selected });
    }
    if (n.kind === "Node") for (const m of visible) if (m.clusterNode === n.name) { active.add(m.id); relations.push({ id: m.id, kind: "node", from: selected, to: m.id }); }
    if (n.kind === "Namespace") for (const m of visible) if (m.namespace === n.name && TREE_KINDS.has(m.kind) && !lay.parent.get(m.id)) { active.add(m.id); relations.push({ id: m.id, kind: "namespace", from: selected, to: m.id }); }

    const lb = new LineBuilder(0.9);
    const from = anchorOf(selected);
    for (const r of relations.slice(0, 300)) {
      const to = anchorOf(r.id);
      if (!from || !to) continue;
      const a = r.from === selected ? from : to, b = r.from === selected ? to : from;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.z = Math.max(a.z, b.z) + Math.min(6, a.distanceTo(b) * 0.25) + 1;
      const curve = new T.QuadraticBezierCurve3(a, mid, b);
      const pts = curve.getPoints(16);
      for (let i = 0; i < pts.length - 1; i++) lb.add(pts[i].toArray(), pts[i + 1].toArray(), REL_COLOR[r.kind] || 0xffffff, null);
      relationFlows.push({ curve, color: REL_COLOR[r.kind] || 0xffffff });
    }
    if (lb.pos.length) {
      relationLines = lb.build(3);
      lineSets.pop();
    }
  }
  labelFocus = active;
  for (const set of lineSets) {
    const col = set.lines.geometry.attributes.color;
    for (let i = 0; i < set.segs.length; i++) {
      const ids = set.segs[i];
      const hit = selected && ids && (active.has(ids[0]) && active.has(ids[1]));
      const factor = !selected ? 1 : hit ? 2.2 : 0.55;
      for (let k = 0; k < 6; k++) col.array[i * 6 + k] = Math.min(1, set.base[i * 6 + k] * factor);
    }
    col.needsUpdate = true;
  }
}
function select(id, flyTo = false) {
  const [objId, container] = id.split("#");
  id = objId;
  pickedContainer = container || null;
  selected = id;
  $("details").hidden = false;
  showDetails(id);
  updateSelection();
  if (flyTo) flyToObject(id);
  history.replaceState(null, "", id ? `?focus=${encodeURIComponent(id)}` : "/");
}
function clearSelection() {
  selected = null;
  $("details").hidden = true;
  updateSelection();
  history.replaceState(null, "", "/");
}
function flyToObject(id) {
  const t = topOf(id) || (lay.pos.get(id) && new T.Vector3().copy(lay.pos.get(id)));
  if (!t) return;
  const n = lay.byId.get(id);
  const big = n.kind === "Namespace" || n.kind === "Node";
  const target = big ? centerOf(n) : t.clone().setZ(t.z / 2);
  const dist = big ? Math.max(30, (n.kind === "Namespace" ? Math.max(lay.ns.get(n.name).w, lay.ns.get(n.name).h) : 16) * 1.3) : 22;
  const dir = new T.Vector3(0.45, -0.75, 0.55).normalize();
  fly = { t0: performance.now(), dur: reduced ? 1 : 700, fromP: camera.position.clone(), fromT: controls.target.clone(), toP: target.clone().add(dir.multiplyScalar(dist)), toT: target };
}
function centerOf(n) {
  const r = n.kind === "Namespace" ? lay.ns.get(n.name) : lay.nodes.get(n.name);
  return new T.Vector3(r.x + r.w / 2, r.y + r.h / 2, 0);
}
function fit() {
  const b = bounds(lay.pos);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const extent = Math.max(b.maxX - b.minX, (b.maxY - b.minY) * (innerWidth / innerHeight) * 0.9, 30);
  const dir = new T.Vector3(-0.3, -0.75, 0.6).normalize();
  const target = new T.Vector3(cx, cy, 2);
  fly = { t0: performance.now(), dur: firstView || reduced ? 1 : 700, fromP: camera.position.clone(), fromT: controls.target.clone(), toP: target.clone().add(dir.multiplyScalar(extent * 0.62 + 10)), toT: target };
}

function kindOf(id) { return lay?.byId.get(id)?.kind || id.split("/")[0]; }
function showDetails(id) {
  const n = lay.byId.get(id);
  if (!n) return;
  $("d-kind").textContent = "SELECTED " + n.kind.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
  $("d-name").textContent = n.name;
  $("d-meta").innerHTML = (n.namespace ? `<a data-id="Namespace//${esc(n.namespace)}">ns ${esc(n.namespace)}</a> · ` : "") + `age ${age(n.created)}` + (n.clusterNode ? ` · <a data-id="Node//${esc(n.clusterNode)}">on ${esc(n.clusterNode)}</a>` : "");
  const ph = $("d-phase"); ph.textContent = n.phase || n.status; ph.className = "pill phase st-" + n.status; ph.style.borderColor = "currentColor";
  $("d-summary").innerHTML = `${statusDots(n)} ${esc(n.summary || "")}`;
  $("d-facts").innerHTML = (n.facts || []).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const cs = n.containers || [];
  $("d-containers").innerHTML = cs.length ? `<div class="sub"><div class="eyebrow">CONTAINERS</div>` + cs.map((c) => `<div class="ctr${c.name === pickedContainer ? " on" : ""}" data-c="${esc(c.name)}"><i style="color:${hex(containerColor(c))};background:${hex(containerColor(c))}"></i><b>${esc(c.name)}</b>${c.init ? " <span class=st-done>init</span>" : ""} · ${esc(c.state)}${c.reason ? " (" + esc(c.reason) + ")" : ""}${c.restarts ? ` · ${c.restarts} restarts` : ""}${c.cpuReq || c.memReq ? ` · req ${esc(c.cpuReq || "-")}/${esc(c.memReq || "-")}` : ""}<code>${esc(c.image)}</code></div>`).join("") + `</div>` : "";
  $("d-open").href = detailURL(id);
  $("d-open").textContent = n.kind === "Pod" ? "Open YAML, events & logs ↗" : "Open YAML & events ↗";
  const rel = [];
  const push = (label, rid) => { const m = lay.byId.get(rid) || snapshot.nodes.find((x) => x.id === rid); if (m) rel.push({ label, id: rid, name: m.name, kind: m.kind, status: m.status }); };
  if (n.owner) push("owner", n.owner);
  if (n.clusterNode) push("runs on", "Node//" + n.clusterNode);
  if (n.namespace) push("namespace", "Namespace//" + n.namespace);
  for (const e of snapshot.edges) {
    if (e.from === id) push(e.kind === "owner" ? "child" : e.kind === "select" ? "selects" : e.kind === "route" ? "routes to" : "uses", e.to);
    else if (e.to === id) push(e.kind === "owner" ? "" : e.kind === "select" ? "exposed by" : e.kind === "route" ? "ingress" : "used by", e.from);
  }
  const seen = new Set();
  $("d-related").innerHTML = rel.filter((r) => r.label && !seen.has(r.id) && seen.add(r.id)).slice(0, 80).map((r) => `<a data-id="${esc(r.id)}"><span>${esc(r.label.toUpperCase())}</span><span class="st-${r.status}">●</span> ${esc(SHORT[r.kind] || r.kind)}/${esc(r.name)}</a>`).join("") || `<span class="st-idle">nothing linked</span>`;
  const lbls = Object.entries(n.labels || {});
  $("d-labels-wrap").hidden = !lbls.length;
  $("d-labels").innerHTML = lbls.map(([k, v]) => `<code>${esc(k)}=${esc(v)}</code>`).join("");
}
$("details").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-id]");
  if (!a) return;
  e.preventDefault();
  const id = a.dataset.id;
  if (lay.byId.has(id)) select(id, true);
});
$("close").onclick = clearSelection;
function highlightContainer(name) {
  pickedContainer = name;
  for (const el of document.querySelectorAll("#d-containers .ctr")) el.classList.toggle("on", el.dataset.c === name);
  document.querySelector("#d-containers .ctr.on")?.scrollIntoView({ block: "nearest" });
}

function updateCounts() {
  const c = (f) => visible.filter(f).length;
  $("c-pods").textContent = c((n) => n.kind === "Pod");
  $("c-work").textContent = c((n) => ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"].includes(n.kind));
  $("c-svc").textContent = c((n) => n.kind === "Service");
  $("c-ns").textContent = lay.ns.size;
  $("c-nodes").textContent = c((n) => n.kind === "Node");
  const sel = $("namespace");
  const names = [...new Set(snapshot.nodes.filter((n) => n.namespace).map((n) => n.namespace).concat(snapshot.nodes.filter((n) => n.kind === "Namespace").map((n) => n.name)))].sort();
  const current = sel.value;
  sel.innerHTML = `<option value="">All namespaces</option>` + names.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
  sel.value = names.includes(current) ? current : "";
}
function buildKindToggles() {
  const box = $("kinds");
  box.innerHTML = `<label class="wide all"><input type="checkbox" id="all-kinds" checked>all kinds</label>` + KINDS.map((k) => `<label title="${k}"><input type="checkbox" data-kind="${k}" checked><b style="color:${hex(KIND_COLOR[k])}">${GLYPH[k]}</b>${SHORT[k]}</label>`).join("") +
    `<label class="wide"><input type="checkbox" id="show-idle">idle replicasets</label><label class="wide" style="border:0;margin:0;padding:0"><input type="checkbox" id="show-unused">unused cm / secrets</label>`;
  box.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.kind) { t.checked ? hiddenKinds.delete(t.dataset.kind) : hiddenKinds.add(t.dataset.kind); }
    if (t.id === "all-kinds") {
      hiddenKinds.clear();
      if (!t.checked) KINDS.forEach((k) => hiddenKinds.add(k));
      box.querySelectorAll("[data-kind]").forEach((c) => { c.checked = t.checked; });
    }
    $("all-kinds").checked = hiddenKinds.size === 0;
    if (t.id === "show-idle") showIdle = t.checked;
    if (t.id === "show-unused") showUnused = t.checked;
    rebuild();
  });
  $("legend").innerHTML = Object.entries(STATUS_COLOR).map(([k, v]) => `<i style="color:${hex(v)};background:${hex(v)}"></i>${k.toUpperCase()}`).join("") + `<i style="color:#fff;background:#fff"></i>EVENT<span class="sep"></span>` +
    [["owns", 0x2a6a66], ["selects", 0x2f7fa0], ["routes", 0x6f5fa8], ["mounts", 0x7a6a45]].map(([k, v]) => `<i class="line" style="color:${hex(v)};background:${hex(v)}"></i>${k.toUpperCase()}`).join("");
}
buildKindToggles();
$("fit").onclick = () => fit();
$("namespace").onchange = (e) => { nsFilter = e.target.value; firstView = true; rebuild(); };
let searchHits = [], searchIdx = 0, lastQuery = "";
$("search").onkeydown = (e) => {
  if (e.key !== "Enter" || !lay) return;
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  if (q !== lastQuery) {
    lastQuery = q;
    searchHits = visible.filter((n) => n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).sort((a, b) => (a.kind === "Pod" ? 0 : 1) - (b.kind === "Pod" ? 0 : 1) || a.name.localeCompare(b.name));
    searchIdx = 0;
  } else searchIdx = (searchIdx + 1) % Math.max(1, searchHits.length);
  if (searchHits.length) select(searchHits[searchIdx].id, true);
};
addEventListener("keydown", (e) => {
  if (e.key === "Escape") { clearSelection(); $("hover").hidden = true; }
  if (e.key === "/" && document.activeElement !== $("search")) { e.preventDefault(); $("search").focus(); }
  if (e.key === "f" && document.activeElement.tagName !== "INPUT") fit();
});

const ray = new T.Raycaster(), mouse = new T.Vector2();
function pick(event) {
  mouse.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  let best = null;
  for (const p of picks) {
    const hits = ray.intersectObject(p.object, false);
    for (const h of hits) {
      const idx = h.instanceId ?? 0;
      const id = p.ids[idx];
      if (!id) continue;
      const d = h.distance - (kindOf(id.split("#")[0]) === "Namespace" ? -0.5 : 0);
      if (!best || d < best.d) best = { id, d };
    }
  }
  return best?.id || null;
}
let down = null;
canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
canvas.addEventListener("pointerup", (e) => {
  if (!down || down.b !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
  down = null;
  const id = pick(e);
  if (id) select(id); else clearSelection();
  if (id && id.includes("#")) highlightContainer(id.split("#")[1]);
});
let hoverPending = null;
canvas.addEventListener("pointermove", (e) => { hoverPending = e; });
function updateHover() {
  if (!hoverPending || !lay) return;
  const e = hoverPending; hoverPending = null;
  const id = pick(e);
  hovered = id && id.split("#")[0];
  const el = $("hover");
  if (!id) { el.hidden = true; canvas.style.cursor = ""; return; }
  const [objId, container] = id.split("#");
  const n = lay.byId.get(objId);
  canvas.style.cursor = "pointer";
  const c = container && (n.containers || []).find((x) => x.name === container);
  el.textContent = c
    ? `container ${c.name}${c.init ? " (init)" : ""}  ·  pod/${n.name}\n${c.state}${c.reason ? " (" + c.reason + ")" : ""}${c.restarts ? " · " + c.restarts + " restarts" : ""}\n${c.image}`
    : `${SHORT[n.kind] || n.kind}/${n.name}${n.namespace ? "  ·  " + n.namespace : ""}\n${n.summary || n.phase || ""}`;
  el.style.left = Math.min(innerWidth - 380, e.clientX + 14) + "px";
  el.style.top = Math.min(innerHeight - 80, e.clientY + 14) + "px";
  el.hidden = false;
}

function resizeLabels() {
  const dpr = Math.min(devicePixelRatio, 2);
  labelCanvas.width = innerWidth * dpr; labelCanvas.height = innerHeight * dpr;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeLabels();
const MAX_DIST = { Container: 45, Namespace: 1e9, Node: 900, Ingress: 320, Service: 260, Pod: 200, Deployment: 260, StatefulSet: 260, DaemonSet: 260, Job: 220, CronJob: 260, ReplicaSet: 120, ConfigMap: 110, Secret: 110, PersistentVolumeClaim: 140 };
const v3 = new T.Vector3();
function hexBadge(x, y, w, h, colour, text, size) {
  const c = h * 0.28;
  ctx2d.beginPath();
  ctx2d.moveTo(x + c, y); ctx2d.lineTo(x + w - c, y); ctx2d.lineTo(x + w, y + h / 2);
  ctx2d.lineTo(x + w - c, y + h); ctx2d.lineTo(x + c, y + h); ctx2d.lineTo(x, y + h / 2); ctx2d.closePath();
  ctx2d.fillStyle = "#06151c";
  ctx2d.fill();
  ctx2d.strokeStyle = colour;
  ctx2d.lineWidth = 1;
  ctx2d.stroke();
  ctx2d.fillStyle = colour;
  const f = ctx2d.font;
  ctx2d.font = `600 ${Math.max(7, size - 3)}px ui-monospace, Menlo, monospace`;
  ctx2d.textAlign = "center";
  ctx2d.fillText(text, x + w / 2, y + h - 2);
  ctx2d.textAlign = "left";
  ctx2d.font = f;
}
function drawLabels() {
  ctx2d.clearRect(0, 0, innerWidth, innerHeight);
  if (!lay) return;
  const items = [];
  for (const l of labels) {
    v3.set(l.x, l.y, l.z);
    const dist = v3.distanceTo(camera.position);
    const important = l.id === selected || l.id === hovered || labelFocus.has(l.id);
    if (!important && dist > (MAX_DIST[l.kind] || 200)) continue;
    v3.project(camera);
    if (v3.z > 1 || v3.x < -1.1 || v3.x > 1.1 || v3.y < -1.1 || v3.y > 1.1) continue;
    items.push({ l, sx: (v3.x + 1) / 2 * innerWidth, sy: (1 - v3.y) / 2 * innerHeight, dist, important });
  }
  items.sort((a, b) => (a.important ? 0 : 1) - (b.important ? 0 : 1) || a.l.prio - b.l.prio || a.dist - b.dist);
  const occupied = new Set();
  let drawn = 0;
  ctx2d.textBaseline = "bottom";
  for (const it of items) {
    if (drawn > 700) break;
    const l = it.l;
    const ns = l.kind === "Namespace", node = l.kind === "Node", ctr = l.kind === "Container";
    if (ctr && !it.important && it.dist > 45) continue;
    const size = ctr ? (it.important ? 10 : 9) : it.important ? 13 : ns ? Math.max(9, Math.min(12, 14 - it.dist / 60)) : node ? 11 : Math.max(8, Math.min(12, 13 - it.dist / 45));
    let text = l.text;
    if (!it.important && !ns && text.length > 26) text = text.slice(0, 25) + "…";
    ctx2d.font = `${ns || node ? "600 " : ""}${size}px ui-monospace, Menlo, monospace`;
    const badge = ns || ctr ? "" : SHORT[l.kind] || l.kind;
    const bw = badge ? Math.max(size * 1.5, badge.length * size * 0.62 + 8) : 0;
    const pw = badge ? bw + 5 : 0;
    const w = ctx2d.measureText(text).width + pw;
    const x = ns ? it.sx : ctr ? it.sx + 14 : it.sx - w / 2, y = ns ? it.sy + size + 2 : ctr ? it.sy + size / 2 : it.sy;
    if (!it.important) {
      const cells = [];
      for (let cx = Math.floor(x / 40); cx <= Math.floor((x + w) / 40); cx++) cells.push(`${cx}:${Math.floor(y / 14)}`);
      if (cells.some((c) => occupied.has(c))) continue;
      cells.forEach((c) => occupied.add(c));
    }
    const alpha = it.important ? 1 : ns ? Math.max(0.4, 1 - it.dist / 400) : Math.max(0.35, 1 - it.dist / (MAX_DIST[l.kind] || 200));
    ctx2d.globalAlpha = alpha;
    ctx2d.fillStyle = "#03090e";
    ctx2d.fillRect(x - 3, y - size - 1, w + 6, size + 3);
    ctx2d.globalAlpha = Math.min(1, alpha + 0.1);
    ctx2d.fillStyle = ctr ? hex(l.color) : it.important ? "#eafff8" : ns ? "#72d6c3" : node ? hex(nodeHues.get(l.text) || 0x9fc9c2) : l.kind === "Pod" ? "#cbe4e4" : hex(KIND_COLOR[l.kind] || 0xcbe4e4);
    if (ns) { ctx2d.letterSpacing = "2px"; ctx2d.fillText("NS " + text.toUpperCase(), x, y); ctx2d.letterSpacing = "0px"; }
    else if (badge) {
      const colour = hex(node ? nodeHues.get(l.text) || 0x9fc9c2 : KIND_COLOR[l.kind] || 0x9fc9c2);
      hexBadge(x, y - size + 0.5, bw, size + 1, colour, badge, size);
      ctx2d.fillStyle = it.important ? "#eafff8" : l.kind === "Pod" ? "#cbe4e4" : "#bfd9d6";
      ctx2d.fillText(text, x + pw, y);
    } else ctx2d.fillText(text, x, y);
    drawn++;
  }
  ctx2d.globalAlpha = 1;
}

// ponytail: last 30 events kept in memory only; add an API-backed page if history matters
const recent = [];
function eventText(ev) {
  return `${new Date(ev.time).toLocaleTimeString()}  ${ev.type.toUpperCase()}  ${ev.reason}  ${ev.target.replace(/^(\w+)\/([^/]*)\//, (m, k, ns) => (SHORT[k] || k) + "/" + (ns ? ns + "/" : ""))}  —  ${ev.message}`;
}
function onEvent(ev) {
  const now = performance.now();
  const warn = ev.type === "Warning";
  glows.set(ev.target, { t0: now, warn });
  const t = $("ticker");
  t.className = ev.type;
  t.textContent = eventText(ev);
  t.href = detailURL(ev.target);
  recent.unshift(ev);
  recent.length = Math.min(recent.length, 30);
  $("recent").innerHTML = recent.map((e) => `<a class="${esc(e.type)}" href="${esc(detailURL(e.target))}" target="_blank">${esc(eventText(e))}</a>`).join("");
  if (lay && lay.pos.has(ev.target) && !reduced) {
    const top = topOf(ev.target);
    spark(top, warn ? 0xff8a5a : 0xffffff, warn ? 10 : 4, now);
  }
}
function onMetrics(sample) {
  usage.clear();
  for (const m of sample.pods) {
    const req = m.cpuReqMilli > 0 ? m.cpuReqMilli : 1000;
    usage.set(m.target, Math.min(1, m.cpuMilli / req));
  }
}
connect({
  snapshot: (s) => { snapshot = s; $("context").textContent = s.context || "(current)"; rebuild(); },
  event: onEvent,
  metrics: onMetrics,
  status: (st) => { $("dot").classList.toggle("off", st !== "live"); $("dot").title = st; },
});
fetch("/api/snapshot").then((r) => { if (!r.ok) throw new Error(r.statusText); }).catch((e) => { $("failure").hidden = false; $("failure").textContent = "Cannot reach kubectl skyline backend: " + e.message; });

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  resizeLabels();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
let frames = 0, frameTime = performance.now();
const tmpColor = new T.Color();
function glowLevel(id, now) {
  let level = 0, warn = false;
  const g = glows.get(id);
  if (g) {
    const t = (now - g.t0) / 1800;
    if (t < 1) { level = 1 - t; warn = g.warn; } else glows.delete(id);
  }
  const u = usage.get(id);
  if (u !== undefined) level = Math.max(level, 0.15 + Math.sqrt(u) * 0.75);
  return { level, warn };
}
function frame(now) {
  if (fly) {
    const t = Math.min(1, (now - fly.t0) / fly.dur), k = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    camera.position.lerpVectors(fly.fromP, fly.toP, k);
    controls.target.lerpVectors(fly.fromT, fly.toT, k);
    if (t >= 1) fly = null;
  }
  controls.update();
  updateHover();
  if (relationFlows.length && now - lastFlow > 220 && !reduced) {
    lastFlow = now;
    for (const f of relationFlows.slice(0, 80)) particles.push({ start: now, duration: 1600, curve: f.curve, color: f.color });
    if (particles.length > PARTICLE_CAP) particles = particles.slice(-PARTICLE_CAP);
  }
  particles = particles.filter((p) => now - p.start < p.duration);
  let i = 0;
  for (const p of particles) {
    if (now < p.start) continue;
    const t = (now - p.start) / p.duration;
    const point = p.curve.getPoint(t);
    pPos.set([point.x, point.y, point.z], i * 3);
    tmpColor.set(p.color).multiplyScalar(1 - t * 0.85);
    pCol.set([tmpColor.r, tmpColor.g, tmpColor.b], i * 3);
    i++;
  }
  pg.setDrawRange(0, i);
  pg.attributes.position.needsUpdate = true;
  pg.attributes.color.needsUpdate = true;
  if (glowPlate && haloPlate) {
    for (let j = 0; j < towerIds.length; j++) {
      const { level, warn } = glowLevel(towerIds[j], now);
      if (warn) {
        glowPlate.setColorAt(j, tmpColor.setRGB(1.2 * level, 0.45 * level, 0.3 * level));
        haloPlate.setColorAt(j, tmpColor.setRGB(0.9 * level, 0.25 * level, 0.15 * level));
      } else {
        glowPlate.setColorAt(j, tmpColor.setRGB(0.45 * level, 1.15 * level, 1.05 * level));
        haloPlate.setColorAt(j, tmpColor.setRGB(0.18 * level, 0.85 * level, 0.72 * level));
      }
    }
    glowPlate.instanceColor.needsUpdate = true;
    haloPlate.instanceColor.needsUpdate = true;
  }
  renderer.render(scene, camera);
  drawLabels();
  frames++;
  if (now - frameTime > 1000) {
    $("fps").textContent = `${Math.round((frames * 1000) / (now - frameTime))} FPS`;
    frames = 0; frameTime = now;
  }
}
function animate(now) {
  requestAnimationFrame(animate);
  if (!document.hidden) frame(now);
}
requestAnimationFrame(animate);
setInterval(() => { if (document.hidden) frame(performance.now()); }, 250);

window.skyline = {
  get snapshot() { return snapshot; },
  get layout() { return lay; },
  get selected() { return selected; },
  select: (id) => select(id, true),
  clear: clearSelection,
  fit,
  camera, controls,
};
