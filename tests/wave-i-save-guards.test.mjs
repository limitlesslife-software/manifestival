// Aalto I v2: Suunnan tallennuspainikkeet ovat kertalukittuja.
//
// Aallon I v1 (Suunta 1) kirjauslomakkeessa ei ollut tuplaklikkaussuojaa:
// kaksi nopeaa napautusta tallensi kaksi aikakirjausta. Tuotehaaran Day 1
// -korjaus toi suojan myöhempään koodiin; tämä testi vartioi samaa aallon I
// koodissa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';

test('Suunnan tallennuspainikkeet kulkevat guardedSave-lukon kautta', () => {
  const src = read('src/app/views/direction.js').replace(/\r\n/g, '\n');
  for (const id of ['dirTimeSave', 'dirCapacitySave', 'dirAreaSave', 'dirReviewSave']) {
    assert.match(src, new RegExp(`el\\('${id}'\\)\\.addEventListener\\('click', guardedSave\\('${id}'`), id);
  }
});

test('guardedSave ei käynnistä toista tallennusta ennen kuin ensimmäinen on valmis', async () => {
  const { singleFlight } = await import('../src/ui/dom.js');
  let calls = 0;
  let release;
  const save = singleFlight(async () => { calls += 1; await new Promise(r => { release = r; }); });
  const first = save();
  const second = save();
  assert.equal(calls, 1, 'toinen napautus ohitetaan');
  release();
  await first; await second;
  save();
  assert.equal(calls, 2, 'valmistumisen jälkeen tallennus toimii taas');
  release();
});
