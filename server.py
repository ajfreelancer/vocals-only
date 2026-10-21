"""Local vocal-isolation server for the Chrome extension.

Receives live stereo audio over a WebSocket on 127.0.0.1, separates the vocals on this PC and
streams them back in short regions with their timestamps. Works with or without a graphics card:

    NVIDIA GPU  -> Demucs (htdemucs), best quality
    otherwise   -> Open-Unmix (umxhq) on the CPU, lighter, runs live on ordinary PCs

The extension picks the model per connection (Auto / Best / Light); models load on first use.

Options: --device cuda|cpu   --port N   --dev (accept web pages, for testing)

Messages (little endian):
    text   {"sr": 48000, "model": "auto"}   client -> server, first: audio rate and model choice
    text   {"delay": 5.0, "model": ...}     server -> client, reply: seconds of delay this PC needs
    text   {"status": 1}                    client -> server (settings page): reply with server info
    binary float64 ts | uint32 n | float32 L[n] | float32 R[n]      (both directions)
ts is the browser's timestamp (seconds) of the first sample.

Only the extension (Origin chrome-extension://...) may connect, unless --dev is given.
"""
import asyncio
import json
import math
import struct
import sys
import time

import numpy as np
import torch
import torchaudio
import websockets


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


HOST = "127.0.0.1"
PORT = int(arg("--port", 8765))
DEV_MODE = "--dev" in sys.argv
MODEL_SR = 44100
DEFAULT_SR = 48000

# Window = left context + emitted region + right context (seconds).
HOP = 2.0      # output produced per inference
RIGHT = 2.0    # lookahead after each region (this is the latency cost)
WINDOW = 7.5   # total fed to the model (htdemucs trains on 7.8 s)
XFADE = 0.02   # overlap between consecutive regions

DEVICE = arg("--device") or ("cuda" if torch.cuda.is_available() else "cpu")
if DEVICE == "cpu":
    torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
GPU_NAME = torch.cuda.get_device_name(0) if DEVICE == "cuda" else None

# kind -> {"model", "vocals", "infer", "delay", "live"}
MODELS = {}


def resolve_kind(pref: str) -> str:
    """Auto: Demucs on a GPU, Open-Unmix otherwise. Best needs a GPU to be live; Light is always Open-Unmix."""
    if pref == "light":
        return "umx"
    if pref in ("best", "htdemucs") and DEVICE == "cuda":
        return "htdemucs"
    return "htdemucs" if DEVICE == "cuda" else "umx"


def load_model(kind: str):
    if kind in MODELS:
        return MODELS[kind]
    print(f"Loading model '{kind}' on {DEVICE} ...", flush=True)
    if kind == "htdemucs":
        from demucs.pretrained import get_model
        m = get_model("htdemucs").to(DEVICE).eval()
        entry = {"model": m, "vocals": m.sources.index("vocals")}
    else:
        import openunmix
        m = openunmix.umxhq(targets=["vocals"], device=DEVICE, pretrained=True, niter=0)  # niter=0: no Wiener filter, faster
        m.eval()
        entry = {"model": m, "vocals": 0}
    MODELS[kind] = entry
    measure(kind)
    return entry


