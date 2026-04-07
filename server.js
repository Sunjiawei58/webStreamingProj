'use strict';
// ── Log tee: write everything to logs/server-YYYY-MM-DD_HH-MM-SS.log ─────────
const fs   = require('fs');
const fsPath = require('path');
{
  const logDir = fsPath.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

  // Build timestamp string safe for filenames
  const now    = new Date();
  const pad    = n => String(n).padStart(2, '0');
  const stamp  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}` +
                 `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const logFile = fsPath.join(logDir, `server-${stamp}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  // Keep last 20 log files, delete older ones
  try {
    const files = fs.readdirSync(logDir)
      .filter(f => f.startsWith('server-') && f.endsWith('.log'))
      .sort();
    while (files.length > 20) {
      fs.unlinkSync(fsPath.join(logDir, files.shift()));
    }
  } catch {}

  // Tee every console method to the file with a timestamp prefix
  for (const method of ['log', 'warn', 'error']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => {
      orig(...args);
      const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
      logStream.write(line);
    };
  }

  console.log(`[log] Writing to ${logFile}`);
}
// ─────────────────────────────────────────────────────────────────────────────

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const mediasoup = require('mediasoup');
const { spawn } = require('child_process');
const path      = require('path');
const os        = require('os');

// ── Config ────────────────────────────────────────────────────────────────────
const PORT    = 3000;
const FPS     = 30;      // 30fps is smoother on iPhone Chrome/WebKit
const DISPLAY = 2;       // 1-based monitor index (2 = second monitor)

// VIDEO_CODEC options:
//   'libx264'  — SW H.264, ultrafast+zerolatency, ~1 CPU core, smoothest RTP output ← default
//   'h264_mf'  — Windows Media Foundation HW H.264, needs driver ≥ RS5, can burst at high FPS
const VIDEO_CODEC        = 'libx264';
const VIDEO_BITRATE_KBPS = 4000;   // 4 Mbps is enough for 720p30 on LAN

// Audio device for dshow capture (set to your actual device name or use wasapi loopback)
const AUDIO_DEVICE              = 'CABLE Output (VB-Audio Virtual Cable)';
const AUDIO_USE_WASAPI_LOOPBACK = false;
const SAMPLE_RATE = 48000;
const CHANNELS    = 2;

let STREAM_WIDTH  = 1280;  // 720p is the most reliable mobile Chrome baseline
let STREAM_HEIGHT = 720;

let WIDTH  = 1920;
let HEIGHT = 1080;
let monitorBounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
let serverMouseX  = WIDTH  / 2 | 0;
let serverMouseY  = HEIGHT / 2 | 0;

// ── robotjs ───────────────────────────────────────────────────────────────────
let robot;
try {
  robot = require('robotjs');
  robot.setMouseDelay(0);
  robot.setKeyboardDelay(0);
  console.log('[input] robotjs loaded');
} catch {
  console.warn('[input] robotjs not available — input events will be logged only');
}

const KEY_MAP = {
  ' ':'space','ArrowUp':'up','ArrowDown':'down','ArrowLeft':'left','ArrowRight':'right',
  'Enter':'enter','Escape':'escape','Backspace':'backspace','Tab':'tab',
  'Delete':'delete','Home':'home','End':'end','PageUp':'pageup','PageDown':'pagedown',
  'Control':'control','Shift':'shift','Alt':'alt','Meta':'command','CapsLock':'caps_lock',
  'F1':'f1','F2':'f2','F3':'f3','F4':'f4','F5':'f5','F6':'f6',
  'F7':'f7','F8':'f8','F9':'f9','F10':'f10','F11':'f11','F12':'f12',
};
const MOUSE_BUTTON = { 0:'left', 1:'middle', 2:'right' };
const pressedKeys  = new Set();

function handleInput(msg) {
  if (!robot) return;
  try {
    switch (msg.type) {
      case 'mousemove_abs': {
        serverMouseX = Math.round(monitorBounds.x + (msg.x / WIDTH)  * monitorBounds.width);
        serverMouseY = Math.round(monitorBounds.y + (msg.y / HEIGHT) * monitorBounds.height);
        robot.moveMouse(serverMouseX, serverMouseY);
        break;
      }
      case 'mousemove_rel': {
        serverMouseX = Math.max(monitorBounds.x,
          Math.min(monitorBounds.x + monitorBounds.width  - 1, serverMouseX + msg.dx));
        serverMouseY = Math.max(monitorBounds.y,
          Math.min(monitorBounds.y + monitorBounds.height - 1, serverMouseY + msg.dy));
        robot.moveMouse(serverMouseX, serverMouseY);
        break;
      }
      case 'mousedown': robot.mouseToggle('down', MOUSE_BUTTON[msg.button] ?? 'left'); break;
      case 'mouseup':   robot.mouseToggle('up',   MOUSE_BUTTON[msg.button] ?? 'left'); break;
      case 'wheel':     robot.scrollMouse(0, msg.deltaY > 0 ? 1 : -1); break;
      case 'keydown': {
        const k = KEY_MAP[msg.key] ?? (msg.key?.length === 1 ? msg.key.toLowerCase() : null);
        if (k) { pressedKeys.add(k); robot.keyToggle(k, 'down'); }
        break;
      }
      case 'keyup': {
        const k = KEY_MAP[msg.key] ?? (msg.key?.length === 1 ? msg.key.toLowerCase() : null);
        if (k) { pressedKeys.delete(k); robot.keyToggle(k, 'up'); }
        break;
      }
    }
  } catch {}
}

// ── FFmpeg process registry ───────────────────────────────────────────────────
const ffmpegProcs  = new Set();
let   shuttingDown = false;

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${sig} — shutting down`);
  try { wss.close(); }    catch {}
  try { server.close(); } catch {}
  ffmpegProcs.forEach(p => { try { p.kill('SIGKILL'); } catch {} });
  setTimeout(() => process.exit(0), 500);
}
['SIGINT','SIGTERM','SIGHUP'].forEach(s => process.on(s, () => shutdown(s)));
process.on('exit', () => ffmpegProcs.forEach(p => { try { p.kill('SIGKILL'); } catch {} }));

