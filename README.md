# WebStreamingProj

Browser-based local network game streaming. Run WoW (or any game) on your PC and play from any device's browser on the same LAN — no app install needed.

## Prerequisites

1. **Node.js** v18 or v20 LTS — https://nodejs.org
2. **FFmpeg** on PATH
   ```
   winget install ffmpeg
   ```
3. **Build tools** (needed by `robotjs` for input injection — run once as admin):
   ```
   npm install -g windows-build-tools
   ```
   Or install **Visual Studio Build Tools** + **Python 3** manually.

## Setup & Run

```bash
cd d:\pytorchStudy\c++Practice\WebStreamingProj
npm install
npm start
```

On startup you'll see:

```
╔══════════════════════════════════════╗
║       Game Stream Server Ready       ║
╚══════════════════════════════════════╝
  Local:   http://localhost:3000
  Network: http://192.168.x.x:3000   ← open this on other devices
```

## Usage

1. Start your game on the PC (WoW, etc.)
2. Open the **Network URL** in a browser on any device on your LAN
3. Click **Connect & Play**
4. Click the video to **lock your mouse** (enables relative mouse movement for camera)
5. Press **Esc** to release the mouse lock

## Controls

| Input | Behaviour |
|-------|-----------|
| Mouse over video | Moves cursor on PC |
| Click video | Locks pointer (relative mode — good for camera rotation) |
| Esc | Releases pointer lock |
| Left / Right / Middle click | Passed to PC |
| Scroll wheel | Passed to PC |
| Keyboard | Captured when pointer is locked |
| Touch drag | Emulates mouse move + left click (mobile/tablet) |

## Tuning

Edit the top of [server.js](server.js):

```js
const WIDTH  = 1280;   // stream width  (lower = less CPU/bandwidth)
const HEIGHT = 720;    // stream height
const FPS    = 30;     // target frame rate
```

## Troubleshooting

**Black screen / no video**
- Verify FFmpeg is installed: `ffmpeg -version`
- Watch the terminal for `[ffmpeg]` error lines

**Input not working**
- `robotjs` needs build tools — check `npm install` output for errors
- Alternative with prebuilts: replace `robotjs` with `@nut-tree-fork/nut-js`

**High latency**
- Both devices should be on the same Wi-Fi or wired LAN
- Try wired ethernet on the streaming PC
- Lower `WIDTH` / `HEIGHT` / `FPS` in server.js

**`@roamhq/wrtc` install fails**
- Use Node.js LTS (18.x or 20.x) — it has matching prebuilt binaries
