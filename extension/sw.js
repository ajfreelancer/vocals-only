// Background relay. Content scripts talk to this over a port and this talks to the local
// server. The WebSocket lives here, not in the web page, so site security rules (CSP) and
// Chrome's local-network prompt don't apply and no website can reach the server directly.

async function serverUrl() {
  const { serverPort } = await chrome.storage.local.get({ serverPort: 8765 });
  return `ws://127.0.0.1:${Number(serverPort) || 8765}`;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "vocals") return;
  let ws = null;
  const send = (m) => { try { port.postMessage(m); } catch {} };

  port.onMessage.addListener(async (m) => {
    if (m.t === "open") {
      try { ws && ws.close(); } catch {}
      const sock = new WebSocket(await serverUrl());
      ws = sock;
      sock.binaryType = "arraybuffer";
      sock.onopen = () => { sock.send(JSON.stringify({ sr: m.sr, model: m.model || "auto" })); send({ t: "open" }); };
      sock.onerror = () => send({ t: "error" });
      sock.onclose = () => { if (ws === sock) send({ t: "close" }); };
      sock.onmessage = (e) => send(typeof e.data === "string" ? { t: "text", data: e.data } : { t: "audio", b64: toB64(new Uint8Array(e.data)) });
    } else if (m.t === "audio" && ws && ws.readyState === 1 && ws.bufferedAmount < 4e6) {
      ws.send(fromB64(m.b64));
    } else if (m.t === "close") {
      try { ws && ws.close(); } catch {}
    }
  });
  port.onDisconnect.addListener(() => { try { ws && ws.close(); } catch {} });
});

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
