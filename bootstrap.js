// Starter: checks GitHub for a newer version of the app code, downloads it, then runs it.
// The code in /app of the repo is what runs. Every file is checked against the SHA-256 in manifest.json.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'superxplodz/aram-mayhem-overlay';
const BASE = `https://raw.githubusercontent.com/${REPO}/main/app/`;

app.disableHardwareAcceleration(); // tiny UI: keep it off the GPU so the game has all of it
if (!app.requestSingleInstanceLock()) app.quit();

const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
  return 0;
};
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const validManifest = m => m && typeof m.version === 'string' && /^\d+\.\d+\.\d+$/.test(m.version) && m.files && Object.keys(m.files).length > 0
  && Object.entries(m.files).every(([f, h]) => /^[\w.-]+$/.test(f) && /^[a-f0-9]{64}$/.test(h)) && 'main.js' in m.files;

function newestLocal() {
  const bundledDir = path.join(__dirname, 'app');
  let best = { dir: bundledDir, version: require('./app/manifest.json').version };
  try {
    const root = path.join(app.getPath('userData'), 'updates');
    const cur = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
    const dir = path.join(root, cur.version);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (validManifest(m) && cmp(m.version, best.version) > 0 && Object.keys(m.files).every(f => fs.existsSync(path.join(dir, f)))) best = { dir, version: m.version };
  } catch { /* no update on disk */ }
  return best;
}

async function update(local) {
  const res = await withTimeout(net.fetch(BASE + 'manifest.json?t=' + Date.now(), { cache: 'no-store' }), 4000);
  if (!res.ok) return null;
  const m = await res.json();
  if (!validManifest(m) || cmp(m.version, local.version) <= 0) return null;
  const files = {};
  await withTimeout(Promise.all(Object.entries(m.files).map(async ([f, hash]) => {
    const r = await net.fetch(`${BASE}${f}?v=${m.version}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('download ' + f);
    const buf = Buffer.from(await r.arrayBuffer());
    if (crypto.createHash('sha256').update(buf).digest('hex') !== hash) throw new Error('checksum ' + f);
    files[f] = buf;
  })), 20000);
  const root = path.join(app.getPath('userData'), 'updates');
  const dir = path.join(root, m.version);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), buf);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  fs.writeFileSync(path.join(root, 'current.json'), JSON.stringify({ version: m.version }));
  // keep disk tidy: remove older downloaded versions
  for (const d of fs.readdirSync(root)) if (d !== m.version && d !== 'current.json') fs.rmSync(path.join(root, d), { recursive: true, force: true });
  return { dir, version: m.version };
}

app.whenReady().then(async () => {
  let run = newestLocal();
  if (!process.env.ARAM_NO_UPDATE) {
    try { const fresh = await update(run); if (fresh) { run = fresh; process.env.ARAM_UPDATED = '1'; } } catch { /* offline or GitHub down: run what we have */ }
  }
  process.env.ARAM_VERSION = run.version;
  try { require(path.join(run.dir, 'main.js')); }
  catch (e) {                                  // a bad update must never brick the app: fall back to the built-in copy
    if (run.dir === path.join(__dirname, 'app')) throw e;
    try { fs.rmSync(path.join(app.getPath('userData'), 'updates'), { recursive: true, force: true }); } catch { /* ignore */ }
    app.relaunch(); app.exit(0);
  }
});
