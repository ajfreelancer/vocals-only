"""One-time setup for the Vocals Only server. Works on any Windows PC, with or without a graphics card.

    py -3 setup.py                 install next to this file (folder "venv")
    py -3 setup.py --venv D:\\x\\venv   install somewhere else (e.g. a drive with more space)
    py -3 setup.py --cpu           force the lighter processor-only install

With an NVIDIA graphics card it installs the GPU build of PyTorch and both models (about 3 GB).
Without one it installs the small processor build and the light model (about 1 GB).
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def run(cmd, **kw):
    print("  > " + " ".join(cmd), flush=True)
    subprocess.check_call(cmd, **kw)


def has_nvidia():
    exe = shutil.which("nvidia-smi")
    if not exe:
        return False
    try:
        out = subprocess.run([exe, "-L"], capture_output=True, text=True, timeout=15).stdout
        return "GPU" in out
    except Exception:
        return False


def main():
    if not (3, 9) <= sys.version_info[:2] <= (3, 13):
        sys.exit(f"Python {sys.version_info.major}.{sys.version_info.minor} found. Please install Python 3.10 to 3.13 from python.org "
                 "(tick 'Add python.exe to PATH') and run this again.")

    venv = os.path.abspath(arg("--venv", os.path.join(HERE, "venv")))
    gpu = has_nvidia() and "--cpu" not in sys.argv
    print(f"\nGraphics card: {'NVIDIA found, installing the GPU build' if gpu else 'none (or forced off), installing the processor build'}")
    print(f"Install folder: {venv}\n")

    py = os.path.join(venv, "Scripts", "python.exe") if os.name == "nt" else os.path.join(venv, "bin", "python")
    steps = 5
    print(f"[1/{steps}] Creating the Python environment")
    if not os.path.exists(py):
        run([sys.executable, "-m", "venv", venv])
    run([py, "-m", "pip", "install", "-q", "--upgrade", "pip"])

    print(f"\n[2/{steps}] Installing PyTorch ({'about 2.5 GB' if gpu else 'about 200 MB'}), this is the long one")
    index = "https://download.pytorch.org/whl/cu124" if gpu else "https://download.pytorch.org/whl/cpu"
    run([py, "-m", "pip", "install", "-q", "torch==2.6.0", "torchaudio==2.6.0", "--index-url", index])

    print(f"\n[3/{steps}] Installing the audio libraries")
    pkgs = ["websockets", "numpy", "openunmix"] + (["demucs"] if gpu else [])
    run([py, "-m", "pip", "install", "-q"] + pkgs)

    print(f"\n[4/{steps}] Downloading the AI models")
    code = ("import torch, openunmix; openunmix.umxhq(targets=['vocals'], device='cpu', pretrained=True, niter=0); print('  light model ready');"
            + ("from demucs.pretrained import get_model; get_model('htdemucs'); print('  best model ready')" if gpu else ""))
    run([py, "-c", code])

    print(f"\n[5/{steps}] Checking")
    run([py, "-c", "import torch, websockets; print('  PyTorch', torch.__version__, '| graphics card in use:', torch.cuda.is_available())"])

    # Remember where the environment is so Start Vocals Server.bat can find it.
    with open(os.path.join(HERE, "venv_path.txt"), "w", encoding="utf-8") as f:
        f.write(venv)
    print("\nDone. Double-click 'Start Vocals Server.bat', then load the 'extension' folder in Chrome (see README.md).")


if __name__ == "__main__":
    main()
