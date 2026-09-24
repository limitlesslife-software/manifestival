// Jäädytetyn kellon apuri: "tänään" pysyy annettuna päivänä vuodesta ja
// kesäajasta riippumatta, ja kello palautuu testin jälkeen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { freezeLocalDate } from './helpers/clock.mjs';
import { fmtISO, todayMidnight } from '../src/lib/datetime.js';

for (const day of ['2027-01-04', '2030-12-31', '2026-03-29', '2026-10-25', '2028-02-29']) {
  test(`jäädytetty päivä ${day} näkyy sovelluksen "tänään"-arvona`, (t) => {
    freezeLocalDate(t, day);
    assert.equal(fmtISO(todayMidnight()), day);
    assert.equal(fmtISO(new Date()), day);
  });
}

test('jäädytys ei vuoda seuraavaan testiin', () => {
  // Edellinen testi jäädytti vuoteen 2028; oikea kello on eri hetki.
  assert.notEqual(fmtISO(new Date()), '2028-02-29');
});

test('virheellinen päivä hylätään eikä jäädytä mitään', (t) => {
  assert.throws(() => freezeLocalDate(t, 'huomenna'));
});
