// Settings popup. Settings live in chrome.storage.local; pages pick changes up instantly.
const DEFAULTS = {
  delayMode: "auto", delayManual: 5, trimMs: 0, vocalGain: 1, model: "auto",
  maxWidth: 1280, floatingButton: true, sites: "all", serverPort: 8765,
};
const $ = (id) => document.getElementById(id);
let cfg = { ...DEFAULTS };
let serverInfo = null;

const save = (key, value) => { cfg[key] = value; chrome.storage.local.set({ [key]: value }); };
const sign = (n) => (n > 0 ? "+" : "") + n + " ms";

function paint() {
  $("model").value = cfg.model;
  $("maxWidth").value = String(cfg.maxWidth);
  $("sites").value = cfg.sites;
  $("fab").checked = !!cfg.floatingButton;
  $("port").value = cfg.serverPort;

  const manual = cfg.delayMode === "manual";
  $("delayAuto").setAttribute("aria-pressed", String(!manual));
  $("delayManual").setAttribute("aria-pressed", String(manual));
  $("delayRow").classList.toggle("hidden", !manual);
  $("delayManualRange").value = cfg.delayManual;
  $("delayVal").textContent = Number(cfg.delayManual).toFixed(1) + " s";

  $("trim").value = cfg.trimMs;
  $("trimVal").textContent = sign(Number(cfg.trimMs));
  $("gain").value = Math.round(cfg.vocalGain * 100);
  $("gainVal").textContent = Math.round(cfg.vocalGain * 100) + "%";

  const m = serverInfo && serverInfo.models && serverInfo.models[serverInfo.default];
  $("delayNote").textContent = m
    ? `This PC needs about ${m.delay} s${manual && cfg.delayManual + 0.3 < m.delay ? " (too short: vocals may cut out)" : ""}`
    : "How far behind live the picture and vocals run";
}

// ---- server status ----
function checkServer() {
  const pill = $("status"), text = $("statusText");
  pill.className = "pill"; text.textContent = "Checking server...";
  let done = false;
  const finish = (cls, msg, info) => {
    if (done) return; done = true;
    pill.className = "pill " + cls; text.textContent = msg; serverInfo = info || null; paint();
  };
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${Number(cfg.serverPort) || 8765}`); } catch { return finish("bad", "Server not running"); }
  const timer = setTimeout(() => { finish("bad", "Server not running"); try { ws.close(); } catch {} }, 2500);
  ws.onopen = () => ws.send(JSON.stringify({ status: 1 }));
  ws.onerror = () => { clearTimeout(timer); finish("bad", "Server not running"); };
  ws.onmessage = (e) => {
    clearTimeout(timer);
    try {
      const i = JSON.parse(e.data);
      const m = i.models && i.models[i.default];
      const where = i.device === "cuda" ? "graphics card" : "processor";
      finish(m && !m.live ? "warn" : "ok", `Ready · ${where}${m ? " · " + m.x_realtime + "x" : ""}${m && !m.live ? " (slow)" : ""}`, i);
    } catch { finish("bad", "Server not running"); }
    ws.close();
  };
}

// ---- this tab ----
async function activeTab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }
async function refreshTab() {
  const btn = $("toggle");
  const tab = await activeTab();
  if (!tab || !/^https?:/.test(tab.url || "")) { btn.disabled = true; btn.textContent = "Open a web page first"; return; }
  let on = false;
  try { const r = await chrome.tabs.sendMessage(tab.id, { cmd: "state" }, { frameId: 0 }); on = !!(r && r.on); btn.disabled = false; }
  catch { btn.disabled = true; btn.textContent = "Reload this page, then try again"; return; }
  btn.classList.toggle("on", on);
  btn.textContent = on ? "Turn off for this tab" : "Turn on for this tab";
}
$("toggle").onclick = async () => {
  const tab = await activeTab();
  if (!tab) return;
  try { await chrome.tabs.sendMessage(tab.id, { cmd: "toggle" }); } catch {}
  setTimeout(refreshTab, 700);
  setTimeout(refreshTab, 2500);
};

// ---- controls ----
$("model").onchange = (e) => save("model", e.target.value);
$("maxWidth").onchange = (e) => save("maxWidth", Number(e.target.value));
$("sites").onchange = (e) => save("sites", e.target.value);
$("fab").onchange = (e) => save("floatingButton", e.target.checked);
$("port").onchange = (e) => { save("serverPort", Math.min(65535, Math.max(1024, Number(e.target.value) || 8765))); paint(); checkServer(); };
$("delayAuto").onclick = () => { save("delayMode", "auto"); paint(); };
$("delayManual").onclick = () => { save("delayMode", "manual"); paint(); };
$("delayManualRange").oninput = (e) => { save("delayManual", Number(e.target.value)); paint(); };
$("trim").oninput = (e) => { save("trimMs", Number(e.target.value)); paint(); };
$("trimMinus").onclick = () => { save("trimMs", Math.max(-500, cfg.trimMs - 10)); paint(); };
$("trimPlus").onclick = () => { save("trimMs", Math.min(500, cfg.trimMs + 10)); paint(); };
$("trimReset").onclick = () => { save("trimMs", 0); paint(); };
$("gain").oninput = (e) => { save("vocalGain", Number(e.target.value) / 100); paint(); };
$("status").onclick = checkServer;

chrome.storage.onChanged.addListener((changes) => {   // e.g. Alt + , / Alt + . pressed on a page
  for (const k in changes) cfg[k] = changes[k].newValue;
  paint();
});

(async () => {
  cfg = await chrome.storage.local.get(DEFAULTS);
  paint();
  checkServer();
  refreshTab();
})();
