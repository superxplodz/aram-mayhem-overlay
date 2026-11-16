// ARAM Mayhem Overlay 3: one small panel, one key.
// Rules that keep the game smooth:
//  - In game the panel is hidden. One key shows it, the same key hides it.
//  - While hidden it draws nothing and reads nothing from the screen.
//  - The screen is read only while an augment pick is possible: a pick is due AND you are dead
//    (or the game just started). Grade badges appear above the cards, then everything stops.
const { app, BrowserWindow, ipcMain, globalShortcut, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const data = require('./data');
const ocr = require('./ocr');
const { matchOffer } = require('./match');
const situation = require('./situation');

// (hardware acceleration is switched off in bootstrap.js, before the app is ready)


// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = { v: 3, bounds: null, key: 'F9', badgeKey: 'F10', readCards: true, tab: 'augments' };
let settings = { ...defaults };
function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (s.v === 3) for (const k of Object.keys(defaults)) if (k in s) settings[k] = s[k];
  } catch { /* first run */ }
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch { /* ignore */ } }, 400);
}

// ---------- champions ----------
let champs = [];
const byKey = new Map(), byId = new Map();
async function loadChampions() {
  const g = await data.loadGlobal();
  if (g.champs.length) { champs = g.champs; champs.forEach(c => { byKey.set(c.key, c); byId.set(c.id.toLowerCase(), c); }); }
}

// ---------- local League APIs ----------
const insecure = new https.Agent({ rejectUnauthorized: false }); // League uses self-signed certs on 127.0.0.1
function getLocal(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: insecure, headers, timeout: 1500 }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const LIVE = 'https://127.0.0.1:2999/liveclientdata';
let myName = null;
// One small local request: my champion, level and whether I am dead.
const champOf = p => byId.get((p.rawChampionName || '').replace('game_character_displayname_', '').toLowerCase()) || champs.find(c => c.name === p.championName) || null;
// League only reveals an augment when it replaces a summoner spell: spot those by name.
function spellAugments(p) {
  const g = data.global(); if (!g || !g.augNames) return [];
  const out = [];
  for (const s of Object.values(p.summonerSpells || {})) {
    const n = data.norm(s && s.displayName);
    if (n && g.augNames.has(n) && !(g.spellNames && g.spellNames.has(n))) out.push(g.augNames.get(n));
  }
  return out;
}
async function liveMe() {
  if (process.env.ARAM_FAKE_LIVE) { const f = JSON.parse(fs.readFileSync(process.env.ARAM_FAKE_LIVE, 'utf8')); f.players.forEach(p => { p.champ = byId.get(p.id.toLowerCase()) || { id: p.id, name: p.id, tags: [], info: {} }; p.spellAugments = p.spellAugments || []; p.items = p.items || []; }); const me = f.players.find(p => p.me); return { champ: me.champ, level: f.level, dead: f.dead, team: me.team, items: me.items, players: f.players }; } // test hook
  if (!myName) myName = await getLocal(`${LIVE}/activeplayername`);
  const list = await getLocal(`${LIVE}/playerlist`);
  const p = list.find(x => x.riotId === myName || x.summonerName === myName);
  if (!p) return null;
  const champ = champOf(p);
  if (!champ) return null;
  const players = list.map(x => ({ champ: champOf(x), championName: x.championName, team: x.team, items: x.items || [], spellAugments: spellAugments(x), me: x === p }));
  return { champ, level: p.level || 0, dead: !!p.isDead, team: p.team, items: p.items || [], players };
}

let lcu = null, lcuLastLookup = 0;
function findLcuCredentials() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine";
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err || !out) return resolve(null);
      const port = /--app-port=(\d+)/.exec(out);
      const token = /--remoting-auth-token=([\w-]+)/.exec(out);
      resolve(port && token ? { port: port[1], token: token[1] } : null);
    });
  });
}
async function champSelect() {
  if (!lcu && Date.now() - lcuLastLookup > 15000) { lcuLastLookup = Date.now(); lcu = await findLcuCredentials(); }
  if (!lcu) return null;
  const auth = 'Basic ' + Buffer.from('riot:' + lcu.token).toString('base64');
  let s;
  try { s = await getLocal(`https://127.0.0.1:${lcu.port}/lol-champ-select/v1/session`, { Authorization: auth }); }
  catch (e) { if (!/HTTP 404/.test(e.message)) lcu = null; return null; }
  const mine = (s.myTeam || []).find(m => m.cellId === s.localPlayerCellId);
  const id = mine && (mine.championId || mine.championPickIntent);
  return id ? byKey.get(String(id)) || null : null;
}

