// Routeplanner over het vaarwegennetwerk van Rijkswaterstaat (FIS-vaarwegvakken).
// Puur rekenwerk, zonder kaart: ook gebruikt door de tests.
//
// Netwerk in:  { sections: { id: { s, e, path: [[lat,lng],...] } } }           (data/network.json → .network)
//         of:  { v: 1, sections: [[id, s, e, km, [[lat,lng],...]], ...] }       (data/route-net.json, compact)

const KX = 111.32 * Math.cos((52 * Math.PI) / 180), KY = 110.57;   // km per graad (vlakke benadering NL)

function cumLen(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot((path[i][1] - path[i - 1][1]) * KX, (path[i][0] - path[i - 1][0]) * KY));
  return cum;
}
function segDist(p, a, b) {
  const ax = a[1] * KX, ay = a[0] * KY, bx = b[1] * KX, by = b[0] * KY, px = p[1] * KX, py = p[0] * KY;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}
// Positie f (0..1) van punt p langs een vak, en de afstand (km) tot het vak.
export function snapToSection(sec, p) {
  const path = sec.path, cum = sec.cum;
  if (!path || path.length < 2) return null;
  let best = { d: Infinity, f: 0 };
  for (let i = 1; i < path.length; i++) {
    const r = segDist(p, path[i - 1], path[i]);
    if (r.d < best.d) best = { d: r.d, f: sec.km ? (cum[i - 1] + r.t * (cum[i] - cum[i - 1])) / sec.km : 0 };
  }
  return best;
}
// Deel van een vak tussen f0 en f1 (ook achteruit), als lijst punten.
export function subPath(sec, f0, f1) {
  const { path, cum, km } = sec;
  const at = (f) => {
    const want = f * km;
    for (let i = 1; i < path.length; i++) if (cum[i] >= want) {
      const t = cum[i] > cum[i - 1] ? (want - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
      return { i, p: [path[i - 1][0] + t * (path[i][0] - path[i - 1][0]), path[i - 1][1] + t * (path[i][1] - path[i - 1][1])] };
    }
    return { i: path.length - 1, p: path[path.length - 1] };
  };
  const lo = Math.min(f0, f1), hi = Math.max(f0, f1), a = at(lo), b = at(hi);
  const pts = [a.p, ...path.slice(a.i, b.i), b.p];
  return f0 <= f1 ? pts : pts.reverse();
}

class Heap {
  constructor() { this.h = []; }
  get size() { return this.h.length; }
  push(x) { const h = this.h; h.push(x); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } }
  pop() { const h = this.h, top = h[0], last = h.pop(); if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } } return top; }
}

// Bouwt de graaf: vakken (met lengte uit de geometrie), knooppunten en een ruimtelijke index.
export function makeGraph(net) {
  const S = new Map();
  const add = (id, s, e, path) => {
    if (id == null || s == null || e == null || !path || path.length < 2) return;
    const cum = cumLen(path);
    S.set(String(id), { id: String(id), s: String(s), e: String(e), path, cum, km: cum[cum.length - 1] });
  };
  if (Array.isArray(net?.sections)) for (const [id, s, e, , path] of net.sections) add(id, s, e, path);
  else for (const [id, x] of Object.entries(net?.sections || {})) add(id, x.s, x.e, x.path);
  const adj = new Map();
  for (const sec of S.values()) { for (const j of [sec.s, sec.e]) (adj.get(j) || adj.set(j, []).get(j)).push(sec.id); }
  const cell = 0.05, grid = new Map(), key = (la, lo) => `${Math.floor(la / cell)}|${Math.floor(lo / cell)}`;
  for (const sec of S.values()) {
    const seen = new Set();
    for (let i = 0; i < sec.path.length; i++) {
      // ook tussenpunten op lange rechte stukken indexeren
      const p = sec.path[i], q = sec.path[i + 1];
      const steps = q ? Math.max(1, Math.ceil(Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])) / cell)) : 1;
      for (let k = 0; k < steps; k++) {
        const la = q ? p[0] + ((q[0] - p[0]) * k) / steps : p[0], lo = q ? p[1] + ((q[1] - p[1]) * k) / steps : p[1];
        const kk = key(la, lo);
        if (!seen.has(kk)) { seen.add(kk); (grid.get(kk) || grid.set(kk, []).get(kk)).push(sec.id); }
      }
    }
  }
  return { S, adj, grid, cell, key };
}

