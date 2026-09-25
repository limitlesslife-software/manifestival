// Julkaisujunan C–J kartta (docs/activation/release-train-c-j.json).
//
// Kartta generoidaan gitistä (tools/activation/train-map.mjs), joka lukee
// jokaisen aallon oman sw.js:n ja schema.js:n. Tämä testi ei tarvitse
// paikallisia ehdokashaaroja: se vartioi, että tallennettu kartta on
// sisäisesti johdonmukainen ja vastaa waves.mjs:n suunnitelmaa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { cacheVersionOf, cumulativeGates, WAVE_IDS } from '../tools/release/waves.mjs';
import { versionNumber } from '../tools/release/lineage.mjs';

const map = JSON.parse(read('docs/activation/release-train-c-j.json'));

test('kartta kattaa aallot C–J järjestyksessä', () => {
  assert.deepEqual(map.waves.map(w => w.wave), ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  for (const w of map.waves) assert.ok(WAVE_IDS.includes(w.wave));
});

test('KRIITTINEN: välimuistiversio nousee joka aallossa eikä törmää', () => {
  const versions = map.waves.map(w => versionNumber(w.cacheVersion));
  for (let i = 1; i < versions.length; i++) {
    assert.ok(versions[i] > versions[i - 1], `${map.waves[i].wave}: ${map.waves[i].cacheVersion} ei ole edellistä suurempi`);
  }
  assert.equal(new Set(versions).size, versions.length);
  for (const w of map.waves) assert.equal(w.cacheVersion, cacheVersionOf(w.wave), w.wave);
});

test('KRIITTINEN: jokaisen aallon porttimatriisi ratkeaa täsmälleen siihen aaltoon', () => {
  for (const w of map.waves) {
    assert.equal(w.gateMatrixResolvesTo, w.wave, `${w.wave}: matriisi ratkeaa aaltoon ${w.gateMatrixResolvesTo}`);
    assert.deepEqual(w.gatesCumulative, [...cumulativeGates(w.wave)]);
  }
});

test('KRIITTINEN: sarakeportit aukeavat vasta omassa aallossaan', () => {
  for (const w of map.waves) {
    for (const [gate, g] of Object.entries(w.columnGates)) {
      assert.equal(g.actual, g.expected, `${w.wave}: ${gate} on ${g.actual ? 'auki' : 'kiinni'}`);
    }
  }
});

test('KRIITTINEN: jokainen aalto on edellisen jälkeläinen (ei ohituksia)', () => {
  for (const w of map.waves.slice(1)) {
    assert.equal(w.descendsFromParent, true, `${w.wave} ei ole aallon ${w.parentWave} jälkeläinen`);
    assert.equal(w.rollbackTarget, w.parentWave);
  }
});

test('migraatioaalloilla on esitarkistus, varmistus ja aaltocommit', () => {
  for (const w of map.waves.filter(x => x.migration)) {
    assert.ok(read(w.preflight), `${w.wave}: ${w.preflight}`);
    assert.ok(read(w.verify), `${w.wave}: ${w.verify}`);
    assert.match(w.waveCommit || '', /^[0-9a-f]{40}$/, `${w.wave}: aaltocommit puuttuu`);
  }
  assert.deepEqual(map.waves.filter(x => x.migration).map(w => w.migration.slice(0, 4)),
    ['0009', '0010', '0011', '0012', '0013']);
});

test('kaikki kartan aallot on merkitty johdonmukaisiksi generoitaessa', () => {
  for (const w of map.waves) assert.equal(w.consistent, true, w.wave);
});
