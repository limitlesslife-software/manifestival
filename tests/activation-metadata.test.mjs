// Aaltojen aktivointimetatiedot (ACT-12): yksi lähde, ja dokumentti vastaa sitä.
//
// Migraatio, riski, omistajan portit, varmuuskopiopakko ja verify-edellytys
// olivat ennen vain proosaa GO/NO-GO-dokumentissa, ja migraatio -> aalto
// -kartta oli kopioitu käsin kolmeen työkaluun. Nyt ne ovat
// tools/release/waves.mjs:n kentissä, ja tämä testi vartioi, että
// dokumentti ja työkalut eivät erkane niistä.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  DB_FLOOR, MIGRATION_WAVE, RISK_LABEL_FI, TRAIN_FLOOR_WAVE, TRAIN_MIGRATIONS, WAVES,
  classifyDeployedState, expectedMatrix, nextWaveId, previousWaveId, schemaWaveOfMigration, waveById
} from '../tools/release/waves.mjs';
import { goNoGoTableRows } from '../tools/activation/push-lines.mjs';

const GO_NOGO = 'docs/SUUNTA-ACTIVATION-GO-NOGO.md';

test('KRIITTINEN: jokaisella aallolla on aktivointimetatiedot', () => {
  for (const wave of WAVES) {
    for (const field of ['migration', 'migrationFile', 'risk', 'ownerGates', 'backupRequired', 'verifyPrerequisite']) {
      assert.ok(field in wave, `${wave.id}.${field} puuttuu`);
    }
    assert.ok(['low', 'medium', 'high'].includes(wave.risk), `${wave.id}.risk = ${wave.risk}`);
    assert.ok(wave.ownerGates.includes('OWNER_DEPLOY_APPROVAL_REQUIRED'), `${wave.id}: deployhyväksyntä puuttuu`);
  }
});

test('KRIITTINEN: migraatiot 0009–0013 kuuluvat aalloille F–J järjestyksessä ja tiedostot ovat olemassa', () => {
  assert.deepEqual(TRAIN_MIGRATIONS, ['0009', '0010', '0011', '0012', '0013']);
  assert.deepEqual(MIGRATION_WAVE, { '0009': 'F', '0010': 'G', '0011': 'H', '0012': 'I', '0013': 'J' });
  for (const wave of WAVES.filter(w => w.migration)) {
    assert.ok(fs.existsSync(path.join(ROOT, wave.migrationFile)), wave.migrationFile);
    assert.ok(wave.migrationFile.includes(`/${wave.migration}_`), wave.migrationFile);
    assert.ok(wave.blockedBy.startsWith(wave.migrationFile), `${wave.id}.blockedBy ei nimeä migraatiota ${wave.migrationFile}`);
    assert.ok(wave.ownerGates.includes('OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED'), wave.id);
  }
  for (const wave of WAVES.filter(w => !w.migration)) assert.equal(wave.migrationFile, null, wave.id);
});

test('varmuuskopio vain 0010:lle, verify_0012 vain 0013:n edellytys, puhelinhyväksyntä vain J:lle', () => {
  assert.deepEqual(WAVES.filter(w => w.backupRequired).map(w => w.id), ['G']);
  assert.deepEqual(WAVES.filter(w => w.verifyPrerequisite).map(w => [w.id, w.verifyPrerequisite]), [['J', '0012']]);
  assert.deepEqual(WAVES.filter(w => w.ownerGates.includes('PHONE_ACCEPTANCE_REQUIRED')).map(w => w.id), ['J']);
});

test('KRIITTINEN: GO/NO-GO-taulukko vastaa metatietoja (migraatio, riski, varmuuskopio)', () => {
  const rows = goNoGoTableRows(read(GO_NOGO));
  for (const id of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    const wave = waveById(id);
    const row = rows[id];
    assert.ok(row, `taulukosta puuttuu aalto ${id}`);
    assert.equal(row.cacheVersion, wave.cacheVersion, id);
    assert.equal(row.migration, wave.migration, `${id}: taulukon migraatio ${row.migration}`);
    assert.equal(row.risk.toLowerCase(), RISK_LABEL_FI[wave.risk].toLowerCase(), `${id}: taulukon riski ${row.risk}`);
    assert.equal(/varmuuskopio/i.test(row.owner), Boolean(wave.backupRequired), `${id}: varmuuskopio`);
  }
});

test('jokainen omistajan porttiluokka on GO/NO-GO:n esteluettelossa', () => {
  const doc = read(GO_NOGO);
  for (const gate of new Set(WAVES.flatMap(w => w.ownerGates))) {
    assert.ok(doc.includes(`| ${gate} |`), `${gate} puuttuu esteluettelosta`);
  }
});

test('KRIITTINEN: työkalut eivät kopioi migraatio -> aalto -karttaa käsin', () => {
  for (const file of ['tools/activation/score-inventory.mjs', 'tools/activation/build-preflights.mjs',
    'tools/activation/train-map.mjs', 'tools/activation/orchestrate.mjs']) {
    const code = read(file);
    assert.equal(/'0009'\s*:\s*'F'/.test(code), false, `${file} kopioi kartan`);
    assert.match(code, /from '\.\.\/release\/waves\.mjs'/, `${file} ei lue aaltoja waves.mjs:stä`);
  }
});

test('apufunktiot: kanta -> aalto, naapurit, junan lattia', () => {
  assert.equal(schemaWaveOfMigration('0008'), 'E');
  assert.equal(schemaWaveOfMigration('0013'), 'J');
  assert.equal(schemaWaveOfMigration('0007'), null);
  assert.equal(DB_FLOOR.wave, 'E');
  assert.equal(TRAIN_FLOOR_WAVE, 'C');
  assert.equal(nextWaveId('C'), 'D');
  assert.equal(nextWaveId('J'), null);
  assert.equal(previousWaveId('A'), 'BASE');
  assert.equal(previousWaveId('F'), 'E');
});

test('KRIITTINEN: deploytila: aalto, peruutus (ROLLBACK) ja epäjohdonmukainen erotetaan', () => {
  assert.equal(classifyDeployedState({ gates: expectedMatrix('C'), cacheVersion: 'v16' }).label, 'C');
  const rollback = classifyDeployedState({ gates: expectedMatrix('C'), cacheVersion: 'v18' });
  assert.equal(rollback.state, 'ROLLBACK');
  assert.equal(rollback.rollbackOf, 'D');
  assert.equal(classifyDeployedState({ gates: expectedMatrix('D'), cacheVersion: 'v16' }).state, 'INCONSISTENT');
  assert.equal(classifyDeployedState({ gates: null, cacheVersion: 'v16' }).state, 'INCONSISTENT');
  assert.equal(classifyDeployedState({ gates: expectedMatrix('C'), cacheVersion: null }).state, 'INCONSISTENT');
});
