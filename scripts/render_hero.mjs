import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(import.meta.dirname, '..');
const HTML_PATH = path.join(ROOT, 'scripts', 'hero-animation.html');
const FRAMES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-frames-'));
const OUT_WEBP = path.join(ROOT, 'assets', 'readme', 'hero.webp');
const OUT_GIF = path.join(ROOT, 'assets', 'readme', 'hero.gif');

const TOTAL_FRAMES = 48; // 3.2s @ 15fps seamless loop
const FPS = 15;
const PORT = 9222 + Math.floor(Math.random() * 500);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForDebugger(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('Timed out waiting for Chrome DevTools endpoint');
}

function createCDP(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();

    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });

    ws.addEventListener('error', reject);
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', ...args], { stdio: 'inherit' });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cdp-'));
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=960,320',
      '--hide-scrollbars',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    const wsUrl = await waitForDebugger(PORT);
    const cdp = await createCDP(wsUrl);

    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 960,
      height: 320,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });

    await cdp.send('Page.navigate', { url: `file://${HTML_PATH}` });
    await sleep(600);

    await cdp.send('Runtime.evaluate', {
      expression: 'window.__MANUAL_RENDER__ = true;',
    });

    console.log(`Rendering ${TOTAL_FRAMES} frames...`);
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      const t = i / TOTAL_FRAMES;
      await cdp.send('Runtime.evaluate', {
        expression: `window.render(${t.toFixed(6)});`,
      });
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        omitBackground: true,
      });
      const framePath = path.join(FRAMES_DIR, `frame_${String(i).padStart(4, '0')}.png`);
      fs.writeFileSync(framePath, Buffer.from(data, 'base64'));
    }

    cdp.close();
    console.log('Encoding high-quality looping GIF...');
    const palettePath = path.join(FRAMES_DIR, 'palette.png');
    await runFfmpeg([
      '-framerate', String(FPS),
      '-i', path.join(FRAMES_DIR, 'frame_%04d.png'),
      '-vf', 'palettegen=max_colors=160:reserve_transparent=1:stats_mode=diff',
      palettePath,
    ]);
    await runFfmpeg([
      '-framerate', String(FPS),
      '-i', path.join(FRAMES_DIR, 'frame_%04d.png'),
      '-i', palettePath,
      '-lavfi', 'paletteuse=dither=none:diff_mode=rectangle',
      '-loop', '0',
      OUT_GIF,
    ]);

    const gifSize = (fs.statSync(OUT_GIF).size / 1024).toFixed(1);
    console.log(`Done! ${OUT_GIF} (${gifSize} KB)`);

    // Save 3 keyframes for visual inspection
    const inspectDir = path.join(os.tmpdir(), 'hero-inspect');
    fs.mkdirSync(inspectDir, { recursive: true });
    for (const idx of [0, 16, 32]) {
      fs.copyFileSync(
        path.join(FRAMES_DIR, `frame_${String(idx).padStart(4, '0')}.png`),
        path.join(inspectDir, `keyframe_${idx}.png`)
      );
    }
    console.log(`Keyframes saved to ${inspectDir}`);
  } finally {
    chrome.kill('SIGKILL');
    fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