// ── Monitor bounds (PowerShell) ───────────────────────────────────────────────
function getMonitorBounds(displayIndex) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms;` +
      `$s=[System.Windows.Forms.Screen]::AllScreens[${displayIndex - 1}];` +
      `Write-Output "$($s.Bounds.X),$($s.Bounds.Y),$($s.Bounds.Width),$($s.Bounds.Height)"`,
    ]);
    let out = '';
    ps.stdout.on('data', d => { out += d; });
    ps.on('close', () => {
      const p = out.trim().split(',').map(Number);
      if (p.length !== 4 || p.some(isNaN)) reject(new Error(`Bad display index ${displayIndex}`));
      else resolve({ x: p[0], y: p[1], width: p[2], height: p[3] });
    });
    ps.on('error', reject);
  });
}

// ── mediasoup globals ─────────────────────────────────────────────────────────
let msWorker, msRouter;
let videoPlainTransport, audioPlainTransport;
let videoProducer,       audioProducer;
let msInfraPorts = { videoRtpPort: 0, audioRtpPort: 0 };

// profile-level-id '42e01f' = Constrained Baseline Profile, Level 3.1
// This is the most broadly compatible H264 profile for WebRTC.
// level-asymmetry-allowed:1 means Chrome can DECODE at higher levels even
// though Level 3.1 is negotiated — so libx264 can output at whatever level
// it chooses without causing a decode failure.
const MS_CODECS = [
  {
    kind:      'video',
    mimeType:  'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode':      1,
      'profile-level-id':        '42e01f',  // CBP Level 3.1 for 720p30
      'level-asymmetry-allowed': 1,
    },
  },
  {
    kind:      'audio',
    mimeType:  'audio/opus',
    clockRate: 48000,
    channels:  2,
  },
];

async function createMediasoupInfra() {
  msWorker = await mediasoup.createWorker({ logLevel: 'warn', rtcMinPort: 40000, rtcMaxPort: 49999 });
  msWorker.on('died', () => { console.error('[mediasoup] worker died'); process.exit(1); });

  msRouter = await msWorker.createRouter({ mediaCodecs: MS_CODECS });

  // ── Video PlainTransport: receives FFmpeg RTP on a loopback UDP port ──────
  // comedia=true  → mediasoup learns FFmpeg's source address from first packet.
  //                 Do NOT call connect() — comedia sets the remote address automatically.
  // rtcpMux=true  → RTCP multiplexed on the same port as RTP (one port total).
  videoPlainTransport = await msRouter.createPlainTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux:  true,
    comedia:  true,
  });
  const videoRtpPort = videoPlainTransport.tuple.localPort;
  console.log(`[mediasoup] video PlainTransport  127.0.0.1:${videoRtpPort}`);

  videoProducer = await videoPlainTransport.produce({
    kind: 'video',
    rtpParameters: {
      codecs: [{
        mimeType:    'video/H264',
        payloadType: 102,
        clockRate:   90000,
        parameters: {
          'packetization-mode':      1,
          'profile-level-id':        '42e01f',  // CBP Level 3.1; must match MS_CODECS above
          'level-asymmetry-allowed': 1,
        },
      }],
      encodings: [{ ssrc: 11111111 }],   // must match FFmpeg -ssrc 11111111
    },
  });
  videoProducer.on('score', s => console.log('[producer:video] score', JSON.stringify(s)));
  console.log(`[mediasoup] videoProducer id=${videoProducer.id}`);

  // ── Audio PlainTransport ──────────────────────────────────────────────────
  audioPlainTransport = await msRouter.createPlainTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux:  true,
    comedia:  true,
  });
  const audioRtpPort = audioPlainTransport.tuple.localPort;
  console.log(`[mediasoup] audio PlainTransport  127.0.0.1:${audioRtpPort}`);

  audioProducer = await audioPlainTransport.produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [{
        mimeType:    'audio/opus',
        payloadType: 111,
        clockRate:   48000,
        channels:    2,
        parameters:  { minptime: 10, useinbandfec: 1 },
      }],
      encodings: [{ ssrc: 22222222 }],
    },
  });
  audioProducer.on('score', s => console.log('[producer:audio] score', JSON.stringify(s)));

  msInfraPorts = { videoRtpPort, audioRtpPort };
}

// ── FFmpeg video capture ──────────────────────────────────────────────────────
function startVideoCapture(bounds, rtpPort) {
  const outputIdx = DISPLAY - 1;
  const scaleFilter = STREAM_WIDTH ? `,scale=${STREAM_WIDTH}:${STREAM_HEIGHT}` : '';

  // Common: ddagrab GPU capture → hwdownload to CPU → yuv420p → encode → RTP
  // We use -fflags nobuffer on input and -muxdelay 0 on output to keep
  // end-to-end latency minimal.
  //
  // libx264 ultrafast+zerolatency:
  //   - Encodes every frame immediately with no lookahead/B-frame delay
  //   - force-cfr=1 ensures perfectly evenly-spaced RTP timestamps
  //   - ~5ms/frame on any modern CPU → well under 33ms budget at 30fps
  //   - Profile Baseline / Level 3.1 matches router codec params
  //
  // h264_mf (Windows Media Foundation):
  //   - Wrap around DXVA2/D3D11 hardware encoder
  //   - Can burst if encoder is slower than capture rate → use 30fps max
  //   - -bf 0 + -flags +low_delay suppress reorder buffers

  let encodeArgs;
  if (VIDEO_CODEC === 'libx264') {
    const kf = Math.ceil(FPS / 3);   // keyframe every ~0.33 s
    encodeArgs = [
      '-vf',        `hwdownload,format=bgra${scaleFilter},format=yuv420p`,
      '-pix_fmt',   'yuv420p',
      '-c:v',       'libx264',
      '-preset',    'ultrafast',
      '-tune',      'zerolatency',
      '-profile:v', 'baseline',
      '-level:v',    '3.1',
      '-x264-params', `keyint=${kf}:min-keyint=${kf}:bframes=0:scenecut=0:repeat-headers=1`,
      '-b:v',       `${VIDEO_BITRATE_KBPS}k`,
      '-maxrate',   `${VIDEO_BITRATE_KBPS}k`,
      '-bufsize',   `${VIDEO_BITRATE_KBPS / 2}k`,
    ];
  } else {
    // h264_mf
    encodeArgs = [
      '-vf',      `hwdownload,format=bgra${scaleFilter},format=yuv420p`,
      '-pix_fmt', 'yuv420p',
      '-c:v',     'h264_mf',
      '-b:v',     `${VIDEO_BITRATE_KBPS}k`,
      '-maxrate', `${VIDEO_BITRATE_KBPS}k`,
      '-g',       String(Math.ceil(FPS / 3)),
      '-bf',      '0',
      '-flags',   '+low_delay',
    ];
  }

  const args = [
    '-fflags',          'nobuffer',          // don't pre-buffer capture frames
    '-init_hw_device',  'd3d11va=dxva',
    '-filter_hw_device','dxva',
    '-f',               'lavfi',
    '-i',               `ddagrab=output_idx=${outputIdx}:framerate=${FPS}:draw_mouse=1`,
    ...encodeArgs,
    '-an',                                   // no audio in this stream
    '-f',          'rtp',
    '-muxdelay',   '0',                      // send packets the instant encoder produces them
    '-muxpreload', '0',                      // (FFmpeg default muxdelay is 0.7 s — kills latency)
    '-ssrc',       '11111111',               // must match videoProducer encodings[0].ssrc
    '-payload_type','102',
    `rtp://127.0.0.1:${rtpPort}?pkt_size=1200`,
  ];

  console.log(`[capture] FFmpeg video → 127.0.0.1:${rtpPort}  codec=${VIDEO_CODEC} fps=${FPS}`);

  // -stats        → FFmpeg prints  "frame=N fps=XX speed=X.XXx"  every ~0.5s to stderr
  // -loglevel warning+stats  → keep warnings AND stats lines (stats are a separate class)
  const ff = spawn('ffmpeg', ['-loglevel', 'warning', '-stats', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  ffmpegProcs.add(ff);

  // FFmpeg writes stats as a single line ending with \r (no \n) so buffer across chunks
  let ffBuf = '';
  ff.stderr.on('data', d => {
    ffBuf += d.toString();
    // Process complete lines (\n) or stats lines (\r)
    const lines = ffBuf.split(/[\r\n]/);
    ffBuf = lines.pop();          // last incomplete fragment stays in buffer
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      // Stats line looks like: "frame=  300 fps= 30 q=28.0 size=N kB time=... speed=1.00x"
      // Parse the key numbers and reformat more readably
      const statsMatch = l.match(/frame=\s*(\d+).*fps=\s*([\d.]+).*speed=\s*([\d.]+)x/);
      if (statsMatch) {
        const [, frame, fps, speed] = statsMatch;
        const speedNum = parseFloat(speed);
        // Only log if speed is below 0.99 (falling behind) or every 5s summary
        const frameNum = parseInt(frame);
        if (speedNum < 0.99 || frameNum % 150 === 0) {
          const marker = speedNum < 0.95 ? ' ⚠ SLOW' : speedNum < 0.99 ? ' △ behind' : '';
          console.log(`[ffmpeg-v] frame=${frame} fps=${fps} speed=${speed}x${marker}`);
        }
      } else {
        // Warnings, errors, codec init messages
        console.error('[ffmpeg-v]', l);
      }
    }
  });
  ff.on('close', (code) => {
    ffmpegProcs.delete(ff);
    if (!shuttingDown) {
      console.warn(`[capture] FFmpeg video exited (${code}), restart in 2 s…`);
      setTimeout(() => startVideoCapture(bounds, rtpPort), 2000);
    }
  });
  ff.on('error', e => console.error('[capture] spawn error:', e.message));
}