// ---------- window ----------
let win, badgeWin = null;
let phase = 'idle';            // idle | select | game
let current = null, currentData = null, gameChamp = null, lastSelect = null;
let loadSeq = 0, scanning = false;
// augment pick tracking
const PICK_LEVELS = [3, 7, 11, 15];
let level = 0, dead = false, gameStart = 0, resolved = 0, offerSig = '', offerMiss = 0, lastScan = 0;
let userHid = false, lastHits = null, lastDisplay = null;   // badge key state
let taken = [], hoverId = null, hoverAt = 0;                 // augments I took this game
let live = null, situSig = '';                                // last live snapshot

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const state = () => ({ version: process.env.ARAM_VERSION || '', updated: process.env.ARAM_UPDATED || '', champion: current, phase, key: settings.key, badgeKey: settings.badgeKey, readCards: settings.readCards, tab: settings.tab, ocr: ocr.status() });
const pushState = () => send('state', state());

async function show(c) {
  if (!c) return;
  if (current && current.id === c.id && currentData) return;
  current = c; currentData = null;
  pushState();
  const seq = ++loadSeq;
  send('loading', c);
  let d;
  try { d = await data.championData(c); } catch (e) { d = { champ: c, errors: [e.message] }; }
  if (seq === loadSeq) { currentData = d; send('data', d); situSig = ''; if (taken.length) pushTaken(); }
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const b = settings.bounds || { width: 330, height: 640, x: wa.x + wa.width - 350, y: wa.y + Math.round((wa.height - 640) / 2) };
  win = new BrowserWindow({
    ...b, minWidth: 290, minHeight: 320, maxWidth: 520,
    frame: false, alwaysOnTop: true, show: false, backgroundColor: '#0d1117', title: 'ARAM Mayhem Overlay',
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  const remember = () => { settings.bounds = win.getBounds(); saveSettings(); };
  win.on('resize', remember);
  win.on('move', remember);
  win.webContents.once('did-finish-load', () => { pushState(); if (phase !== 'game') win.showInactive(); });
}

function reveal() { if (!win.isVisible()) win.showInactive(); win.setAlwaysOnTop(true, 'screen-saver'); pushState(); }
function toggle() {
  if (win.isVisible()) { win.hide(); return; }
  reveal();
}

// Badge key: pop the grade badges in or out on demand.
function toggleBadges() {
  if (badgeWin && !badgeWin.isDestroyed() && badgeWin.isVisible()) { userHid = true; hideBadges(); return; }
  userHid = false;
  if (lastHits && offerSig) showBadges(lastHits, lastDisplay);
  else { offerSig = ''; scanOnce(true); }
}
function registerKeys() {
  globalShortcut.unregisterAll();
  const ok = {};
  for (const [name, fn] of [['key', toggle], ['badgeKey', toggleBadges]]) {
    try { ok[name] = !!settings[name] && globalShortcut.register(settings[name], fn); } catch { ok[name] = false; }
  }
  return ok;
}

// ---------- augment cards: read them, grade them, badge them ----------
function candidates() {
  const r = currentData && currentData.rarities;
  if (!r) return [];
  const out = [];
  for (const [rarity, list] of Object.entries(r)) for (const a of list) out.push({ id: a.id, name: a.name, rarity, rank: a.rank, total: list.length, grade: a.grade, pickRate: a.pickRate, combo: a.combo, items: a.items, desc: a.desc });
  return out;
}

function showBadges(hits, display) {
  lastHits = hits; lastDisplay = display;
  if (userHid) return;
  const PAD = 190, H = 86;
  const minX = Math.min(...hits.map(h => h.screen.x)), maxX = Math.max(...hits.map(h => h.screen.x + h.screen.w));
  const top = Math.min(...hits.map(h => h.screen.y));
  const b = { x: Math.round(display.bounds.x + minX - PAD), y: Math.round(Math.max(display.bounds.y, display.bounds.y + top - H - 6)), width: Math.round(maxX - minX + PAD * 2), height: H };
  if (!badgeWin || badgeWin.isDestroyed()) {
    badgeWin = new BrowserWindow({ ...b, frame: false, transparent: true, resizable: false, movable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
    badgeWin.setIgnoreMouseEvents(true);
    badgeWin.setAlwaysOnTop(true, 'screen-saver');
    badgeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    badgeWin.loadFile(path.join(__dirname, 'badges.html'));
  } else badgeWin.setBounds(b);
  const list = hits.map(h => ({ x: Math.round(h.screen.x + h.screen.w / 2 - (minX - PAD)), grade: h.grade, pickRate: h.pickRate, best: h.best, rank: h.rank, total: h.total, label: h.label, kind: h.kind }));
  const go = () => { if (!badgeWin || badgeWin.isDestroyed()) return; badgeWin.webContents.send('badges', list); if (!badgeWin.isVisible()) badgeWin.showInactive(); };
  if (badgeWin.webContents.isLoading()) badgeWin.webContents.once('did-finish-load', go); else go();
}
function hideBadges() { if (badgeWin && !badgeWin.isDestroyed() && badgeWin.isVisible()) badgeWin.hide(); }
function clearOffer() { offerSig = ''; offerMiss = 0; userHid = false; lastHits = null; hoverId = null; hideBadges(); send('offer', { status: 'idle', list: [] }); }

async function scanOnce(manual) {
  if (scanning || !settings.readCards) return;
  const cands = candidates();
  if (!cands.length) return;
  scanning = true; lastScan = Date.now();
  if (manual) send('offer', { status: 'reading', list: [] });
  try {
    let res;
    if (process.env.ARAM_FAKE_LINES) res = { lines: JSON.parse(fs.readFileSync(process.env.ARAM_FAKE_LINES, 'utf8')), toDip: b => b, display: screen.getPrimaryDisplay() };
    else { ocr.start(); res = await ocr.scan(win.isVisible() ? win.getBounds() : null); }
    const hits = res ? matchOffer(res.lines, cands) : [];
    if (hits.length) {
      // Known combos for this champion move a card up; known traps can never be the best pick.
      const BONUS = { god: -0.4, strong: -0.2, blackTech: -0.05, entertainment: 0, bug: 0.2, trap: 1 };
      hits.forEach(describe);
      const score = h => h.rank / h.total + (h.combo ? BONUS[h.combo.type] || 0 : 0) + (h.completes ? -0.3 : 0);
      const best = [...hits].sort((a, b) => score(a) - score(b))[0];
      hits.forEach(h => { h.best = h.id === best.id; h.screen = res.toDip(h.box); });
      offerMiss = 0;
      const sig = hits.map(h => h.id + '@' + Math.round(h.screen.x / 8)).join(',');
      if (sig !== offerSig) {
        offerSig = sig;
        showBadges(hits, res.display);
        send('offer', { status: 'found', list: hits.map(({ id, name, rarity, rank, total, grade, best, combo, label, kind }) => ({ id, name, rarity, rank, total, grade, best, combo, label, kind })) });
      }
    } else if (offerSig) {
      if (++offerMiss >= 2) {                                    // cards gone: the pick is done
        resolved++;
        if (hoverId && Date.now() - hoverAt < 8000) addTaken(hoverId);   // the card the mouse was on when they closed
        clearOffer();
      }
    } else if (manual) send('offer', { status: res ? 'none' : (/^error/.test(ocr.status()) ? 'error' : 'none'), list: [] });
  } catch { /* try again next tick */ } finally { scanning = false; }
}

// ---------- what I have taken, and what that means for each card ----------
function findAug(id) { const r = currentData && currentData.rarities; if (!r) return null; for (const l of Object.values(r)) { const a = l.find(x => x.id === id); if (a) return a; } return null; }
function findAugByName(name) { const r = currentData && currentData.rarities; if (!r) return null; const k = data.norm(name); for (const l of Object.values(r)) { const a = l.find(x => data.norm(x.name) === k); if (a) return a; } return null; }
const pushTaken = () => { send('taken', taken.map(a => ({ id: a.id, name: a.name, img: a.img, grade: a.grade }))); situSig = ''; };
function addTaken(id) { const a = findAug(id); if (a && !taken.some(t => t.id === id)) { taken.push(a); pushTaken(); } }
function toggleTaken(id) { if (taken.some(t => t.id === id)) { taken = taken.filter(t => t.id !== id); pushTaken(); } else addTaken(id); }

const COMBO = { god: 'God combo', strong: 'Strong combo', blackTech: 'Niche tech', entertainment: 'Fun build', bug: 'Bugged', trap: 'Trap', combo: 'Combo' };
// One specific line per card: which combo, what it still needs, which item, and whether you have it.
function describe(h) {
  h.label = null; h.kind = null; h.completes = false;
  const have = new Set(taken.map(t => data.norm(t.name)));
  if (h.combo) {
    const T = COMBO[h.combo.type] || 'Combo';
    const got = h.combo.with.filter(n => have.has(data.norm(n))), need = h.combo.with.filter(n => !have.has(data.norm(n)));
    h.kind = h.combo.type;
    if (!h.combo.with.length) h.label = `${T} on ${current ? current.name : 'this champion'}`;
    else if (!need.length) { h.label = `Completes ${T}: you have ${got.join(' + ')}`; h.completes = h.combo.type !== 'trap' && h.combo.type !== 'bug'; }
    else if (got.length) h.label = `${T}: have ${got.join(' + ')}, still needs ${need.join(' + ')}`;
    else h.label = `${T}: also needs ${need.join(' + ')}`;
  } else if (h.items && h.items.length) {
    const it = h.items[0];
    const owned = live && live.items.some(i => String(i.itemID) === String(it.id));
    const b = currentData && currentData.build;
    const planned = b && [...((b.core && b.core.items) || []), ...(b.options || []).flat()].some(i => String(i.id) === String(it.id));
    h.kind = 'item';
    h.label = `Needs ${it.name}` + (owned ? ': you have it' : planned ? ': in your build' : ': not in your usual build');
  }
}
function trackCursor() {
  if (!offerSig || !lastHits || !lastDisplay) return;
  const pt = screen.getCursorScreenPoint();
  const x = pt.x - lastDisplay.bounds.x, y = pt.y - lastDisplay.bounds.y;
  const centers = lastHits.map(h => h.screen.x + h.screen.w / 2);
  const gaps = centers.slice(1).map((c, i) => c - centers[i]);
  const half = (gaps.length ? Math.min(...gaps) : 320) / 2;
  const top = Math.min(...lastHits.map(h => h.screen.y)) - 80;
  const i = centers.findIndex(c => Math.abs(x - c) < half);
  if (i >= 0 && y > top) { hoverId = lastHits[i].id; hoverAt = Date.now(); }
}

// ---------- build advice for this game (enemy team, my team, my augments) ----------
function updateSituation() {
  if (!live || !currentData || !currentData.build) return;
  const sig = live.players.map(p => (p.champ ? p.champ.id : '?') + ':' + p.items.map(i => i.itemID).join('.') + ':' + p.spellAugments.join('.')).join('|') + '#' + taken.map(t => t.id).join(',');
  if (sig === situSig) return;                 // nothing changed: do nothing
  situSig = sig;
  for (const p of live.players) if (p.me) for (const n of p.spellAugments) { const a = findAugByName(n); if (a && !taken.some(t => t.id === a.id)) { taken.push(a); send('taken', taken.map(t => ({ id: t.id, name: t.name, img: t.img, grade: t.grade }))); } }
  try {
    send('situation', situation.analyze(data.global(), { champ: live.champ, players: live.players, myTeam: live.team, myItems: live.items, build: currentData.build, taken, itemInfo: id => data.itemInfo(data.global(), id) }));
  } catch { /* advice is optional */ }
}

// Picks can only be made while dead (or at the very start), so that is the only time we look.
function wantScan() {
  if (phase !== 'game' || !settings.readCards) return false;
  if (offerSig) return true;                                     // cards are up: follow rerolls, notice when they close
  const due = PICK_LEVELS.filter(l => l <= level).length;
  if (due <= resolved) return false;
  return dead || (resolved === 0 && Date.now() - gameStart < 150000);
}
function scanLoop() {
  trackCursor();
  if (wantScan() && Date.now() - lastScan >= 1100) scanOnce(false);
  setTimeout(scanLoop, 400);
}

// ---------- detection loop ----------
function setPhase(next) {
  if (process.env.ARAM_TEST_PHASE) next = process.env.ARAM_TEST_PHASE; // test hook
  if (next === phase) return;
  const prev = phase; phase = next;
  if (next === 'game') {
    win.hide();                                   // out of the way the moment the game starts
    gameStart = Date.now(); resolved = 0;
    if (settings.readCards) ocr.start();
  }
  if (prev === 'game') { gameChamp = null; myName = null; level = 0; dead = false; live = null; situSig = ''; clearOffer(); ocr.stop(); send('situation', null); }
  if (next === 'game') { taken = []; pushTaken(); }
  pushState();
}

async function poll() {
  let next = 'idle', delay = 3000;
  try {
    const me = await liveMe();
    if (me) {
      if (!gameChamp) {                            // first sight of this game
        gameChamp = me.champ;
        try { const gs = await getLocal(`${LIVE}/gamestats`); if (gs && gs.gameTime > 150) { gameStart = Date.now() - gs.gameTime * 1000; } } catch { /* ignore */ }
      }
      level = me.level; dead = me.dead; live = me;
      next = 'game'; delay = 1500;
    }
  } catch { gameChamp = null; myName = null; }

  if (next !== 'game') {
    let c = null;
    try { c = await champSelect(); } catch { /* not in champ select */ }
    if (c) {
      next = 'select'; delay = 2000;
      if (c.id !== lastSelect) { lastSelect = c.id; show(c); reveal(); }
    } else lastSelect = null;
  }
  setPhase(next);
  if (next === 'game' && gameChamp && (!current || current.id !== gameChamp.id)) show(gameChamp);
  if (next === 'game') updateSituation();
  setTimeout(poll, delay);
}

// ---------- IPC ----------
ipcMain.handle('champions', () => champs);
ipcMain.on('pick', (_e, query) => {
  const q = String(query || '').trim().toLowerCase();
  const c = champs.find(x => x.name.toLowerCase() === q || x.id.toLowerCase() === q) || champs.find(x => x.name.toLowerCase().startsWith(q));
  if (c) show(c);
});
ipcMain.on('tab', (_e, t) => { settings.tab = t === 'items' ? 'items' : 'augments'; saveSettings(); pushState(); });
ipcMain.on('keys-pause', () => globalShortcut.unregisterAll());   // while the user is choosing a new key
ipcMain.on('set-key', (_e, which, accel) => {
  const name = which === 'badgeKey' ? 'badgeKey' : 'key';
  const other = name === 'key' ? 'badgeKey' : 'key';
  const old = settings[name];
  if (accel && accel !== settings[other]) {
    settings[name] = accel;
    if (!registerKeys()[name]) { settings[name] = old; send('key-error', accel); }   // taken by another program
  }
  registerKeys(); saveSettings(); pushState();
});
ipcMain.on('read-cards-toggle', () => { settings.readCards = !settings.readCards; saveSettings(); if (!settings.readCards) { clearOffer(); ocr.stop(); } pushState(); });
ipcMain.on('taken-toggle', (_e, id) => toggleTaken(id));
ipcMain.on('read-cards', () => { offerSig = ''; scanOnce(true); });
ipcMain.on('hide', () => win.hide());
ipcMain.on('quit', () => { if (badgeWin && !badgeWin.isDestroyed()) badgeWin.destroy(); app.quit(); });

// ---------- app ----------
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) reveal(); });

app.whenReady().then(async () => {
  loadSettings();
  createWindow();
  registerKeys();
  await loadChampions();
  pushState();
  const retry = setInterval(async () => { if (champs.length) return clearInterval(retry); await loadChampions(); pushState(); }, 20000);
  poll();
  scanLoop();
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); ocr.stop(); });
app.on('window-all-closed', () => app.quit());
app.on('browser-window-created', (_e, w) => w.on('closed', () => { if (w === win && badgeWin && !badgeWin.isDestroyed()) badgeWin.destroy(); }));
