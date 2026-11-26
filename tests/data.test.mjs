// Tests van het inlezen van FIS-brugdata en van de datacontrole vóór publicatie.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, assemble } from "../scripts/rws.mjs";
import { compareData, checkGolden } from "../scripts/check.mjs";

const P = [51.9, 4.5];

test("rivierbrug: onderkant NAP = doorvaarthoogte bij MHW + MHW", () => {
  const b = normalize({ heightclosed: 9.1, clearanceheightclosed: 5.9, mhwreferencelevel: "RIVER", mhwoffset: 3.2, name: "Rivierbrug" }, P, null, "bridge");
  assert.equal(b.mhw, 3.2);
  assert.equal(b.underNAP, 9.1);
  assert.equal(b.closed, 5.9);         // laagste van de twee als vaste waarde
});
test("brug met referentiepeil NAP: heightclosed is de onderkant t.o.v. NAP", () => {
  const b = normalize({ heightclosed: 4.5, heightopened: 30 }, P, { referencelevel: "NAP", name: "NAP-brug" }, "opening");
  assert.equal(b.underNAP, 4.5); assert.equal(b.openUnderNAP, 30); assert.equal(b.refName, "NAP");
});
test("brug met kanaalpeil: niet omrekenen", () => {
  const b = normalize({ heightclosed: 2.8, type: "VST" }, P, { referencelevel: "KP", name: "Kanaalbrug" }, "opening");
  assert.equal(b.underNAP, null); assert.equal(b.closed, 2.8); assert.equal(b.movable, 0);
});
test("hoogte in centimeters wordt meters", () => {
  const b = normalize({ heightclosed: 540 }, P, { referencelevel: "KP" }, "opening");
  assert.equal(b.closed, 5.4);
});
test("beweegbaar: type van de opening", () => {
  assert.equal(normalize({ heightclosed: 1.2, type: "BAS" }, P, { referencelevel: "KP" }, "opening").movable, 1);
});
test("opening koppelt aan de brug en neemt de naam over", () => {
  const out = assemble(
    [{ a: { id: 7, name: "Hoofdbrug", numberofopenings: 2, referencelevel: "KP" }, p: P }],
    [{ a: { bridgeid: 7, number: 1, heightclosed: 2, type: "VST" }, p: P }, { a: { bridgeid: 7, number: 2, heightclosed: 1.5, type: "BAS" }, p: P }],
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "Hoofdbrug · opening 1");
  assert.equal(out[1].movable, 1);
});

/* ---------- datacontrole ---------- */
const br = (n, h, extra = {}) => ({ id: n, name: `Brug ${n}`, lat: 52 + n / 1000, lng: 5, closed: h, ...extra });
const set = (arr, at) => ({ generatedAt: at, bridges: arr });

test("datacontrole: alles gelijk is in orde", () => {
  const a = Array.from({ length: 100 }, (_, i) => br(i, 3));
  const r = compareData({ prev: { bridges: set(a, "1") }, next: { bridges: set(a, "2") } });
  assert.deepEqual(r.issues, []); assert.deepEqual(r.restore, []);
});
test("datacontrole: veel minder bruggen → vorige versie terug", () => {
  const a = Array.from({ length: 100 }, (_, i) => br(i, 3));
  const r = compareData({ prev: { bridges: set(a, "1") }, next: { bridges: set(a.slice(0, 80), "2") } });
  assert.deepEqual(r.restore, ["bridges"]);
});
test("datacontrole: veel hoogtes ineens anders → vorige versie terug", () => {
  const a = Array.from({ length: 1000 }, (_, i) => br(i, 3));
  const b = a.map((x, i) => (i < 30 ? { ...x, closed: 4 } : x));
  assert.deepEqual(compareData({ prev: { bridges: set(a, "1") }, next: { bridges: set(b, "2") } }).restore, ["bridges"]);
  const c = a.map((x, i) => (i < 5 ? { ...x, closed: 4 } : x));      // enkele correcties in de bron: prima
  const r = compareData({ prev: { bridges: set(a, "1") }, next: { bridges: set(c, "2") } });
  assert.deepEqual(r.restore, []); assert.equal(r.notes.length, 1);
});
test("datacontrole: onmogelijke waterstand wordt weggelaten", () => {
  const r = compareData({ next: { water: { stations: [{ code: "x", cm: 9999 }, { code: "y", cm: 120 }] } } });
  assert.deepEqual(r.waterFix, ["x"]);
});
test("testset bekende bruggen", () => {
  const bridges = [br(1, 3.2, { underNAP: 7.4 })];
  const golden = { bruggen: [
    { naam: "Brug 1", lat: 52.001, lng: 5, veld: "underNAP", verwacht: 7.4 },
    { naam: "Brug 1", lat: 52.001, lng: 5, veld: "closed", verwacht: 3.0, marge: 0.05 },
    { naam: "Bestaat niet", lat: 52, lng: 5, verwacht: 1 },
    { naam: "Uit", lat: 52, lng: 5, verwacht: 1, actief: false },
  ] };
  const r = checkGolden(bridges, golden);
  assert.deepEqual(r.map((x) => x.ok), [true, false, false]);
  // Afwijking in de testset: vorige versie terug als die de testset wél haalde.
  const prevB = [br(1, 3.0, { underNAP: 7.4 })];
  const g2 = { bruggen: [{ naam: "Brug 1", lat: 52.001, lng: 5, veld: "closed", verwacht: 3.0 }] };
  assert.deepEqual(compareData({ prev: { bridges: set(prevB, "1") }, next: { bridges: set(bridges, "2") }, golden: g2 }).restore, ["bridges"]);
});