// ── FFmpeg audio capture ──────────────────────────────────────────────────────
function startAudioCapture(rtpPort) {
  const inputArgs = AUDIO_USE_WASAPI_LOOPBACK
    ? ['-f', 'wasapi', '-loopback', '1', '-i', 'default']
    : ['-f', 'dshow', '-i', `audio=${AUDIO_DEVICE}`];

  const args = [
    ...inputArgs,
    '-c:a',           'libopus',
    '-b:a',           '128k',
    '-ac',            String(CHANNELS),
    '-ar',            String(SAMPLE_RATE),
    '-application',   'lowdelay',
    '-frame_duration','10',
    '-vn',
    '-f',          'rtp',
    '-muxdelay',   '0',
    '-muxpreload', '0',
    '-ssrc',       '22222222',
    '-payload_type','111',
    `rtp://127.0.0.1:${rtpPort}?pkt_size=1200`,
  ];

  console.log(`[audio] FFmpeg audio → 127.0.0.1:${rtpPort}`);
  const ff = spawn('ffmpeg', ['-loglevel', 'warning', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  ffmpegProcs.add(ff);
  ff.stderr.on('data', d => { const l = d.toString().trim(); if (l) console.error('[ffmpeg-a]', l); });
  ff.on('close', (code) => {
    ffmpegProcs.delete(ff);
    if (!shuttingDown && code !== 0)
      console.warn(`[audio] FFmpeg audio exited (${code}) — audio disabled`);
  });
  ff.on('error', e => console.error('[audio] spawn error:', e.message));
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const app    = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/nipplejs.js', (_, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/nipplejs/dist/index.js')));

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

