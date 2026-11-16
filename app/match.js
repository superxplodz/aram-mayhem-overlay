// Turns recognised screen text into "these augments are being offered".
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
const similarity = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

// lines: [{ t, x, y, w, h }]   candidates: [{ id, name, ... }]
// Returns the matched candidates that sit in one row (the card titles), left to right, or [].
function matchOffer(lines, candidates, { minSim = 0.82, minGroup = 2 } = {}) {
  const cands = candidates.map(c => ({ c, n: norm(c.name) })).filter(x => x.n.length >= 3);
  const texts = lines.filter(l => l && l.t).map(l => ({ ...l, n: norm(l.t) }));

  // Long titles can wrap onto two lines: also try each line joined with the one right below it.
  const joined = [];
  for (const a of texts) {
    let best = null;
    for (const b of texts) {
      if (b === a) continue;
      const gap = b.y - (a.y + a.h);
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (gap >= -a.h * 0.3 && gap < a.h * 1.8 && overlap > 0 && (!best || b.y < best.y)) best = b;
    }
    if (best) {
      const x = Math.min(a.x, best.x), y = a.y;
      joined.push({ t: a.t + ' ' + best.t, n: a.n + best.n, x, y, w: Math.max(a.x + a.w, best.x + best.w) - x, h: best.y + best.h - y });
    }
  }

  const found = new Map(); // id -> { c, sim, box }
  for (const l of [...texts, ...joined]) {
    if (l.n.length < 3) continue;
    for (const { c, n } of cands) {
      if (Math.abs(l.n.length - n.length) > Math.max(1, n.length * 0.3)) continue;
      const need = n.length <= 5 ? Math.max(minSim, 0.99) : minSim; // short names must match exactly
      const sim = similarity(l.n, n);
      if (sim < need) continue;
      const prev = found.get(c.id);
      if (!prev || sim > prev.sim) found.set(c.id, { ...c, sim, box: { x: l.x, y: l.y, w: l.w, h: l.h } });
    }
  }
  const hits = [...found.values()];
  if (!hits.length) return [];

  // Card titles share one horizontal row. Keep the biggest group of hits at a similar height.
  let group = [];
  for (const a of hits) {
    const tol = Math.max(a.box.h * 2.5, 30);
    const g = hits.filter(b => Math.abs(b.box.y - a.box.y) <= tol);
    if (g.length > group.length) group = g;
  }
  if (group.length < minGroup) return [];
  return group.sort((a, b) => a.box.x - b.box.x).slice(0, 6);
}

module.exports = { matchOffer, norm, similarity };
