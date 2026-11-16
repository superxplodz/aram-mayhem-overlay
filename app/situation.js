// "What should I build THIS game?"  Pure functions, no I/O, cheap to run.
// Inputs come from League's local Live Client API (all ten players' champions and items),
// the champion's usual build (U.GG) and the augments the player has taken.
// The rules below are plain League itemisation heuristics, not statistics.

const HEALERS = new Set(['Soraka', 'Yuumi', 'Sona', 'Nami', 'Aatrox', 'Vladimir', 'Swain', 'Warwick', 'DrMundo', 'Sylas', 'Fiddlesticks', 'Briar', 'Olaf', 'Illaoi', 'Zac', 'Seraphine', 'Senna', 'Renata', 'Kayn', 'Darius', 'Nasus', 'Trundle', 'Maokai', 'Volibear', 'Belveth', 'Viego', 'Samira', 'Irelia', 'Fiora', 'RedKayn', 'Milio', 'Taric', 'Rakan', 'Ivern']);
const SHIELDERS = new Set(['Karma', 'Lulu', 'Janna', 'Ivern', 'Seraphine', 'Sona', 'Orianna', 'Milio', 'Renata', 'Rakan', 'Lux', 'Morgana', 'Shen', 'Taric', 'Sett', 'Riven', 'Mordekaiser', 'Diana']);

const has = (it, tag) => !!(it && Array.isArray(it.tags) && it.tags.includes(tag));
const completed = it => !!it && it.gold && it.gold.total >= 2200;

function profile(g, p) {
  const c = p.champ || {};
  const tags = c.tags || [];
  const items = (p.items || []).map(i => g.items && g.items[String(i.itemID)]).filter(Boolean);
  let ap = 0, ad = 0, tanky = 0, crit = 0;
  for (const it of items) {
    if (!completed(it)) continue;
    if (has(it, 'SpellDamage')) ap++;
    if (has(it, 'Damage') || has(it, 'AttackSpeed')) ad++;
    if (has(it, 'CriticalStrike')) crit++;
    if (has(it, 'Health') && (has(it, 'Armor') || has(it, 'SpellBlock'))) tanky++;
  }
  // Until real items say otherwise, go by the champion's usual profile.
  const info = c.info || {};
  const magic = ap + ad > 0 ? ap > ad : (info.magic || 0) > (info.attack || 0);
  return {
    id: c.id, name: c.name || p.championName,
    magic, physical: !magic,
    tank: tanky >= 2 || (tanky + ap + ad === 0 && tags[0] === 'Tank'),
    crit: crit >= 1 || (ap + ad === 0 && tags[0] === 'Marksman'),
    healer: HEALERS.has(c.id), shielder: SHIELDERS.has(c.id)
  };
}

function myClass(g, champ, build) {
  const tags = (champ && champ.tags) || [];
  const core = ((build && build.core && build.core.items) || []).map(i => g.items && g.items[i.id]).filter(Boolean);
  const ap = core.filter(i => has(i, 'SpellDamage')).length, tank = core.filter(i => has(i, 'Health') && (has(i, 'Armor') || has(i, 'SpellBlock'))).length;
  const crit = core.filter(i => has(i, 'CriticalStrike')).length;
  if (tank >= 2 || (core.length === 0 && tags[0] === 'Tank')) return 'tank';
  if (ap >= 2 || (core.length === 0 && tags[0] === 'Mage')) return 'ap';
  if (crit >= 1 || tags[0] === 'Marksman') return 'adc';
  return 'ad';
}

// Fallback items per need and class, by name (looked up in Data Dragon, skipped if not found).
const PICKS = {
  antiheal: { ap: ['Morellonomicon'], adc: ['Mortal Reminder'], ad: ['Chempunk Chainsword', 'Mortal Reminder'], tank: ['Thornmail'] },
  armor: { ap: ["Zhonya's Hourglass"], adc: ['Guardian Angel', "Death's Dance"], ad: ["Death's Dance", 'Guardian Angel'], tank: ['Frozen Heart', "Randuin's Omen", 'Thornmail'] },
  armorCrit: { tank: ["Randuin's Omen"] },
  mr: { ap: ["Banshee's Veil"], adc: ['Maw of Malmortius', "Wit's End"], ad: ['Maw of Malmortius', "Wit's End"], tank: ['Force of Nature', 'Kaenic Rookern', 'Spirit Visage'] },
  shred: { ap: ['Void Staff', "Liandry's Torment"], adc: ["Lord Dominik's Regards", 'Blade of The Ruined King'], ad: ['Black Cleaver', "Serylda's Grudge"], tank: [] },
  shields: { adc: ["Serpent's Fang"], ad: ["Serpent's Fang"], ap: [], tank: [] },
  burst: { ap: ['Shadowflame', "Rabadon's Deathcap"], adc: ['Infinity Edge'], ad: [], tank: [] },
  crit: { adc: ['Infinity Edge'], ad: ['Infinity Edge'], ap: [], tank: [] }
};
const NEED_TAG = { armor: 'Armor', armorCrit: 'Armor', mr: 'SpellBlock' };

