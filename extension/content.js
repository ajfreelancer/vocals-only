// Vocals Only: plays any web video or audio with the music removed (vocals only).
//
// How it stays in sync: the media's audio is captured and sent (via bridge.js and sw.js) to the
// local server, which returns just the vocals a few seconds later. The picture is held back by
// the same fixed delay (frames are copied into a buffer and drawn late on a canvas), and every
// vocal region is scheduled against the media time of the frames it belongs to. Everything runs
// on the AudioContext clock, so nothing drifts. Pausing suspends that clock, which freezes
// picture and vocals together, exactly.
(() => {
  if (window.__voLoaded) return;
  window.__voLoaded = true;

  const TAG = "__vocalsOnly";
  let DELAY = 5.0;             // seconds the picture and vocals are held back; the server says what it needs
  let MAX_W = 1280;            // widest frame kept in the buffer (setting)
  const MIN_FRAME_GAP = 0.030; // keep ~30 fps even on 60 fps video
  const XFADE = 0.02;          // must match the server
  const IS_YT = /(^|\.)youtube\.com$/.test(location.hostname);
  const TOP = IS_YT || window.top === window; // only the top frame shows the YouTube-style button

  // Settings (set in the popup, stored by the extension). Defaults match bridge.js.
  const CFG = { delayMode: "auto", delayManual: 5, trimMs: 0, vocalGain: 1, model: "auto", maxWidth: 1280, floatingButton: true, sites: "all" };
  let serverDelay = 5.0;
  let S0 = null; // last server config

  let S = null;          // active session
  let starting = false;

  const mDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
  const vDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");

  // ---------- link to the background relay ----------
  let onBridge = null;
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== "fromBridge") return;
    const m = e.data;
    if (m.t === "settings") applySettings(m.s);
    else if (m.t === "cmd") { if (m.cmd === "toggle") toggle(true); }
    else onBridge && onBridge(m);
  });
  const post = (m, transfer) => window.postMessage({ [TAG]: "toBridge", ...m }, "*", transfer || []);

  // Opens the link, then waits briefly for the server's config (how much delay this PC needs).
  function applySettings(c) {
    Object.assign(CFG, c);
    MAX_W = Number(CFG.maxWidth) || 1280;
    if (S) {
      applyGain();
      // The delay is fixed for a running session (picture and vocals are already scheduled).
      updateChip();
    }
    refreshUi();
  }
  const siteAllowed = () => CFG.sites === "all" || IS_YT;

  function openLink(sr) {
    return new Promise((resolve, reject) => {
      let opened = false, done = false;
      const finish = (ok, err) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(cfgTimer); ok ? resolve() : (onBridge = null, reject(err)); };
      const timer = setTimeout(() => finish(false, new Error("no-bridge")), 3000);
      let cfgTimer = null;
      onBridge = (m) => {
        if (m.t === "open") { opened = true; setTimeout(() => !done && chip("Preparing the vocal model ..."), 1200); cfgTimer = setTimeout(() => { onBridge = onLink; finish(true); }, 30000); }
        else if (m.t === "text" && opened) {
          try {
            const cfg = JSON.parse(m.data);
            if (cfg.delay) serverDelay = Math.min(15, Math.max(3, Number(cfg.delay)));
            DELAY = CFG.delayMode === "manual" ? Math.min(15, Math.max(2, Number(CFG.delayManual) || 5)) : serverDelay;
            S0 = cfg;
            if (cfg.realtime === false) setTimeout(() => chip("This PC may be too slow to keep up live. Try Light quality in settings.", true), 500);
            if (CFG.delayMode === "manual" && DELAY + 0.3 < serverDelay) setTimeout(() => chip(`Delay ${DELAY}s is shorter than this PC needs (${serverDelay}s). Vocals may cut out.`, true), 900);
          } catch {}
          onBridge = onLink; finish(true);
        }
        else if (m.t === "error" || m.t === "close") finish(false, new Error("no-server"));
      };
      post({ t: "open", sr, model: CFG.model });
    });
  }
  function onLink(m) {
    if (!S) return;
    if (m.t === "audio") onVocals(m.buf);
    else if (m.t === "close" || m.t === "error") { chip("Server stopped.", true); disable(); }
  }

  // ---------- picking the media ----------
  function pickMedia() {
    const all = [...document.querySelectorAll("video, audio")];
    const score = (el) => {
      const playing = !el.paused && !el.ended && el.readyState > 2;
      const area = el.tagName === "VIDEO" ? el.offsetWidth * el.offsetHeight : 0;
      return (playing ? 1e9 : 0) + area + (el.duration > 0 ? 1 : 0);
    };
    const usable = all.filter((el) => {
      if (el.error || el.readyState === 0 && el.paused) return false;
      if (el.tagName === "VIDEO" && el.offsetWidth * el.offsetHeight < 160 * 90 && el.paused) return false;
      return true;
    });
    usable.sort((a, b) => score(b) - score(a));
    return usable[0] || null;
  }

  // ---------- session ----------
  async function enable(quiet) {
    if (S || starting) return; // ignore double clicks while connecting
    if (!siteAllowed()) { quiet || chip("Vocals only is limited to YouTube in settings.", true); return; }
    const v = IS_YT ? (document.querySelector("video.html5-main-video") || pickMedia()) : pickMedia();
    if (!v) { quiet || (chip("No video or audio found on this page.", true), setTimeout(() => !S && chip(null), 4000)); return; }
    starting = true;
    try { await start(v); } finally { starting = false; }
  }

  async function start(v) {
    setBtn(true);
    chip("Connecting to the vocal server...");

    const cs = v.captureStream ? v.captureStream() : null;
    let track = cs && cs.getAudioTracks()[0];
    for (let i = 0; cs && !track && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      track = cs.getAudioTracks()[0];
    }
    if (!track) { chip("This page does not allow capturing its audio.", true); setBtn(false); return fadeChip(); }
    const sr = (track.getSettings && track.getSettings().sampleRate) || 48000;

    try { await openLink(sr); }
    catch (err) {
      chip(err.message === "no-bridge"
        ? "Extension not ready here. Reload this page and try again."
        : "Server not running. Start 'Start Vocals Server.bat' first.", true);
      setBtn(false);
      return fadeChip();
    }

    const ctx = new AudioContext({ sampleRate: sr, latencyHint: "interactive" });
    await ctx.resume().catch(() => {});
    if (ctx.state !== "running") {
      chip("Chrome blocked audio. Click the mic button again.", true);
      post({ t: "close" }); ctx.close().catch(() => {}); setBtn(false);
      return fadeChip();
    }
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const isVideo = v.tagName === "VIDEO" && v.videoWidth > 0 && v.offsetWidth > 0;
    let canvas = null;
    if (isVideo) {
      canvas = document.createElement("canvas");
      canvas.className = "vo-canvas";
      const z = parseInt(getComputedStyle(v).zIndex, 10);
      canvas.style.cssText = "position:absolute;pointer-events:none;background:#000;z-index:" + (Number.isFinite(z) ? z + 1 : 1);
      v.insertAdjacentElement("afterend", canvas);
    }

    S = {
      v, ctx, gain, canvas, sr, isVideo, g2d: canvas ? canvas.getContext("2d") : null,
      alive: true, frames: [], refs: [], nodes: new Set(), cSamples: [], C: null,
      lastKept: null, lastEnd: null, late: 0, played: 0, user: null, rate: v.playbackRate,
      drawn: 0, snapFails: 0, lastDraw: 0, startedAt: performance.now(), catchUpUntil: 0, geomAt: 0,
    };

    // Show the current picture straight away so the player never goes black while buffering
    // (also covers a paused video, which produces no new frames to draw).
    if (isVideo) {
      try {
        const bm = await snapshot(v);
        canvas.width = bm.width; canvas.height = bm.height;
        S.g2d.drawImage(bm, 0, 0);
        bm.close();
      } catch {}
    }

    takeOverAudio();

    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    S.reader = reader;
    (async () => {
      try {
        while (S && S.alive) {
          const { value, done } = await reader.read();
          if (done) break;
          sendAudio(value);
          value.close();
        }
      } catch {}
    })();

    // Chrome stops delivering video frames while the window is minimized or the tab is hidden,
    // but audio keeps going. On return the picture needs DELAY seconds to catch up.
    S.onVis = () => {
      if (!S || document.hidden) return;
      S.lastDraw = performance.now();
      S.catchUpUntil = performance.now() + DELAY * 1000;
      updateChip();
    };
    document.addEventListener("visibilitychange", S.onVis);

    // Pause freezes picture and vocals together by stopping the audio clock; play resumes it.
    S.onPause = () => { S && S.ctx.state === "running" && S.ctx.suspend().catch(() => {}); };
    S.onPlay = () => { if (!S) return; S.lastDraw = performance.now(); S.ctx.resume().catch(() => {}); };
    S.onRate = () => { if (S) { S.cSamples = []; S.C = null; } };
    S.onSeek = flush;
    v.addEventListener("pause", S.onPause);
    v.addEventListener("play", S.onPlay);
    v.addEventListener("playing", S.onPlay);
    v.addEventListener("ratechange", S.onRate);
    v.addEventListener("seeking", S.onSeek);
    v.addEventListener("emptied", S.onSeek);

    if (isVideo) {
      S.rvfc = v.requestVideoFrameCallback(onFrame);
      S.raf = requestAnimationFrame(draw);
    } else {
      // No picture to time against: map media time to the audio clock by sampling.
      S.refTimer = setInterval(() => {
        const s = S; if (!s || s.v.paused || s.v.seeking) return;
        s.refs.push({ m: s.v.currentTime, c: s.ctx.currentTime });
        if (s.refs.length > 900) s.refs.splice(0, 300);
      }, 100);
    }
    S.timer = setInterval(tick, 400);
    tick();
  }

  function disable() {
    if (!S) return;
    const s = S; S = null;
    s.alive = false;
    onBridge = null;
    post({ t: "close" });
    clearInterval(s.timer); clearInterval(s.refTimer);
    cancelAnimationFrame(s.raf);
    try { s.v.cancelVideoFrameCallback(s.rvfc); } catch {}
    document.removeEventListener("visibilitychange", s.onVis);
    s.v.removeEventListener("pause", s.onPause);
    s.v.removeEventListener("play", s.onPlay);
    s.v.removeEventListener("playing", s.onPlay);
    s.v.removeEventListener("ratechange", s.onRate);
    s.v.removeEventListener("seeking", s.onSeek);
    s.v.removeEventListener("emptied", s.onSeek);
    try { s.reader.cancel(); } catch {}
    s.nodes.forEach((n) => { try { n.stop(); } catch {} });
    s.frames.forEach((f) => f.bm.close());
    s.canvas && s.canvas.remove();
    // give the original audio and volume control back
    delete s.v.muted; delete s.v.volume;
    mDesc.set.call(s.v, s.user ? s.user.muted : false);
    vDesc.set.call(s.v, s.user ? s.user.volume : 1);
    s.ctx.close().catch(() => {});
    setBtn(false);
    fadeChip();
  }

  // Runs every 400 ms: status text and checks that need no frame callback.
  function tick() {
    const s = S; if (!s) return;
    if (!s.v.isConnected) { chip("This video was replaced. Vocals only turned off.", true); disable(); return; }
    updateChip();
  }

  // The original sound is kept silent by muting the element for real, while the page (and its
  // own controls) still see the user's mute/volume. captureStream ignores both.
  function takeOverAudio() {
    const v = S.v;
    S.user = { muted: v.muted, volume: v.volume };
    Object.defineProperty(v, "muted", {
      configurable: true, get: () => S.user.muted,
      set: (x) => { S.user.muted = !!x; applyGain(); v.dispatchEvent(new Event("volumechange")); },
    });
    Object.defineProperty(v, "volume", {
      configurable: true, get: () => S.user.volume,
      set: (x) => { S.user.volume = x; applyGain(); v.dispatchEvent(new Event("volumechange")); },
    });
    mDesc.set.call(v, true);
    applyGain();
  }
  function applyGain() { if (S) S.gain.gain.value = S.user.muted ? 0 : S.user.volume * (Number(CFG.vocalGain) || 1); }

  // ---------- audio out to the server ----------
  function sendAudio(ad) {
    const s = S;
    if (!s) return;
    if (ad.sampleRate !== s.sr) {
      // The real rate is only known from the audio itself: tell the server and start over.
      s.sr = ad.sampleRate; s.cSamples = []; s.C = null; s.lastEnd = null;
      post({ t: "open", sr: s.sr });
      return;
    }
    const n = ad.numberOfFrames;
    const ts = ad.timestamp / 1e6;
    const buf = new ArrayBuffer(12 + 8 * n);
    const dv = new DataView(buf);
    dv.setFloat64(0, ts, true);
    dv.setUint32(8, n, true);
    ad.copyTo(new Float32Array(buf, 12, n), { planeIndex: 0, format: "f32-planar" });
    ad.copyTo(new Float32Array(buf, 12 + 4 * n, n), { planeIndex: ad.numberOfChannels > 1 ? 1 : 0, format: "f32-planar" });
    post({ t: "audio", buf }, [buf]);

    // Audio timestamps run on stream time; media time = K + rate * ts. K is constant at a given
    // speed, so learn it from the playing element (median of recent samples).
    if (!s.v.paused && !s.v.seeking) {
      const r = s.v.playbackRate;
      if (r !== s.rate) { s.rate = r; s.cSamples = []; s.C = null; }
      s.cSamples.push(s.v.currentTime - r * ts);
      if (s.cSamples.length > 200) s.cSamples.shift();
      if (s.cSamples.length >= 40 && (s.C === null || s.cSamples.length % 25 === 0)) {
        const a = s.cSamples.slice().sort((x, y) => x - y);
        s.C = a[a.length >> 1];
      }
    }
  }

  // ---------- video frames held back ----------
  // A copy of the current picture. Falls back to a canvas copy if createImageBitmap refuses.
  async function snapshot(v) {
    const w = Math.min(v.videoWidth, MAX_W);
    try {
      return await createImageBitmap(v, { resizeWidth: w, resizeQuality: "low" });
    } catch {
      const h = Math.round(w * v.videoHeight / v.videoWidth);
      const oc = new OffscreenCanvas(w, h);
      oc.getContext("2d").drawImage(v, 0, 0, w, h);
      return oc.transferToImageBitmap();
    }
  }

  function onFrame(_now, meta) {
    const s = S; if (!s || !s.alive) return;
    try {
      const ot = s.ctx.getOutputTimestamp();
      const nowC = s.ctx.currentTime;
      const c = ot.contextTime + (meta.expectedDisplayTime - ot.performanceTime) / 1000;
      // Right after the context starts, Chrome can report a zero clock; such a frame would get a
      // display time that never arrives and block every later frame. Only trust sane values.
      if (Number.isFinite(c) && c > nowC - 2 && c < nowC + 2) {
        s.refs.push({ m: meta.mediaTime, c });
        if (s.refs.length > 900) s.refs.splice(0, 300);
        if (s.lastKept === null || meta.mediaTime < s.lastKept || meta.mediaTime - s.lastKept >= MIN_FRAME_GAP) {
          s.lastKept = meta.mediaTime;
          if (s.v.videoWidth) {
            snapshot(s.v)
              .then((bm) => { if (S === s && s.alive) s.frames.push({ c, bm }); else bm.close(); })
              .catch(() => { s.snapFails++; });
          }
        }
      }
    } finally {
      if (S === s && s.alive) s.rvfc = s.v.requestVideoFrameCallback(onFrame);
    }
  }

  function draw() {
    const s = S; if (!s || !s.alive) return;
    const t = s.ctx.currentTime;
    const fr = s.frames;
    // Newest frame that is due. Scan everything so one odd entry can never block the rest.
    let k = -1;
    for (let i = 0; i < fr.length; i++) { if (fr[i].c + DELAY <= t && (k < 0 || fr[i].c >= fr[k].c)) k = i; }
    if (k >= 0) {
      const bm = fr[k].bm;
      const keep = [];
      for (let i = 0; i < fr.length; i++) {
        if (i === k) continue;
        if (fr[i].c <= fr[k].c) fr[i].bm.close(); else keep.push(fr[i]);
      }
      s.frames = keep;
      if (s.canvas.width !== bm.width || s.canvas.height !== bm.height) { s.canvas.width = bm.width; s.canvas.height = bm.height; }
      s.g2d.drawImage(bm, 0, 0);
      bm.close();
      s.drawn++;
      s.lastDraw = performance.now();
    }
    // Safety net: never leave a black screen. If nothing was drawn for a long time while the
    // video is playing, switch the feature off and give the normal video back.
    if (!document.hidden && !s.v.paused && !s.v.seeking && performance.now() - Math.max(s.lastDraw, s.startedAt) > (DELAY + 7) * 1000) {
      chip("No picture frames could be captured here. Turned off.", true);
      disable();
      return;
    }
    placeCanvas(s);
    s.raf = requestAnimationFrame(draw);
  }

  // Keep the canvas exactly over the video: same box, fit and transform.
  function placeCanvas(s) {
    const v = s.v, cs = s.canvas.style;
    const px = (n) => n + "px";
    if (cs.left !== px(v.offsetLeft)) cs.left = px(v.offsetLeft);
    if (cs.top !== px(v.offsetTop)) cs.top = px(v.offsetTop);
    if (cs.width !== px(v.offsetWidth)) cs.width = px(v.offsetWidth);
    if (cs.height !== px(v.offsetHeight)) cs.height = px(v.offsetHeight);
    const now = performance.now();
    if (now - s.geomAt > 500) {
      s.geomAt = now;
      const g = getComputedStyle(v);
      cs.objectFit = g.objectFit; cs.objectPosition = g.objectPosition;
      cs.transform = g.transform === "none" ? "" : g.transform; cs.transformOrigin = g.transformOrigin;
    }
  }

  function flush() {
    const s = S; if (!s) return;
    s.frames.forEach((f) => f.bm.close());
    s.frames = []; s.refs = []; s.lastKept = null; s.lastEnd = null;
    s.cSamples = []; s.C = null; // media time restarts after a seek or a new video: relearn the offset
    s.nodes.forEach((n) => { try { n.stop(); } catch {} });
    s.nodes.clear();
  }

  // ---------- vocals back from the server ----------
  function ctxOfMedia(s, m) {
    let best = null, bd = Infinity;
    for (let i = s.refs.length - 1; i >= 0; i--) {
      const d = Math.abs(s.refs[i].m - m);
      if (d < bd) { bd = d; best = s.refs[i]; }
      else if (bd < 0.05) break;
    }
    return best ? best.c + (m - best.m) / (s.v.playbackRate || 1) : null;
  }

  function onVocals(data) {
    const s = S; if (!s || !s.alive || s.C === null) return;
    const dv = new DataView(data);
    const ts = dv.getFloat64(0, true);
    const n = dv.getUint32(8, true);
    const L = new Float32Array(data, 12, n);
    const R = new Float32Array(data, 12 + 4 * n, n);
    const sr = s.sr;

    const at = ctxOfMedia(s, s.C + s.rate * ts);
    if (at === null) return;
    const playAt = at + DELAY + (CFG.trimMs || 0) / 1000;

    const buf = s.ctx.createBuffer(2, n, sr);
    const l = buf.getChannelData(0), r = buf.getChannelData(1);
    l.set(L); r.set(R);
    const xf = Math.round(XFADE * sr);
    const continues = s.lastEnd !== null && Math.abs(ts - s.lastEnd) < 0.005;
    if (continues) for (let i = 0; i < xf; i++) { const g = i / xf; l[i] *= g; r[i] *= g; }
    for (let i = 0; i < xf; i++) { const g = i / xf, j = n - 1 - i; l[j] *= g; r[j] *= g; }
    s.lastEnd = ts + (n - xf) / sr;

    const node = s.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(s.gain);
    node.onended = () => s.nodes.delete(node);
    const now = s.ctx.currentTime;
    if (playAt >= now) node.start(playAt);
    else {
      s.late++;
      const skip = now - playAt;
      if (skip >= buf.duration) return;
      node.start(now, skip);
    }
    s.nodes.add(node);
    s.played++;
  }

  // ---------- UI ----------
  function setBtn(on) {
    post({ t: "state", on });
    document.querySelectorAll(".vo-btn, .vo-fab").forEach((b) => {
      b.style.color = on ? "#ff7a1a" : b.classList.contains("vo-fab") ? "#fff" : "";
      b.setAttribute("aria-pressed", String(on));
    });
  }

  let chipTimer = null;
  function fadeChip() { clearTimeout(chipTimer); chipTimer = setTimeout(() => { if (!S) chip(null); }, 5000); }

  function chip(text, warn) {
    let c = document.querySelector(".vo-chip");
    if (!text) { c && c.remove(); return; }
    if (!c) {
      const yt = IS_YT && document.querySelector(".html5-video-player");
      c = document.createElement("div");
      c.className = "vo-chip";
      c.style.cssText = "z-index:2147483646;padding:6px 10px;border-radius:8px;font:12px/1.3 system-ui,sans-serif;" +
        "color:#fff;pointer-events:none;" + (yt ? "position:absolute;top:12px;left:12px" : "position:fixed;left:12px;bottom:12px");
      (yt || document.body).appendChild(c);
    }
    c.textContent = text;
    c.style.background = warn ? "rgba(160,30,30,.9)" : "rgba(0,0,0,.7)";
    if (warn) fadeChip();
  }

  function updateChip() {
    const s = S; if (!s) return;
    const catching = performance.now() < s.catchUpUntil;
    chip(catching ? "Vocals only: picture catching up after the window was hidden..."
      : s.played === 0 ? `Vocals only: starting, ${DELAY}s delay...`
      : `Vocals only | ${DELAY}s behind | trim ${CFG.trimMs || 0} ms (Alt+, / Alt+.)` + (s.late ? ` | late ${s.late}` : ""));
  }

  function toggle(quiet) { S ? disable() : enable(quiet === true); }

  const micPath = "M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z";
  function micIcon(pad) {
    // Trusted Types (YouTube and others) forbid innerHTML, so build the icon with DOM calls.
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
    svg.setAttribute("fill", "currentColor");
    svg.style.cssText = `padding:${pad}px;box-sizing:border-box`;
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", micPath);
    svg.appendChild(p);
    return svg;
  }

  // YouTube: a button in the player bar.
  function ensureYtButton() {
    const bar = document.querySelector(".ytp-right-controls");
    if (!bar || bar.querySelector(".vo-btn")) return;
    const b = document.createElement("button");
    b.className = "ytp-button vo-btn";
    b.title = "Vocals only (remove music)";
    b.setAttribute("aria-label", "Vocals only");
    b.appendChild(micIcon(10));
    b.onclick = () => toggle();
    bar.prepend(b);
    if (S) setBtn(true);
  }

  // Everywhere else: a small floating button, shown only while the page has playable media.
  function ensureFab() {
    const has = CFG.floatingButton && siteAllowed() && !!pickMedia() && (TOP || (pickMedia().offsetWidth >= 240));
    let f = document.querySelector(".vo-fab");
    if (!has && !S) { f && f.remove(); return; }
    if (f || !document.body) return;
    f = document.createElement("button");
    f.className = "vo-fab";
    f.title = "Vocals only (remove music)  [Alt+V]";
    f.setAttribute("aria-label", "Vocals only");
    f.style.cssText = "position:fixed;right:16px;bottom:96px;width:44px;height:44px;border-radius:50%;border:0;padding:0;" +
      "cursor:pointer;z-index:2147483646;color:#fff;background:rgba(20,20,20,.72);box-shadow:0 2px 8px rgba(0,0,0,.4);" +
      "opacity:.55;transition:opacity .15s";
    f.onmouseenter = () => { f.style.opacity = "1"; };
    f.onmouseleave = () => { f.style.opacity = S ? "1" : ".55"; };
    f.appendChild(micIcon(10));
    f.onclick = () => toggle();
    document.body.appendChild(f);
    if (S) setBtn(true);
  }

  let refreshTimer = null;
  function refreshUi() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { IS_YT ? ensureYtButton() : ensureFab(); }, 300);
  }

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "KeyV") { toggle(); e.preventDefault(); return; }
    if (!e.altKey || (e.code !== "Comma" && e.code !== "Period")) return;
    CFG.trimMs = (CFG.trimMs || 0) + (e.code === "Period" ? 10 : -10);
    post({ t: "set", key: "trimMs", value: CFG.trimMs });
    updateChip();
    e.preventDefault();
  }, true);

  // Small read-only snapshot for debugging from the console: window.__voDebug()
  window.__voDebug = () => S && {
    C: S.C, played: S.played, late: S.late, frames: S.frames.length, refs: S.refs.length, isVideo: S.isVideo,
    cSpreadMs: S.cSamples.length ? (Math.max(...S.cSamples) - Math.min(...S.cSamples)) * 1000 : null,
    drawn: S.drawn, snapFails: S.snapFails, ctxTime: S.ctx.currentTime, sr: S.sr, ctxState: S.ctx.state,
  };
  window.__voToggle = toggle;

  new MutationObserver(refreshUi).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("play", refreshUi, true);
  document.addEventListener("loadedmetadata", refreshUi, true);
  post({ t: "getSettings" });
  refreshUi();
})();
