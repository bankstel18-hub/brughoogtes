// Compact vaarwegennetwerk voor de routecheck in de app (data/route-net.json).
// network.json bevat elk vaarwegvak met alle punten; voor de routeplanner volstaat een vereenvoudigde lijn.

const KX = 111.32 * Math.cos((52 * Math.PI) / 180), KY = 110.57;

// Douglas-Peucker: punten weglaten die minder dan tolKm van de lijn afwijken.
export function simplify(path, tolKm = 0.01) {
  if (path.length <= 2) return path.slice();
  const keep = new Uint8Array(path.length); keep[0] = keep[path.length - 1] = 1;
  const stack = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = path[a][1] * KX, ay = path[a][0] * KY, bx = path[b][1] * KX, by = path[b][0] * KY;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = path[i][1] * KX, py = path[i][0] * KY;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > md) { md = d; mi = i; }
    }
    if (md > tolKm) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return path.filter((_, i) => keep[i]);
}

export function buildRouteNet(network, generatedAt) {
  const sections = [];
  for (const [id, s] of Object.entries(network?.sections || {})) {
    if (!s.path || s.path.length < 2) continue;
    let km = 0;
    for (let i = 1; i < s.path.length; i++) km += Math.hypot((s.path[i][1] - s.path[i - 1][1]) * KX, (s.path[i][0] - s.path[i - 1][0]) * KY);
    sections.push([isNaN(+id) ? id : +id, s.s, s.e, +km.toFixed(3), simplify(s.path).map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)])]);
  }
  return { v: 1, generatedAt, source: "Rijkswaterstaat FIS vaarwegvakken (CC-0), vereenvoudigd", sections };
}
