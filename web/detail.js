import { SHORT, esc, age, connect, focusURL, parseId, containerColor, hex, yamlHTML, diffLines, statusDots, execCommandFor } from "./common.js";

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("id") || "";
const { kind, namespace, name } = parseId(id);
document.title = `kubectl skyline · ${SHORT[kind] || kind}/${name}`;
$("focus").href = focusURL(id);
$("kind").textContent = (kind || "OBJECT").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
$("name").firstChild.textContent = name || "?";

let logContainer = null, logTimer = null;

function renderNode(n) {
  const ph = $("phase"); ph.textContent = n.phase || n.status; ph.className = "st-" + n.status;
  $("meta").innerHTML = `${namespace ? `namespace <b>${esc(namespace)}</b> · ` : ""}age ${age(n.created)}${n.clusterNode ? ` · node <b>${esc(n.clusterNode)}</b>` : ""} · uid ${esc(n.uid)}`;
  $("summary").innerHTML = `${statusDots(n)} ${esc(n.summary || n.phase || n.status)}`;
  $("facts").innerHTML = (n.facts || []).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") +
    Object.entries(n.labels || {}).map(([k, v]) => `<dt class="st-idle">label</dt><dd><code>${esc(k)}=${esc(v)}</code></dd>`).join("");
  const cs = n.containers || [];
  $("containers-card").hidden = !cs.length;
  $("containers").innerHTML = cs.map((c) => `<div class="ctr"><i style="color:${hex(containerColor(c))};background:${hex(containerColor(c))}"></i><b>${esc(c.name)}</b>${c.init ? " <span class=st-done>init</span>" : ""} · ${esc(c.state)}${c.reason ? " (" + esc(c.reason) + ")" : ""} · ${c.restarts} restarts${c.cpuReq || c.memReq ? ` · requests ${esc(c.cpuReq || "-")} / ${esc(c.memReq || "-")}` : ""}<code>${esc(c.image)}</code>${kind === "Pod" && c.state === "running" ? `<span class="exec"><code>${esc(execCommand(c))}</code><button data-copy="${esc(execCommand(c))}">Copy</button></span>` : ""}</div>`).join("");
  if (kind === "Pod" && cs.length) {
    $("logs-card").hidden = false;
    if (!logContainer) logContainer = (cs.find((c) => !c.init) || cs[0]).name;
    $("log-tabs").innerHTML = cs.map((c) => `<button data-c="${esc(c.name)}" class="${c.name === logContainer ? "on" : ""}">${esc(c.name)}</button>`).join("") + `<button id="prev">previous</button><button id="reload">reload</button>`;
    if (!logTimer) loadLogs();
  }
}
$("log-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.c) { logContainer = b.dataset.c; for (const x of $("log-tabs").querySelectorAll("button[data-c]")) x.classList.toggle("on", x.dataset.c === logContainer); loadLogs(); }
  else if (b.id === "prev") loadLogs(true);
  else loadLogs();
});
async function loadLogs(previous = false) {
  clearTimeout(logTimer);
  $("log-meta").textContent = previous ? "· previous instance · last 200 lines" : "· last 200 lines · refreshes every 5s";
  try {
    const r = await fetch(`/api/logs?id=${encodeURIComponent(id)}&container=${encodeURIComponent(logContainer)}&tail=200${previous ? "&previous=1" : ""}`);
    const text = await r.text();
    const pre = $("logs");
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent = r.ok ? text || "(no output)" : "error: " + text;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    $("logs").textContent = "error: " + e.message;
  }
  if (!previous) logTimer = setTimeout(loadLogs, 5000);
}
async function loadYAML() {
  const url = `/api/resource?id=${encodeURIComponent(id)}`;
  const [r, p] = await Promise.all([fetch(url), fetch(url + "&prev=1")]);
  const text = await r.text();
  $("yaml").innerHTML = r.ok ? yamlHTML(text) : "error: " + esc(text);
  $("diff-card").hidden = !(r.ok && p.ok);
  if (r.ok && p.ok) renderDiff(await p.text(), text, $("diff"), "only resourceVersion or heartbeat changed");
}
async function copy(button, text) {
  await navigator.clipboard.writeText(text);
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = "Copy"; }, 1500);
}
$("copy-yaml").onclick = (e) => copy(e.target, $("yaml").textContent);
$("containers").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-copy]");
  if (b) copy(b, b.dataset.copy);
});
// Skyline stays read-only: it shows the command, the user runs it in their own terminal.
let kubeContext = "";
const execCommand = (c) => execCommandFor(kubeContext, namespace, name, c.name);
let revs = [];
async function loadRevisions() {
  if (kind !== "Deployment") return;
  const r = await fetch(`/api/revisions?id=${encodeURIComponent(id)}`);
  const next = r.ok ? await r.json() : [];
  // Same list as before: keep the revisions the user picked.
  if (next.map((v) => v.number).join() === revs.map((v) => v.number).join()) return;
  revs = next;
  $("rev-card").hidden = revs.length < 2;
  if (revs.length < 2) return;
  $("rev-from").innerHTML = $("rev-to").innerHTML = revs.map((v) => `<option value="${v.number}">#${v.number} · ${esc(new Date(v.created).toLocaleString())}</option>`).join("");
  $("rev-from").value = revs[1].number;
  $("rev-to").value = revs[0].number;
  showRevisionDiff();
}
function showRevisionDiff() {
  const template = (el) => revs.find((v) => String(v.number) === $(el).value).template;
  renderDiff(template("rev-from"), template("rev-to"), $("rev-diff"), "pod templates are identical");
}
$("rev-from").onchange = $("rev-to").onchange = showRevisionDiff;
function renderDiff(before, after, el, empty) {
  // resourceVersion and node heartbeats change constantly, so they are noise here.
  const lines = (t) => t.split("\n").filter((l) => !/^\s*(- )?(resourceVersion|lastHeartbeatTime):/.test(l));
  const d = diffLines(lines(before), lines(after));
  // Keep two lines of context around each change.
  const keep = d.map((_, i) => d.slice(Math.max(0, i - 2), i + 3).some(([op]) => op !== " "));
  let html = "", gap = false;
  d.forEach(([op, line], i) => {
    if (!keep[i]) { gap = true; return; }
    if (gap && html) html += `<span class="gap">⋯</span>\n`;
    gap = false;
    html += `<span class="${op === "+" ? "add" : op === "-" ? "del" : ""}">${op} ${esc(line)}</span>\n`;
  });
  el.innerHTML = html || empty;
}
async function loadEvents() {
  const r = await fetch(`/api/object-events?id=${encodeURIComponent(id)}`);
  const evs = r.ok ? await r.json() : [];
  $("events").innerHTML = evs.length ? evs.map((e) => `<li class="${e.type}"><time>${new Date(e.time).toLocaleString()}</time>${esc(e.reason)}${e.count > 1 ? ` ×${e.count}` : ""} — ${esc(e.message)}</li>`).join("") : `<li class="st-idle">no recent events</li>`;
}
loadYAML();
loadEvents();
loadRevisions();
connect({
  snapshot: (s) => {
    $("context").textContent = s.context || "(current)";
    kubeContext = s.context || "";
    const n = s.nodes.find((x) => x.id === id);
    if (n) renderNode(n); else { $("phase").textContent = "gone"; $("phase").className = "st-error"; }
    loadYAML(); loadEvents(); loadRevisions();
  },
  status: (st) => $("dot").classList.toggle("off", st !== "live"),
});
