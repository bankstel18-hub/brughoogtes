// Tests van de rekenregels in de app. Draaien: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearanceFor, openClearance, verdict, pickLevel, interp, interpPts, chamberCheck, lockVerdict, contactInfo, fmt, esc } from "../public/js/core.js";

test("doorvaarthoogte: onderkant t.o.v. NAP min waterstand", () => {
  // Brug met onderkant op NAP +7,40 m, water op NAP +1,25 m → 6,15 m
  assert.equal(clearanceFor({ underNAP: 7.4 }, 125), 6.15);
  // Water onder NAP: hoogte neemt toe
  assert.equal(clearanceFor({ underNAP: 7.4 }, -80), 8.2);
});
test("doorvaarthoogte: hoogte t.o.v. referentiepeil met bekend referentiepeil in NAP", () => {
  // 5,00 m t.o.v. een peil van NAP -0,40 m; water NAP -0,10 m → 30 cm hoger water → 4,70 m
  assert.equal(clearanceFor({ closed: 5, refNAP: -0.4 }, -10), 4.7);
});
test("doorvaarthoogte: niet omrekenen zonder NAP-referentie", () => {
  assert.equal(clearanceFor({ closed: 5, refName: "KP" }, 20), null);
  assert.equal(clearanceFor({ underNAP: 7 }, null), null);
});
test("open stand volgt de correctie van de gesloten stand", () => {
  assert.equal(openClearance({ open: 12, closed: 4 }, 3.5, 50), 11.5);
  assert.equal(openClearance({ open: 12, openUnderNAP: 13, closed: 4 }, 3.5, 50), 12.5);
  assert.equal(openClearance({ open: 12, closed: 4 }, null, 50), 12);
  assert.equal(openClearance({ closed: 4 }, 3.5, 50), null);
});
test("oordeel per brug", () => {
  assert.equal(verdict(3.0, null, 0, 2.6), "ok");
  assert.equal(verdict(2.5, null, 0, 2.6), "bad");
  assert.equal(verdict(2.5, null, 1, 2.6), "wait");    // beweegbaar, open hoogte onbekend
  assert.equal(verdict(2.5, 30, 1, 2.6), "wait");
  assert.equal(verdict(2.5, 2.55, 1, 2.6), "bad");     // ook open te laag (bijv. hefbrug)
  assert.equal(verdict(null, null, 0, 2.6), "unk");
  assert.equal(verdict(2.6, null, 0, 2.6), "ok");      // precies passend telt als passen (marge zit in need)
});

test("waterstand kiezen: verse meting voor nu", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const meas = { cm: 50, t: "2026-11-26T11:50:00Z" };
  const fc = { kind: "verwachting", pts: [[now / 1000 - 3600, 40], [now / 1000 + 3600, 80]] };
  assert.deepEqual(pickLevel(meas, fc, 0, now), { cm: 50, t: meas.t, kind: "meting" });
});
test("waterstand kiezen: meting ouder dan 30 min → verwachting voor nu", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const meas = { cm: 50, t: "2026-11-26T11:00:00Z" };
  const fc = { kind: "verwachting", pts: [[now / 1000 - 3600, 40], [now / 1000 + 3600, 80]] };
  const r = pickLevel(meas, fc, 0, now);
  assert.equal(r.kind, "verwachting"); assert.equal(r.cm, 60);
});
test("waterstand kiezen: zonder verwachting meting tot 3 uur oud, daarna niets", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  assert.equal(pickLevel({ cm: 50, t: "2026-11-26T10:00:00Z" }, null, 0, now).cm, 50);
  assert.equal(pickLevel({ cm: 50, t: "2026-11-26T08:30:00Z" }, null, 0, now), null);
});
test("waterstand kiezen: vooruit altijd de verwachting, nooit de meting", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const fc = { kind: "astronomisch", pts: [[now / 1000, 0], [now / 1000 + 7200, 100]] };
  const r = pickLevel({ cm: 50, t: "2026-11-26T11:55:00Z" }, fc, 1, now);
  assert.equal(r.kind, "astronomisch"); assert.equal(r.cm, 50);
  assert.equal(pickLevel({ cm: 50, t: "2026-11-26T11:55:00Z" }, null, 1, now), null);
});

test("interpoleren", () => {
  const pts = [[0, 0], [100, 100]];
  assert.equal(interp(pts, 50), 50);
  assert.equal(interp(pts, 100 + 3601), null);
  assert.equal(interpPts([[0, 0], [10000, 100]], 5000, 3600), null);   // gat te groot
  assert.equal(interpPts([[0, 0], [3000, 30]], 1500), 15);
});

test("sluiskolk: lengte, breedte, diepgang en hoogte", () => {
  const c = { length: 40, width: 6, sill: 2.5, height: 5 };
  assert.equal(chamberCheck(c, { L: 20, B: 4, T: 1.5 }, 3).s, "ok");
  assert.deepEqual(chamberCheck(c, { L: 45, B: 4, T: 1.5 }, 3).why, ["te lang (40,0 m)"]);
  assert.equal(chamberCheck(c, { L: 20, B: 4, T: 2.45 }, 3).s, "bad");   // 2,45 + 0,10 kiel > 2,50
  assert.equal(chamberCheck(c, { L: 20, B: 4, T: 1 }, 5.5).s, "bad");
  assert.equal(chamberCheck({}, { L: 1, B: 1, T: 1 }, 1).s, "unk");
  assert.equal(lockVerdict([{ length: 10, width: 3 }, c], { L: 20, B: 4, T: 1.5 }, 3), "ok");   // één kolk past
  assert.equal(lockVerdict([], { L: 1, B: 1, T: 1 }, 1), "unk");
});

test("contactgegevens uit FIS-velden", () => {
  assert.deepEqual(contactInfo({ phonenumber: "010-1234567", vhfchannel: "20" }), { phone: "010-1234567", vhf: "20" });
  assert.deepEqual(contactInfo({ phonenumber: "-", vhf: "kanaal onbekend" }), {});
});

test("opmaak", () => {
  assert.equal(fmt(null), "?"); assert.equal(fmt(95), "∞"); assert.equal(fmt(3.456), "3.46");
  assert.equal(esc(`<a href="x">'`), "&lt;a href=&quot;x&quot;&gt;&#39;");
});