function analyze(g, { champ, players, myTeam, myItems, build, taken, itemInfo }) {
  const out = { suggestions: [], enemy: null, seen: [] };
  if (!g || !g.items) return out;
  const owned = new Set((myItems || []).map(i => String(i.itemID)));
  const byName = new Map();
  for (const [id, it] of Object.entries(g.items)) if (it && it.name && !byName.has(it.name) && it.gold && it.gold.purchasable !== false && (!it.maps || it.maps['12'] !== false)) byName.set(it.name, id);
  const cls = myClass(g, champ, build);
  const usual = [...((build && build.core && build.core.items) || []), ...((build && build.options) || []).flat()];
  const used = new Set();
  const add = (id, title, why) => {
    id = String(id);
    if (!id || used.has(id) || owned.has(id) || out.suggestions.length >= 5) return false;
    used.add(id); out.suggestions.push({ ...itemInfo(id), title, why }); return true;
  };
  const pick = (need, title, why) => {
    // Prefer something this champion already builds, then the class default.
    const tag = NEED_TAG[need];
    if (tag) { const u = usual.find(i => has(g.items[i.id], tag) && !owned.has(String(i.id)) && !used.has(String(i.id))); if (u && add(u.id, title, why)) return; }
    for (const n of (PICKS[need][cls] || [])) { const id = byName.get(n); if (id && add(id, title, why)) return; }
  };

  // 1. Augments already taken
  for (const a of taken || []) {
    for (const it of a.items || []) add(it.id, 'For your augment', `${a.name} needs it`);
    if (/critical strike/i.test(a.desc || '') && cls !== 'tank') pick('crit', 'For your augment', `${a.name} works with crit`);
  }

  // 2. The enemy team
  const enemies = (players || []).filter(p => p.team && p.team !== myTeam).map(p => profile(g, p));
  if (enemies.length) {
    const names = f => enemies.filter(f).map(e => e.name);
    const ap = names(e => e.magic), ad = names(e => e.physical), tanks = names(e => e.tank), heal = names(e => e.healer), shield = names(e => e.shielder), crit = names(e => e.crit);
    out.enemy = { ap: ap.length, ad: ad.length, tanks: tanks.length, healers: heal.length };
    const list = a => a.slice(0, 3).join(', ');
    if (heal.length >= 2) pick('antiheal', 'Cut their healing', `${list(heal)} heal a lot`);
    if (ap.length >= 3) pick('mr', 'Magic resist', `${ap.length} of ${enemies.length} enemies deal magic damage`);
    if (ad.length >= 3) pick(crit.length >= 2 && cls === 'tank' ? 'armorCrit' : 'armor', 'Armor', `${ad.length} of ${enemies.length} enemies deal physical damage`);
    if (tanks.length >= 2) pick('shred', 'Shred tanks', `${list(tanks)} stack resistances`);
    if (shield.length >= 2) pick('shields', 'Break shields', `${list(shield)} shield their team`);
    if (heal.length === 1 && out.suggestions.length < 3) pick('antiheal', 'Cut their healing', `${heal[0]} heals a lot`);
    if (tanks.length === 0 && out.suggestions.length < 3) pick('burst', 'More damage', 'No tanks on their team');
    // Augments other players show through a replaced summoner spell (the only ones League reveals).
    out.seen = (players || []).filter(p => p.spellAugments && p.spellAugments.length).map(p => ({ name: (p.champ && p.champ.name) || p.championName, enemy: p.team !== myTeam, augments: p.spellAugments }));
  }
  return out;
}

module.exports = { analyze, profile, myClass };