@torch.no_grad()
def separate(x: np.ndarray, sr: int, pad: int = 0, kind: str = "htdemucs") -> np.ndarray:
    """x: (2, n) float32 at sr  ->  vocals (2, n) float32 at sr.

    pad (Demucs only): zero samples put in front so early windows have the same length as full
    ones, which keeps the GPU kernels warm. Level statistics ignore the padding."""
    n = x.shape[1]
    if float(np.abs(x).max()) < 1e-4:  # silence (paused / muted): skip the model
        return np.zeros_like(x)
    entry = MODELS[kind]
    t = torch.from_numpy(x).to(DEVICE)
    if sr != MODEL_SR:
        t = torchaudio.functional.resample(t, sr, MODEL_SR)

    if kind == "htdemucs":
        from demucs.apply import apply_model
        ref = t.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-6
        inp = (t - mean) / std
        padn = int(round(pad * MODEL_SR / sr))
        if padn:
            inp = torch.nn.functional.pad(inp, (padn, 0))
        with torch.autocast(DEVICE, enabled=DEVICE == "cuda"):
            out = apply_model(entry["model"], inp[None], device=DEVICE, split=True, overlap=0.1, progress=False)[0]
        v = out[entry["vocals"]].float()[:, padn:] * std + mean
    else:
        v = entry["model"](t[None])[0, 0]  # (1, 1, 2, n) -> (2, n)

    if sr != MODEL_SR:
        v = torchaudio.functional.resample(v, MODEL_SR, sr)
    v = v[:, :n]
    if v.shape[1] < n:
        v = torch.nn.functional.pad(v, (0, n - v.shape[1]))
    return v.cpu().numpy()


def noise(seconds, sr):
    return np.random.randn(2, int(seconds * sr)).astype(np.float32) * 0.1


def measure(kind: str):
    """Warm every window length a new stream produces, then time a full window (best of 5)."""
    entry = MODELS[kind]
    for sr in (48000, 44100):
        for seconds in (HOP + RIGHT, HOP + RIGHT + HOP, WINDOW):
            n = int(seconds * sr)
            separate(noise(seconds, sr), sr, max(0, int(WINDOW * sr) - n), kind)
    times = []
    for _ in range(5):
        t = time.time()
        separate(noise(WINDOW, DEFAULT_SR), DEFAULT_SR, 0, kind)
        times.append(time.time() - t)
    set_timing(kind, min(times))


def set_timing(kind: str, infer: float):
    entry = MODELS[kind]
    # Time before a region can play: its own length + lookahead + compute (+ safety), rounded up to 0.5 s.
    entry["infer"] = infer
    entry["delay"] = max(4.0, math.ceil((HOP + RIGHT + 1.2 * infer + 0.4) * 2) / 2)
    entry["live"] = infer < 0.85 * HOP
    print(f"[{kind}] one {WINDOW:.1f} s window takes {infer * 1000:.0f} ms ({WINDOW / infer:.1f}x real time) -> "
          f"delay {entry['delay']:.1f} s" + ("" if entry["live"] else "   WARNING: too slow to keep up live on this PC"), flush=True)


def remeasure(kind: str, sr: int):
    """Quick re-timing when a client connects, so the delay reflects how busy this PC is right now."""
    times = []
    for _ in range(3):
        t = time.time()
        separate(noise(WINDOW, sr), sr, 0, kind)
        times.append(time.time() - t)
    set_timing(kind, min(times))


class Stream:
    """Rolling audio buffer for one connection."""

    def __init__(self, sr=DEFAULT_SR, kind="htdemucs"):
        self.sr = sr
        self.kind = kind
        self.reset(None)

    def reset(self, ts0):
        self.ts0 = ts0            # timestamp of absolute sample 0
        self.buf = np.zeros((2, 0), np.float32)
        self.buf_start = 0        # absolute index of buf[:, 0]
        self.next_emit = 0        # absolute index where the next region starts

    @property
    def total(self):
        return self.buf_start + self.buf.shape[1]

    def push(self, ts, block):
        if self.ts0 is None:
            self.reset(ts)
        expected = self.ts0 + self.total / self.sr
        if abs(ts - expected) > 0.05:  # seek, pause or glitch: start over
            print(f"  gap {ts - expected:+.3f}s -> reset", flush=True)
            self.reset(ts)
        self.buf = np.concatenate([self.buf, block], axis=1)

    def ready(self):
        return self.total >= self.next_emit + int((HOP + RIGHT) * self.sr)

    def take(self):
        sr = self.sr
        e0 = self.next_emit
        e1 = e0 + int(HOP * sr)
        w1 = e1 + int(RIGHT * sr)
        w0 = max(self.buf_start, w1 - int(WINDOW * sr))
        return e0, e1, w0, self.buf[:, w0 - self.buf_start: w1 - self.buf_start]

    def advance(self, e1):
        self.next_emit = e1
        keep_from = e1 + int((HOP + RIGHT) * self.sr) - int(WINDOW * self.sr)
        drop = keep_from - self.buf_start
        if drop > 0:
            self.buf = self.buf[:, drop:]
            self.buf_start = keep_from


