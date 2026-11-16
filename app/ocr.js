// Screen reading: grabs the middle of the primary screen and runs Windows' built-in OCR on it.
// One PowerShell helper stays running so each scan is fast. Images never leave the PC.
const { app, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let ps = null, ready = false, failed = null, pending = null, buf = '', seq = 0;
const status = () => (failed ? 'error: ' + failed : ready ? 'ready' : ps ? 'starting' : 'off');
const tmpDir = () => path.join(app.getPath('temp'), 'aram-mayhem-overlay');

function start() {
  if (ps || failed) return;
  if (process.platform !== 'win32') { failed = 'screen reading needs Windows'; return; }
  try {
    // Copy the helper out of the app package so PowerShell can open it.
    const script = path.join(app.getPath('userData'), 'ocr.ps1');
    fs.writeFileSync(script, fs.readFileSync(path.join(__dirname, 'ocr.ps1')));
    fs.rmSync(tmpDir(), { recursive: true, force: true });
    fs.mkdirSync(tmpDir(), { recursive: true });
    ps = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  } catch (e) { failed = e.message; ps = null; return; }
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('READY')) ready = true;
      else if (line.startsWith('FAIL')) failed = line.slice(5);
      else if (pending && (line.startsWith('OCR ') || line.startsWith('ERR '))) {
        const p = pending; pending = null;
        clearTimeout(p.timer);
        fs.unlink(p.file, () => {});
        if (line.startsWith('OCR ')) { try { p.resolve(JSON.parse(line.slice(4)).lines || []); } catch { p.resolve([]); } }
        else p.resolve([]);
      }
    }
  });
  ps.on('error', e => { failed = e.message; });
  ps.on('exit', () => { ps = null; ready = false; if (pending) { pending.resolve([]); pending = null; } });
}
function stop() { if (ps) { try { ps.kill(); } catch { /* ignore */ } } ps = null; ready = false; }

function recognize(png) {
  return new Promise(resolve => {
    if (!ready || pending) return resolve(null);
    const file = path.join(tmpDir(), `scan-${++seq}.png`);
    try { fs.writeFileSync(file, png); } catch { return resolve(null); }
    pending = { resolve, file, timer: setTimeout(() => { if (pending && pending.file === file) { pending = null; resolve(null); } }, 6000) };
    ps.stdin.write(file + '\n');
  });
}

// Region of the primary screen where augment cards appear (fractions of the screen).
const REGION = { x: 0.08, y: 0.08, w: 0.84, h: 0.74 };

// Returns { lines, toScreen } where lines are in crop pixels and toScreen maps a box to screen DIPs.
async function scan(excludeDip) {
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  const full = { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full });
  const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  const size = src.thumbnail.getSize();
  const crop = { x: Math.round(size.width * REGION.x), y: Math.round(size.height * REGION.y), width: Math.round(size.width * REGION.w), height: Math.round(size.height * REGION.h) };
  const lines = await recognize(src.thumbnail.crop(crop).toPNG());
  if (!lines) return null;
  const k = size.width / d.size.width; // capture pixels per DIP
  const toDip = b => ({ x: (crop.x + b.x) / k, y: (crop.y + b.y) / k, w: b.w / k, h: b.h / k });
  // Ignore text that belongs to our own panel.
  const ex = excludeDip && { x: excludeDip.x - d.bounds.x, y: excludeDip.y - d.bounds.y, w: excludeDip.width, h: excludeDip.height };
  const kept = lines.filter(l => {
    if (!ex) return true;
    const c = toDip(l); const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    return !(cx >= ex.x && cx <= ex.x + ex.w && cy >= ex.y && cy <= ex.y + ex.h);
  });
  return { lines: kept, toDip, display: d };
}

module.exports = { start, stop, scan, status };