// Dichtstbijzijnde vak bij een punt (binnen maxKm).
export function snap(g, p, maxKm = 2) {
  const ring = Math.max(1, Math.ceil(maxKm / (g.cell * KY)));
  const gy = Math.floor(p[0] / g.cell), gx = Math.floor(p[1] / g.cell);
  let best = null;
  const seen = new Set();
  for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
    for (const id of g.grid.get(`${gy + dy}|${gx + dx}`) || []) {
      if (seen.has(id)) continue; seen.add(id);
      const r = snapToSection(g.S.get(id), p);
      if (r && (!best || r.d < best.d)) best = { id, ...r };
    }
  }
  return best && best.d <= maxKm ? best : null;
}

// Kortste route over het water van punt A naar punt B.
// Uitkomst: { km, legs: [{ id, f0, f1, km, off }], path: [[lat,lng],...] } of null.
export function findRoute(g, A, B, { maxSnapKm = 2 } = {}) {
  const a = snap(g, A, maxSnapKm), b = snap(g, B, maxSnapKm);
  if (!a || !b) return { error: !a ? "start" : "eind" };
  const SA = g.S.get(a.id), SB = g.S.get(b.id);
  let best = null;
  if (a.id === b.id) best = { d: Math.abs(b.f - a.f) * SA.km, direct: true };
  const dist = new Map(), prev = new Map(), pq = new Heap();
  const push = (j, d, from) => { if (!dist.has(j) || d < dist.get(j)) { dist.set(j, d); prev.set(j, from); pq.push([d, j]); } };
  push(SA.s, a.f * SA.km, { start: 0 });
  push(SA.e, (1 - a.f) * SA.km, { start: 1 });
  const endAt = new Map([[SB.s, b.f * SB.km], [SB.e, (1 - b.f) * SB.km]]);
  while (pq.size) {
    const [d, j] = pq.pop();
    if (d > dist.get(j)) continue;
    if (best && d >= best.d) break;
    if (endAt.has(j)) { const tot = d + endAt.get(j); if (!best || tot < best.d) best = { d: tot, j }; }
    for (const id of g.adj.get(j) || []) {
      const sec = g.S.get(id), nxt = sec.s === j ? sec.e : sec.s;
      push(nxt, d + sec.km, { j, id });
    }
  }
  if (!best) return { error: "geen" };
  // Route opbouwen
  const legs = [];
  if (best.direct) legs.push({ id: a.id, f0: a.f, f1: b.f });
  else {
    const mid = [];
    let j = best.j;
    for (;;) { const p = prev.get(j); if (!p || p.start != null) { legs.push({ id: a.id, f0: a.f, f1: p ? p.start : 0 }); break; } const sec = g.S.get(p.id); mid.push({ id: p.id, f0: sec.s === p.j ? 0 : 1, f1: sec.s === p.j ? 1 : 0 }); j = p.j; }
    legs.push(...mid.reverse());
    legs.push({ id: b.id, f0: SB.s === best.j ? 0 : 1, f1: b.f });
  }
  let off = 0;
  const path = [];
  for (const l of legs) {
    const sec = g.S.get(l.id);
    l.km = Math.abs(l.f1 - l.f0) * sec.km; l.off = off; off += l.km;
    const sp = subPath(sec, l.f0, l.f1);
    if (path.length) sp.shift();
    path.push(...sp);
  }
  return { km: off, legs: legs.filter((l) => l.km > 0 || legs.length === 1), path, from: a, to: b };
}

// Positie van objecten (bruggen, sluizen) op het netwerk: eigen vak als dat bekend is, anders het dichtstbijzijnde vak.
// items: [{ lat, lng, sec? }] · uitkomst: per item { id, f } of null
export function placeOnNetwork(g, items, { maxKm = 0.15 } = {}) {
  return items.map((it) => {
    const own = it.sec != null ? g.S.get(String(it.sec)) : null;
    if (own) { const r = snapToSection(own, [it.lat, it.lng]); if (r && r.d <= 1) return { id: own.id, f: r.f }; }
    const r = snap(g, [it.lat, it.lng], maxKm);
    return r ? { id: r.id, f: r.f } : null;
  });
}

// Objecten langs de route met hun afstand vanaf de start (km), op volgorde.
// placed: uitkomst van placeOnNetwork voor dezelfde items.
export function alongRoute(route, items, placed, tolF = 0.002) {
  const byId = new Map();
  for (const l of route.legs) (byId.get(l.id) || byId.set(l.id, []).get(l.id)).push(l);
  const out = [];
  items.forEach((it, i) => {
    const p = placed[i]; if (!p) return;
    for (const l of byId.get(p.id) || []) {
      const lo = Math.min(l.f0, l.f1) - tolF, hi = Math.max(l.f0, l.f1) + tolF;
      if (p.f >= lo && p.f <= hi) { out.push({ item: it, km: l.off + (l.km ? (Math.abs(p.f - l.f0) / Math.abs(l.f1 - l.f0 || 1)) * l.km : 0) }); break; }
    }
  });
  return out.sort((x, y) => x.km - y.km);
}