def status_message():
    return json.dumps({
        "status": True, "device": DEVICE, "gpu": GPU_NAME, "default": resolve_kind("auto"),
        "models": {k: {"x_realtime": round(WINDOW / v["infer"], 1), "delay": v["delay"], "live": v["live"]} for k, v in MODELS.items()},
    })


async def handler(ws):
    origin = ws.request.headers.get("Origin", "") if ws.request else ""
    if not DEV_MODE and not origin.startswith("chrome-extension://"):
        print(f"rejected connection from origin {origin!r}", flush=True)
        await ws.close(1008, "extension only")
        return
    stream = Stream()
    loop = asyncio.get_running_loop()
    streaming = False
    try:
        async for msg in ws:
            if isinstance(msg, str):
                try:
                    hello = json.loads(msg)
                except Exception:
                    continue
                if hello.get("status"):
                    await ws.send(status_message())
                    continue
                sr = int(hello.get("sr", DEFAULT_SR))
                if not 8000 <= sr <= 96000:
                    continue
                kind = resolve_kind(str(hello.get("model", "auto")))
                if not streaming:
                    print("client connected", flush=True)
                streaming = True
                entry = await loop.run_in_executor(None, load_model, kind)  # instant if already loaded
                await loop.run_in_executor(None, remeasure, kind, sr)       # also wakes an idle GPU
                stream = Stream(sr, kind)
                print(f"  audio {sr} Hz, model {kind}", flush=True)
                await ws.send(json.dumps({"delay": entry["delay"], "model": kind, "device": DEVICE,
                                          "realtime": entry["live"], "x_realtime": round(WINDOW / entry["infer"], 1)}))
                continue
            if not streaming:
                continue
            sr = stream.sr
            ts, n = struct.unpack_from("<dI", msg, 0)
            arr = np.frombuffer(msg, dtype="<f4", offset=12, count=2 * n).reshape(2, n)
            stream.push(ts, arr)
            xf = int(XFADE * sr)
            while stream.ready():
                e0, e1, w0, window = stream.take()
                t = time.time()
                pad = max(0, int(WINDOW * sr) - window.shape[1])
                vocals = await loop.run_in_executor(None, separate, window, sr, pad, stream.kind)
                ms = (time.time() - t) * 1000
                region = vocals[:, e0 - w0: e1 - w0 + xf]
                out = struct.pack("<dI", stream.ts0 + e0 / sr, region.shape[1])
                out += np.ascontiguousarray(region, dtype="<f4").tobytes()
                await ws.send(out)
                stream.advance(e1)
                rms_in = float(np.sqrt(np.mean(window[:, e0 - w0: e1 - w0] ** 2)))
                rms_out = float(np.sqrt(np.mean(region ** 2)))
                print(f"  region {stream.ts0 + e0 / sr:8.2f}s  infer {ms:5.0f} ms  "
                      f"level in {rms_in:.3f} -> vocals {rms_out:.3f}", flush=True)
    except websockets.ConnectionClosed:
        pass
    finally:
        if streaming:
            print("client disconnected", flush=True)


async def main():
    print(f"Device: {DEVICE}" + (f" ({GPU_NAME})" if GPU_NAME else " (no NVIDIA graphics card found, using the processor)"), flush=True)
    load_model(resolve_kind("auto"))  # the default model is ready before the first connection
    async with websockets.serve(handler, HOST, PORT, max_size=2**22):
        print(f"Ready: ws://{HOST}:{PORT}" + ("  [dev: web pages allowed]" if DEV_MODE else "") + "  (Ctrl+C to stop)", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
