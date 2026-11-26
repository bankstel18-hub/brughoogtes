// Tests van de routeplanner op een klein kunstmatig netwerk.
//
//   J1 ──A── J2 ──B── J3
//            │        │
//            C        D (lang, omweg)
//            │        │
//            J4 ──E── J5
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGraph, findRoute, placeOnNetwork, alongRoute, snap } from "../public/js/route.js";
import { buildRouteNet, simplify } from "../scripts/routenet.mjs";

const net = { sections: {
  A: { s: "J1", e: "J2", path: [[52.0, 5.00], [52.0, 5.05]] },
  B: { s: "J2", e: "J3", path: [[52.0, 5.05], [52.0, 5.10]] },
  C: { s: "J2", e: "J4", path: [[52.0, 5.05], [51.95, 5.05]] },
  D: { s: "J3", e: "J5", path: [[52.0, 5.10], [52.02, 5.12], [51.95, 5.15], [51.95, 5.10]] },
  E: { s: "J4", e: "J5", path: [[51.95, 5.05], [51.95, 5.10]] },
} };
const g = makeGraph(net);

test("vak vinden bij een punt", () => {
  assert.equal(snap(g, [52.001, 5.02]).id, "A");
  assert.equal(snap(g, [52.3, 5.02], 2), null);     // te ver van het water
});
test("route op hetzelfde vak", () => {
  const r = findRoute(g, [52.0, 5.01], [52.0, 5.04]);
  assert.equal(r.legs.length, 1); assert.equal(r.legs[0].id, "A");
  assert.ok(Math.abs(r.km - 0.03 * 111.32 * Math.cos((52 * Math.PI) / 180)) < 0.05);
});
test("kortste route over meerdere vakken, niet de omweg", () => {
  // Van A naar E: via C (kort), niet via B en D.
  const r = findRoute(g, [52.0, 5.01], [51.95, 5.08]);
  assert.deepEqual(r.legs.map((l) => l.id), ["A", "C", "E"]);
  assert.equal(r.path[0][1].toFixed(3), "5.010");
  assert.equal(r.path[r.path.length - 1][1].toFixed(3), "5.080");
});
test("bruggen en sluizen langs de route, op volgorde", () => {
  const items = [
    { name: "op E", lat: 51.95, lng: 5.07 },
    { name: "op A", lat: 52.0, lng: 5.03, sec: "A" },
    { name: "op B (niet op route)", lat: 52.0, lng: 5.08 },
    { name: "op A vóór de start", lat: 52.0, lng: 5.005 },
  ];
  const r = findRoute(g, [52.0, 5.01], [51.95, 5.08]);
  const along = alongRoute(r, items, placeOnNetwork(g, items));
  assert.deepEqual(along.map((x) => x.item.name), ["op A", "op E"]);
  assert.ok(along[0].km < along[1].km);
});
test("geen route als start niet bij het water ligt", () => {
  assert.equal(findRoute(g, [53, 6], [52.0, 5.02]).error, "start");
});
test("compact routenetwerk geeft dezelfde route", () => {
  const rn = buildRouteNet(net, "x");
  assert.equal(rn.sections.length, 5);
  const r = findRoute(makeGraph(rn), [52.0, 5.01], [51.95, 5.08]);
  assert.deepEqual(r.legs.map((l) => l.id), ["A", "C", "E"]);
});
test("vereenvoudigen laat rechte lijn over, houdt bochten", () => {
  assert.equal(simplify([[52, 5], [52, 5.01], [52, 5.02]]).length, 2);
  assert.equal(simplify([[52, 5], [52.01, 5.01], [52, 5.02]]).length, 3);
});
