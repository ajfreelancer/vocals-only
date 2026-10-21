// Isolated-world bridge: page script (content.js, MAIN world) <-> extension (sw.js, settings, popup).
// The page script cannot use chrome.*, so it talks to this over window.postMessage.
(() => {
  const TAG = "__vocalsOnly";
  let port = null;

  const DEFAULTS = {
    delayMode: "auto",     // "auto" = what the server says it needs, "manual" = delayManual
    delayManual: 5,        // seconds
    trimMs: 0,             // fine sync: vocals later (+) or earlier (-)
    vocalGain: 1,          // vocal volume multiplier
    model: "auto",         // "auto" | "best" | "light"
    maxWidth: 1280,        // widest picture kept in the buffer
    floatingButton: true,  // show the round button on non-YouTube pages
    sites: "all",          // "all" | "youtube"
    serverPort: 8765,
  };

  const toPage = (m, transfer) => window.postMessage({ [TAG]: "fromBridge", ...m }, "*", transfer || []);

  function toB64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8.buffer;
  }

  function connect(sr, model) {
    disconnect();
    port = chrome.runtime.connect({ name: "vocals" });
    const mine = port;
    port.onMessage.addListener((m) => {
      if (port !== mine) return;
      if (m.t === "audio") { const buf = fromB64(m.b64); toPage({ t: "audio", buf }, [buf]); }
      else if (m.t === "text") toPage({ t: "text", data: m.data });
      else toPage({ t: m.t });
    });
    port.onDisconnect.addListener(() => { if (port === mine) { port = null; toPage({ t: "close" }); } });
    port.postMessage({ t: "open", sr, model });
  }

  function disconnect() {
    if (!port) return;
    try { port.postMessage({ t: "close" }); port.disconnect(); } catch {}
    port = null;
  }

  async function sendSettings() {
    try { toPage({ t: "settings", s: await chrome.storage.local.get(DEFAULTS) }); } catch {}
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== "toBridge") return;
    const m = e.data;
    if (m.t === "open") connect(m.sr, m.model);
    else if (m.t === "audio" && port) port.postMessage({ t: "audio", b64: toB64(new Uint8Array(m.buf)) });
    else if (m.t === "close") disconnect();
    else if (m.t === "getSettings") sendSettings();
    else if (m.t === "set" && m.key in DEFAULTS) chrome.storage.local.set({ [m.key]: m.value });
    else if (m.t === "state") window.__voState = !!m.on;
  });

  // Settings changed in the popup: tell the page. Popup commands: toggle / report state.
  chrome.storage.onChanged.addListener(sendSettings);
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.cmd === "toggle") { toPage({ t: "cmd", cmd: "toggle" }); reply({ ok: true }); }
    else if (msg && msg.cmd === "state") { reply({ on: !!window.__voState, frame: window === window.top }); }
  });
})();
