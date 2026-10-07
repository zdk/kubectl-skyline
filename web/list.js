import { KINDS, SHORT, esc, age, connect, detailURL, focusURL } from "./common.js";

const $ = (id) => document.getElementById(id);
let snapshot = null, sortKey = "kind", sortDir = 1;
const ORDER = { error: 0, warn: 1, unknown: 2, ok: 3, done: 4, idle: 5 };

$("kind").innerHTML += KINDS.map((k) => `<option value="${k}">${k}</option>`).join("");
for (const el of ["filter", "kind", "namespace", "problems"]) $(el).addEventListener("input", render);
document.querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = 1; }
  render();
});

function render() {
  if (!snapshot) return;
  const q = $("filter").value.trim().toLowerCase(), kind = $("kind").value, ns = $("namespace").value, problems = $("problems").checked;
  let rows = snapshot.nodes.filter((n) =>
    (!kind || n.kind === kind) && (!ns || n.namespace === ns || (n.kind === "Namespace" && n.name === ns)) &&
    (!problems || n.status === "error" || n.status === "warn") &&
    (!q || `${n.kind} ${n.namespace} ${n.name} ${n.status} ${n.phase} ${n.summary}`.toLowerCase().includes(q)));
  rows.sort((a, b) => {
    let r;
    if (sortKey === "status") r = ORDER[a.status] - ORDER[b.status];
    else if (sortKey === "created") r = new Date(a.created) - new Date(b.created);
    else r = String(a[sortKey]).localeCompare(String(b[sortKey]));
    return (r || a.id.localeCompare(b.id)) * sortDir;
  });
  $("count").textContent = `${rows.length} / ${snapshot.nodes.length}`;
  $("rows").innerHTML = rows.map((n) => `<tr>
    <td class="kind">${esc(SHORT[n.kind] || n.kind)}</td><td class="ns">${esc(n.namespace)}</td>
    <td><a href="${detailURL(n.id)}">${esc(n.name)}</a></td>
    <td><span class="pill st-${n.status}">${esc(n.phase || n.status)}</span></td>
    <td>${esc(n.summary)}</td><td>${age(n.created)}</td>
    <td><a href="${focusURL(n.id)}" title="Show in space">◎</a></td></tr>`).join("");
}

connect({
  snapshot: (s) => {
    snapshot = s;
    $("context").textContent = s.context || "(current)";
    const names = [...new Set(s.nodes.filter((n) => n.namespace).map((n) => n.namespace))].sort();
    const sel = $("namespace"), cur = sel.value;
    sel.innerHTML = `<option value="">All namespaces</option>` + names.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
    sel.value = names.includes(cur) ? cur : "";
    render();
  },
  status: (st) => $("dot").classList.toggle("off", st !== "live"),
});