let sessionCount = 0;

wss.on('connection', async (ws) => {
  const id = ++sessionCount;
  console.log(`\n[session ${id}] client connected`);

  let webRtcTransport, videoConsumer, audioConsumer;
  let consumerStatsInterval = null;

  // ── Step 1: tell client the stream dimensions ─────────────────────────────
  ws.send(JSON.stringify({ type: 'config', width: WIDTH, height: HEIGHT }));

  // ── Step 2: create a WebRtcTransport and send its parameters to client ────
  // The client uses these to create a RecvTransport (mirrored transport).
  // ICE/DTLS parameters are negotiated; once connected, mediasoup sends
  // consumer RTP to the browser via this transport.
  try {
    webRtcTransport = await msRouter.createWebRtcTransport({
      listenIps: [{ ip: '0.0.0.0', announcedIp: getLocalIp() }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
  } catch (err) {
    console.error(`[session ${id}] createWebRtcTransport error:`, err.message);
    ws.close();
    return;
  }

  ws.send(JSON.stringify({
    type:                  'transportParams',
    id:                    webRtcTransport.id,
    iceParameters:         webRtcTransport.iceParameters,
    iceCandidates:         webRtcTransport.iceCandidates,
    dtlsParameters:        webRtcTransport.dtlsParameters,
    routerRtpCapabilities: msRouter.rtpCapabilities,
  }));
  console.log(`[session ${id}] transportParams sent`);

  // ── Message handler ───────────────────────────────────────────────────────
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Step 3 ────────────────────────────────────────────────────────────
      // Client loaded its Device and sends its RTP capabilities.
      // We create consumers immediately (paused:false — active from the start).
      // The client will call transport.consume() next, which triggers ICE/DTLS.
      case 'rtpCapabilities': {
        try {
          videoConsumer = await webRtcTransport.consume({
            producerId:      videoProducer.id,
            rtpCapabilities: msg.rtpCapabilities,
            paused:          false,
          });
          audioConsumer = await webRtcTransport.consume({
            producerId:      audioProducer.id,
            rtpCapabilities: msg.rtpCapabilities,
            paused:          false,
          });

          videoConsumer.on('score', s =>
            console.log(`[consumer:video ${id}] score=${JSON.stringify(s)}`));

          // ── Per-session RTP stats every 5 s ──────────────────────────────
          // getStats() on the WebRtcTransport returns the same RTCStatsReport
          // the browser sees.  "outbound-rtp" here = what mediasoup is sending
          // to the browser (from the server's perspective).
          let prevVideoStats = null;
          consumerStatsInterval = setInterval(async () => {
            if (!videoConsumer || videoConsumer.closed) {
              clearInterval(consumerStatsInterval);
              return;
            }
            try {
              const stats = await videoConsumer.getStats();
              for (const s of stats.values()) {
                if (s.type === 'outbound-rtp') {
                  if (prevVideoStats) {
                    const dtSec      = (s.timestamp - prevVideoStats.timestamp) / 1000;
                    const dPackets   = (s.packetCount   ?? s.packetsSent   ?? 0) - (prevVideoStats.packetCount   ?? prevVideoStats.packetsSent   ?? 0);
                    const dBytes     = (s.byteCount     ?? s.bytesSent     ?? 0) - (prevVideoStats.byteCount     ?? prevVideoStats.bytesSent     ?? 0);
                    const dLost      = (s.packetsDiscarded ?? 0) - (prevVideoStats.packetsDiscarded ?? 0);
                    const fps        = (dPackets / dtSec).toFixed(1);   // packets/s ≈ fps for H264
                    const kbps       = ((dBytes * 8) / dtSec / 1000).toFixed(0);
                    console.log(
                      `[consumer:video ${id}] ${kbps} kbps  ~${fps} pkt/s` +
                      (dLost > 0 ? `  ⚠ discarded=${dLost}` : '')
                    );
                  }
                  prevVideoStats = s;
                }
              }
            } catch {}
          }, 5000);;

          ws.send(JSON.stringify({
            type: 'consume',
            videoConsumer: {
              id:            videoConsumer.id,
              producerId:    videoProducer.id,
              kind:          videoConsumer.kind,
              rtpParameters: videoConsumer.rtpParameters,
            },
            audioConsumer: {
              id:            audioConsumer.id,
              producerId:    audioProducer.id,
              kind:          audioConsumer.kind,
              rtpParameters: audioConsumer.rtpParameters,
            },
          }));
          console.log(`[session ${id}] consumers created, consume msg sent`);
        } catch (err) {
          console.error(`[session ${id}] consume error:`, err.message);
        }
        break;
      }

      // ── Step 4 ────────────────────────────────────────────────────────────
      // Client's transport.consume() triggered the 'connect' event which sent
      // us the DTLS fingerprint.  Complete the handshake on our side so the
      // browser can finish ICE+DTLS and start receiving RTP.
      case 'dtlsParameters': {
        try {
          await webRtcTransport.connect({ dtlsParameters: msg.dtlsParameters });
          console.log(`[session ${id}] WebRtcTransport DTLS connected`);
          // No 'connected' message needed — the client detects ICE+DTLS
          // completion via RTCPeerConnection connectionstatechange:'connected'
          // and resolves its pending callback there directly.
        } catch (err) {
          console.error(`[session ${id}] transport.connect error:`, err.message);
        }
        break;
      }

      // ── Step 5 ────────────────────────────────────────────────────────────
      // Client reports ICE+DTLS is up.  Request a keyframe so the browser
      // decoder gets an IDR immediately instead of waiting up to 0.33 s.
      case 'resumeConsumer': {
        // Consumers were created paused:false, so resume() is a no-op here.
        // The only reason to call it is as a safety net (e.g. after reconnect).
        await videoConsumer?.resume();
        await audioConsumer?.resume();
        console.log(`[session ${id}] resumeConsumer — requesting keyframe`);
        if (typeof videoConsumer?.requestKeyFrame === 'function') {
          videoConsumer.requestKeyFrame().catch(() => {});
        }
        break;
      }

      // ── On-demand keyframe (client sends when video stalls) ───────────────
      case 'requestKeyframe': {
        if (typeof videoConsumer?.requestKeyFrame === 'function') {
          videoConsumer.requestKeyFrame().catch(() => {});
          console.log(`[session ${id}] manual keyframe requested`);
        }
        break;
      }

      case 'probe': {
        ws.send(JSON.stringify({ type: 'probeAck', t: msg.t }));
        break;
      }

      default:
        handleInput(msg);
    }
  });

  ws.on('close', () => {
    console.log(`[session ${id}] client disconnected`);
    clearInterval(consumerStatsInterval);
    videoConsumer?.close();
    audioConsumer?.close();
    webRtcTransport?.close();
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getLocalIp() {
  const ifaces = Object.values(os.networkInterfaces()).flat();
  const lan    = ifaces.find(i => i.family === 'IPv4' && !i.internal);
  return lan?.address ?? '127.0.0.1';
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  const bounds = await getMonitorBounds(DISPLAY);
  WIDTH  = STREAM_WIDTH  ?? bounds.width;
  HEIGHT = STREAM_HEIGHT ?? bounds.height;
  monitorBounds = bounds;
  serverMouseX  = bounds.x + (bounds.width  / 2 | 0);
  serverMouseY  = bounds.y + (bounds.height / 2 | 0);
  console.log(`[capture] display ${DISPLAY}: ${bounds.width}×${bounds.height}  stream: ${WIDTH}×${HEIGHT}`);

  await createMediasoupInfra();
  console.log('[mediasoup] ready');

  const { videoRtpPort, audioRtpPort } = msInfraPorts;
  startVideoCapture(bounds, videoRtpPort);
  startAudioCapture(audioRtpPort);

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') console.error(`[server] port ${PORT} already in use`);
    else console.error('[server] error:', err.message);
    process.exit(1);
  });

  server.listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
    console.log('\n╔══════════════════════════════════╗');
    console.log('║   Game Stream Server Ready       ║');
    console.log('╚══════════════════════════════════╝');
    console.log(`  Local:   http://localhost:${PORT}`);
    ips.forEach(ip => console.log(`  LAN:     http://${ip}:${PORT}`));
    console.log('');
  });
})();
