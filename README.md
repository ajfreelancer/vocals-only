# Vocals Only (local AI)

Removes music from videos and audio on web pages and keeps the vocals, live. It runs on your own PC, free,
with or without a graphics card. Nothing is sent over the internet.

## Install (any Windows PC)
0. Click the green **Code** button on GitHub > **Download ZIP**, then unzip it somewhere (a drive with 3 GB free).
1. Double-click **Install.bat** (once). It needs Python 3.10 to 3.13 and internet. It sets itself up for your PC:
   - NVIDIA graphics card: about 3 GB, best quality.
   - No graphics card: about 1 GB, lighter model that still runs live on the processor.
2. In Chrome: Extensions > Manage extensions > turn on **Developer mode** > **Load unpacked** > pick the `extension` folder.

## Use it
1. Double-click **Start Vocals Server.bat** and leave the window open (ready after about 30 s).
2. Open a page with a video or audio (YouTube, Facebook, a lecture site, a podcast page...).
3. Click the **round mic button** (on YouTube it sits in the player controls), or press **Alt + V**, or open the toolbar icon and press "Turn on for this tab".
4. Wait about 5 seconds. Picture and vocals start together, a few seconds behind live.

## Settings (toolbar icon)
| Setting | What it does |
|---|---|
| Server status | Green when the server is running; shows graphics card or processor and its speed |
| Quality | Auto (recommended), Best (NVIDIA only), Light (any PC) |
| Delay | Auto uses what your PC needs; Manual lets you set 3 to 15 s |
| Picture size | 480p, 720p or 1080p picture buffer |
| Fine sync | Moves the vocals 10 ms per step if lips look early or late (also **Alt + ,** and **Alt + .**) |
| Vocal volume | 50% to 200% |
| Sites | All sites, or YouTube only |
| Round button | Hide it and use Alt + V |
| Server port | Only if you changed it |

Quality, delay and picture size apply the next time you turn it on. The rest apply instantly.

## How it stays in sync
The audio goes to the server, which sends back the vocals a few seconds later. The picture is held back by the
same delay and drawn late, and every vocal region is scheduled against the media time of the frames it belongs to,
all on one clock. Pausing freezes picture and vocals together. Speed changes (1.25x, 1.5x, 2x) and seeking work.

## Limits
- Chrome on Windows with the server running. One video at a time.
- Chrome sends no pictures while the window is minimized or the tab is hidden; audio keeps going. When you return,
  the picture needs the delay time to catch up.
- Captions and comments appear a few seconds before the picture.
- Light quality (processor) has a little more music bleed than Best.
- Copy-protected video (Netflix, Disney+, paid movies, Spotify web) can't be captured.
- A graphics card also used by a game or video editor slows the server; the delay is re-measured each time you turn it on.

## Files
- `server.py` the local AI server (Demucs on a graphics card, Open-Unmix on the processor)
- `extension/` the Chrome extension (`content.js` page logic, `sw.js` background link, `bridge.js` settings link, `popup.*` settings screen)
- `setup.py` / `Install.bat` one-time setup, `Start Vocals Server.bat` daily start
