/**
 * GET /api/digifabster-part-data-admin
 *
 * A self-contained management page for /api/digifabster-part-data: toggle which
 * fields the endpoint returns (persisted via /api/digifabster-part-data-config),
 * and test the endpoint live. Vanilla HTML/JS — no SPA build dependency.
 */
export const config = {
  maxDuration: 30,
};

const FIELD_LABELS: Record<string, string> = {
  image: "image — best thumbnail URL",
  thumbnails: "thumbnails — all thumbnail sizes + status",
  dimX: "dimX — bounding box X",
  dimY: "dimY — bounding box Y",
  dimZ: "dimZ — bounding box Z",
  dimUnits: "dimUnits — mm / cm / in",
  materialId: "materialId — resolved material id",
  materialSource: "materialSource — request | preselection",
  materialGroup: "materialGroup — material family (manual map below), e.g. Steel",
  materialName: "materialName — grade, e.g. St37 / S235JR / 1.0570",
  requestedPrice: "requestedPrice — price × multiplier",
  priceStatus: "priceStatus — priced | analysing",
  shouldRetry: "shouldRetry — price not ready yet",
  ready: "ready — image + dims + price all present",
  volume: "volume — model volume (in dimUnits³)",
  surface: "surface — total surface area",
  sheetTopSurfaceArea: "sheetTopSurfaceArea — sheet top-face area",
  perimeter: "perimeter — cut perimeter (sheet)",
  punchesCount: "punchesCount — number of punches (sheet)",
  shells: "shells — number of shells / bodies",
  sizeZForSheet: "sizeZForSheet — thickness used for sheet",
  cncComplexity: "cncComplexity — machining complexity score",
  cncComplexityLevel: "cncComplexityLevel — complexity bucket",
  cncFeatures: "cncFeatures — detected CNC features (array)",
  dfmFeatures: "dfmFeatures — DFM analysis (object)",
  fileViewerUrl: "fileViewerUrl — viewer model URL",
  fileOriginalUrl: "fileOriginalUrl — original upload URL",
  fileStlOriginalUrl: "fileStlOriginalUrl — original STL URL",
  fileStlRepairedUrl: "fileStlRepairedUrl — repaired STL URL",
  geometryType: "geometryType — geometry classification",
  technologies: "technologies — applicable technology ids (array)",
  filesize: "filesize — uploaded file size",
  title: "title — model title / filename",
  dateCreated: "dateCreated — model creation timestamp",
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Part Data — Field Manager</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, system-ui, sans-serif; margin: 0;
    background: #0f1115; color: #e7e9ee; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color: #9aa3b2; margin: 0 0 24px; font-size: 14px; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 12px; padding: 18px 20px; margin-bottom: 20px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #9aa3b2; margin: 0 0 14px; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid #20242e; }
  .row:last-child { border-bottom: 0; }
  .row code { color: #e7e9ee; font-size: 14px; }
  .row .desc { color: #8b94a4; font-size: 12px; }
  .name { display: flex; flex-direction: column; gap: 2px; }
  /* toggle */
  .sw { position: relative; width: 42px; height: 24px; flex: none; }
  .sw input { opacity: 0; width: 0; height: 0; }
  .sl { position: absolute; inset: 0; background: #3a4150; border-radius: 999px; transition: .15s; cursor: pointer; }
  .sl::before { content: ""; position: absolute; height: 18px; width: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .15s; }
  .sw input:checked + .sl { background: #3b82f6; }
  .sw input:checked + .sl::before { transform: translateX(18px); }
  .actions { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
  button { background: #3b82f6; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; font-size: 14px; cursor: pointer; }
  button.secondary { background: #2a3140; }
  button:disabled { opacity: .5; cursor: default; }
  .status { font-size: 13px; color: #9aa3b2; }
  .status.ok { color: #34d399; } .status.err { color: #f87171; }
  input[type=text] { background: #0f1115; border: 1px solid #2a3140; color: #e7e9ee; border-radius: 8px; padding: 9px 12px; font-size: 14px; }
  pre { background: #0f1115; border: 1px solid #2a3140; border-radius: 8px; padding: 14px; overflow: auto; font-size: 12.5px; max-height: 360px; }
  .muted { color: #6b7382; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Part Data — Field Manager</h1>
  <p class="sub">Toggle which fields <code>/api/digifabster-part-data</code> returns. Disabled fields are
  omitted and their upstream DigiFabster call is skipped. <code>modelId</code> is always included.</p>

  <div class="card">
    <h2>Response fields</h2>
    <div id="fields"><span class="muted">Loading…</span></div>
    <div class="actions" style="margin-top:14px;">
      <button id="save" disabled>Save</button>
      <button id="reload" class="secondary">Reload</button>
      <span id="saveStatus" class="status"></span>
    </div>
  </div>

  <div class="card">
    <h2>Material group mapping</h2>
    <p class="sub" style="margin:0 0 12px;">Maps <code>materialId</code> → group family for the
    <code>materialGroup</code> field (e.g. <code>{ "72460": "Aluminium" }</code>). DigiFabster's
    catalog doesn't carry the family, so it's maintained here. Edit the JSON below.</p>
    <textarea id="groups" rows="8" style="width:100%; background:#0f1115; border:1px solid #2a3140;
      color:#e7e9ee; border-radius:8px; padding:12px; font-size:13px; font-family:ui-monospace, monospace;"
      spellcheck="false"></textarea>
    <div class="actions" style="margin-top:12px;">
      <button id="saveGroups" disabled>Save mapping</button>
      <button id="reloadGroups" class="secondary">Reload</button>
      <span id="groupsStatus" class="status"></span>
    </div>
  </div>

  <div class="card">
    <h2>Test the endpoint</h2>
    <div class="actions">
      <input id="modelId" type="text" placeholder="objectModelId, e.g. 4392012" style="flex:1;" />
      <button id="test" class="secondary">GET</button>
    </div>
    <pre id="out" style="margin-top:14px;"><span class="muted">Response appears here…</span></pre>
  </div>
</div>

<script>
const CONFIG_URL = "/api/digifabster-part-data-config";
const GROUPS_URL = "/api/digifabster-material-group-config";
const DATA_URL = "/api/digifabster-part-data";
const LABELS = __LABELS__;
let available = [];

const el = (id) => document.getElementById(id);
const setStatus = (msg, cls) => { const s = el("saveStatus"); s.textContent = msg; s.className = "status " + (cls || ""); };
const setGroupsStatus = (msg, cls) => { const s = el("groupsStatus"); s.textContent = msg; s.className = "status " + (cls || ""); };

async function load() {
  setStatus("");
  el("fields").innerHTML = '<span class="muted">Loading…</span>';
  try {
    const r = await fetch(CONFIG_URL);
    const cfg = await r.json();
    available = cfg.available || Object.keys(cfg.fields || {});
    render(cfg.fields || {});
    el("save").disabled = false;
  } catch (e) {
    el("fields").innerHTML = '<span class="status err">Failed to load config.</span>';
  }
}

function render(fields) {
  const html = available.map((f) => {
    const label = LABELS[f] || f;
    const parts = label.split(" — ");
    const name = parts[0], desc = parts[1] || "";
    const checked = fields[f] === true ? "checked" : "";
    return '<div class="row"><div class="name"><code>' + name + '</code>' +
      (desc ? '<span class="desc">' + desc + '</span>' : '') + '</div>' +
      '<label class="sw"><input type="checkbox" data-field="' + f + '" ' + checked + '/><span class="sl"></span></label></div>';
  }).join("");
  el("fields").innerHTML = html;
}

function collect() {
  const fields = {};
  document.querySelectorAll('input[data-field]').forEach((i) => { fields[i.dataset.field] = i.checked; });
  return fields;
}

async function save() {
  el("save").disabled = true;
  setStatus("Saving…");
  try {
    const r = await fetch(CONFIG_URL, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: collect() }) });
    const data = await r.json();
    if (r.ok && data.status === "saved") setStatus("Saved.", "ok");
    else setStatus(data.warning || data.error || "Not saved.", "err");
  } catch (e) {
    setStatus("Save failed.", "err");
  } finally {
    el("save").disabled = false;
  }
}

async function loadGroups() {
  setGroupsStatus("");
  el("saveGroups").disabled = true;
  el("groups").value = "Loading…";
  try {
    const r = await fetch(GROUPS_URL);
    const cfg = await r.json();
    el("groups").value = JSON.stringify(cfg.groups || {}, null, 2);
    el("saveGroups").disabled = false;
  } catch (e) {
    el("groups").value = "";
    setGroupsStatus("Failed to load mapping.", "err");
  }
}

async function saveGroups() {
  let parsed;
  try {
    parsed = JSON.parse(el("groups").value || "{}");
  } catch (e) {
    setGroupsStatus("Invalid JSON.", "err");
    return;
  }
  el("saveGroups").disabled = true;
  setGroupsStatus("Saving…");
  try {
    const r = await fetch(GROUPS_URL, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groups: parsed }) });
    const data = await r.json();
    if (r.ok && data.status === "saved") {
      el("groups").value = JSON.stringify(data.groups || {}, null, 2); // reflect sanitized result
      setGroupsStatus("Saved.", "ok");
    } else {
      setGroupsStatus(data.warning || data.error || "Not saved.", "err");
    }
  } catch (e) {
    setGroupsStatus("Save failed.", "err");
  } finally {
    el("saveGroups").disabled = false;
  }
}

async function test() {
  const id = el("modelId").value.trim();
  if (!id) { el("out").textContent = "Enter an objectModelId."; return; }
  el("out").textContent = "Loading…";
  try {
    const r = await fetch(DATA_URL + "?objectModelId=" + encodeURIComponent(id));
    const data = await r.json();
    el("out").textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    el("out").textContent = "Request failed: " + (e && e.message ? e.message : e);
  }
}

el("save").addEventListener("click", save);
el("reload").addEventListener("click", load);
el("saveGroups").addEventListener("click", saveGroups);
el("reloadGroups").addEventListener("click", loadGroups);
el("test").addEventListener("click", test);
load();
loadGroups();
</script>
</body>
</html>`;

const html = (req?: Request) => {
  const origin = req?.headers.get("origin")?.trim();
  return new Response(PAGE.replace("__LABELS__", JSON.stringify(FIELD_LABELS)), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin || "*",
    },
  });
};

export async function GET(req: Request) {
  return html(req);
}
