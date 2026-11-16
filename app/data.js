// Data layer: pulls ARAM Mayhem stats as JSON (no web pages) and caches them on disk.
//  - U.GG static data files: per-champion augment rankings, augment names/tooltips/icons, ARAM item builds
//  - arammayhem.com open data (CC BY 4.0): augment pick rates and champion augment combos
//  - Riot Data Dragon: champion, item and summoner spell names + icons
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');

const BB = 'https://static.bigbrain.gg';
const UGG_STATS = 'https://stats2.u.gg/lol/1.5';
const AM = 'https://arammayhem.com/data/v1/latest';
const DD = 'https://ddragon.leagueoflegends.com';

const HOUR = 3600 * 1000;
const cacheDir = () => path.join(app.getPath('userData'), 'cache');
const cacheFile = url => path.join(cacheDir(), url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_'));

// Test hook: ARAM_FIXTURES=<folder> serves <folder>/<file name of url> instead of the network.
const FIX = process.env.ARAM_FIXTURES;

async function getJson(url, maxAgeH = 6) {
  if (FIX) {
    const f = path.join(FIX, path.basename(new URL(url).pathname));
    if (!fs.existsSync(f)) throw new Error('no fixture ' + f);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const file = cacheFile(url);
  let cached = null, age = Infinity;
  try { age = Date.now() - fs.statSync(file).mtimeMs; cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no cache */ }
  if (cached && age < maxAgeH * HOUR) return cached;
  try {
    const res = await net.fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(file, JSON.stringify(json)); } catch { /* ignore */ }
    return json;
  } catch (e) {
    if (cached) return cached; // offline or site down: use the last good copy
    throw e;
  }
}
const safe = async (p, fallback) => { try { return await p; } catch { return fallback; } };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cleanTip(t) {
  return String(t || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/%i:[a-zA-Z]+%/g, '')
    .replace(/@[^@]*@/g, '?')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let G = null; // global data, loaded once

async function loadGlobal() {
  if (G) return G;
  const g = { champs: [], errors: [] };

  // Riot Data Dragon
  try {
    const versions = await getJson(`${DD}/api/versions.json`, 6);
    g.dd = versions[0];
    const [c, i, s] = await Promise.all([
      getJson(`${DD}/cdn/${g.dd}/data/en_US/champion.json`, 24),
      safe(getJson(`${DD}/cdn/${g.dd}/data/en_US/item.json`, 24), { data: {} }),
      safe(getJson(`${DD}/cdn/${g.dd}/data/en_US/summoner.json`, 24), { data: {} })
    ]);
    g.champs = Object.values(c.data).map(x => ({ id: x.id, key: x.key, name: x.name, tags: x.tags || [], info: x.info || {} }))
      .sort((a, b) => a.name.localeCompare(b.name));
    g.items = i.data;
    g.spells = {};
    g.spellNames = new Set(Object.values(s.data).map(sp => norm(sp.name)));
    for (const sp of Object.values(s.data)) g.spells[sp.key] = { name: sp.name, img: `${DD}/cdn/${g.dd}/img/spell/${sp.image.full}` };
  } catch (e) { g.errors.push('Riot Data Dragon: ' + e.message); }

  // U.GG: newest patch that has Mayhem files
  try {
    const patches = await getJson(`${BB}/assets/lol/riot_patch_update/prod/ugg/patches.json`, 6);
    for (const p of patches.slice(0, 4)) {
      const manifest = await safe(getJson(`${BB}/custom-aram-mayhem/${p}/aram-mayhem-augment-manifest-${p}.json`, 24), null);
      if (manifest) { g.patch = p; g.manifest = manifest; break; }
    }
    if (!g.patch) throw new Error('no Mayhem data for recent patches');
    g.tips = await safe(getJson(`${BB}/custom-aram-mayhem/${g.patch}/augment-tooltips-${g.patch}.json`, 24), {});
    g.augNames = new Map(); // normalised Mayhem augment name -> display name
    for (const id of Object.keys(g.tips)) if (g.manifest[id]) g.augNames.set(norm(g.manifest[id]), g.manifest[id]);
    const tiers = await safe(getJson(`${BB}/custom-aram-mayhem/${g.patch}/tierlist-champions-${g.patch}.json`, 12), null);
    g.champTier = {};
    if (tiers && tiers.tiers) for (const [t, ids] of Object.entries(tiers.tiers)) ids.forEach(id => (g.champTier[id] = t));
  } catch (e) { g.errors.push('U.GG: ' + e.message); }

  // arammayhem.com open data (CC BY 4.0)
  g.pick = {};      // normalised augment name -> { pickRate, rank, change, presence }
  g.combos = {};    // champion id (lower case) -> [{ augments: [names], types: [] }]
  try {
    const a = await getJson(`${AM}/augments.json`, 12);
    const nameById = {};
    for (const r of a.rows || []) {
      if (r.retiredPatch) continue;
      nameById[r.augmentId] = r.name;
      g.pick[norm(r.name)] = { pickRate: r.pickRate, rank: r.pickRateRank, change: r.pickRateChange, presence: r.presence };
    }
    g.pickPatch = a.meta && a.meta.patch;
    const c = await safe(getJson(`${AM}/combos.json`, 24), { rows: [] });
    for (const r of c.rows || []) {
      const k = String(r.championId || '').toLowerCase();
      const en = (r.augmentNames || []).map(n => (n && (n.en || n)) || '');
      const names = (r.augmentIds || []).map((id, i) => nameById[id] || (typeof en[i] === 'string' && en[i]) || id);
      if (!names.length) continue;
      (g.combos[k] = g.combos[k] || []).push({ augments: names, types: r.types || [], url: r.url || '' });
    }
  } catch (e) { g.errors.push('arammayhem.com: ' + e.message); }

  if (g.champs.length || g.manifest) G = g; // keep only if something loaded, so we retry otherwise
  return g;
}

// Which shop items does an augment call for? Read from its name ("Upgrade Collector") and its text.
function itemsFor(g, name, desc) {
  if (!g.itemNames) {
    g.itemNames = [];
    const seen = new Set();
    for (const [id, it] of Object.entries(g.items || {})) {
      const n = it && it.name;
      if (!n || n.length < 6 || seen.has(n) || /<|Elixir|Potion|Ward|Boots$/.test(n)) continue;
      seen.add(n); g.itemNames.push({ id, name: n, low: n.toLowerCase(), short: n.toLowerCase().replace(/^the /, '').replace(/'s .*$/, '') });
    }
  }
  const out = new Map();
  const text = String(desc || '').toLowerCase();
  const up = /^upgrade:?\s+(.+)$/i.exec(name || '');
  const key = up ? up[1].toLowerCase().replace(/[^a-z ]/g, '').trim() : null;
  for (const it of g.itemNames) {
    const plain = it.low.replace(/[^a-z ]/g, '');
    if ((key && key.length >= 5 && plain.split(' ').some(w => w === key || (w.length >= 5 && (w.startsWith(key) || key.startsWith(w))))) || text.includes(it.low)) out.set(it.name, itemInfo(g, it.id));
  }
  return [...out.values()].slice(0, 2);
}

function itemInfo(g, id) {
  let k = String(id);
  if (!g.items || !g.items[k]) { if (k.length > 4 && g.items && g.items[k.slice(-4)]) k = k.slice(-4); }
  const it = g.items && g.items[k];
  return { id: k, name: it ? it.name : 'Item ' + id, img: g.dd ? `${DD}/cdn/${g.dd}/img/item/${k}.png` : '' };
}
const wr = (wins, games) => (games ? Math.round((wins / games) * 1000) / 10 : null);

function parseBuild(g, ov) {
  if (!ov) return null;
  const region = ov['12'] || Object.values(ov)[0]; // 12 = World
  if (!region) return null;
  const rank = Object.values(region)[0]; if (!rank) return null;
  const role = Object.values(rank)[0]; if (!role) return null;
  const d = role[0]; if (!Array.isArray(d)) return null;
  const set = x => (Array.isArray(x) && Array.isArray(x[2]) ? { games: x[0], wr: wr(x[1], x[0]), items: x[2].map(id => itemInfo(g, id)) } : null);
  const opts = arr => (Array.isArray(arr) ? arr.map(o => ({ ...itemInfo(g, o[0]), wr: wr(o[1], o[2]), games: o[2] })) : []);
  const b = {
    winRate: Array.isArray(d[6]) ? wr(d[6][0], d[6][1]) : null,
    games: Array.isArray(d[6]) ? d[6][1] : null,
    spells: Array.isArray(d[1]) && Array.isArray(d[1][2]) ? d[1][2].map(id => (g.spells && g.spells[id]) || { name: 'Spell ' + id, img: '' }) : [],
    start: set(d[2]),
    core: set(d[3]),
    skillOrder: Array.isArray(d[4]) ? d[4][2] : [],
    skillPriority: Array.isArray(d[4]) ? d[4][3] : '',
    options: Array.isArray(d[5]) ? d[5].slice(0, 3).map(opts) : [],
    updated: role[1] || null
  };
  return b;
}

async function championData(champ) {
  const g = await loadGlobal();
  const out = { champ, patch: g.patch || null, tier: null, rarities: null, build: null, combos: [], errors: [...g.errors], pickPatch: g.pickPatch || null };
  if (!champ) return out;
  out.champImg = g.dd && champ.key ? `${DD}/cdn/${g.dd}/img/champion/${champ.id}.png` : '';
  out.combos = g.combos[String(champ.id).toLowerCase()] || g.combos[String(champ.key)] || g.combos[norm(champ.name)] || [];
  if (g.patch && champ.key) {
    out.tier = (g.champTier && g.champTier[champ.key]) || null;
    const p = g.patch;
    const [aug, ov] = await Promise.all([
      safe(getJson(`${BB}/custom-aram-mayhem/${p}/tierlist-per-champion-augments-rarity-${p}/tierlist-augments-${champ.key}-${p}.json`, 6), null),
      safe(getJson(`${UGG_STATS}/overview/${p}/normal_aram/${champ.key}/1.5.0.json`, 6), null)
    ]);
    if (aug && aug.rarities) {
      const ORDER = ['god', 'strong', 'blackTech', 'entertainment', 'bug', 'trap'];
      const comboNames = new Map(); // augment -> its most notable combo on this champion
      for (const c of out.combos) for (const n of c.augments) {
        const type = ORDER.find(t => c.types.includes(t)) || 'combo';
        const prev = comboNames.get(norm(n));
        if (!prev || ORDER.indexOf(type) < ORDER.indexOf(prev.type)) comboNames.set(norm(n), { type, with: c.augments.filter(x => norm(x) !== norm(n)) });
      }
      const list = ids => (ids || []).map((id, i) => {
        const name = g.manifest[id] || 'Augment ' + id;
        const tip = g.tips && g.tips[id];
        const pk = g.pick[norm(name)];
        const pct = i / Math.max(1, ids.length);
        const grade = pct < 0.12 ? 'S' : pct < 0.35 ? 'A' : pct < 0.65 ? 'B' : pct < 0.85 ? 'C' : 'D';
        const desc0 = cleanTip(Array.isArray(tip) ? tip[0] : tip);
        return {
          id, name, rank: i + 1, grade, items: itemsFor(g, name, desc0),
          img: `${BB}/cdragon-custom/${p}/augments/${id}.webp`,
          desc: cleanTip(Array.isArray(tip) ? tip[0] : tip),
          pickRate: pk ? pk.pickRate : null,
          isNew: pk ? pk.presence === 'new' : false,
          combo: comboNames.get(norm(name)) || null
        };
      });
      out.rarities = { prismatic: list(aug.rarities.kPrismatic), gold: list(aug.rarities.kGold), silver: list(aug.rarities.kSilver) };
      out.augUpdated = aug.lastUpdated || null;
    } else if (g.patch) out.errors.push('No augment ranking for this champion yet');
    out.build = parseBuild(g, ov);
  }
  return out;
}

module.exports = { loadGlobal, championData, itemInfo, norm, global: () => G };
